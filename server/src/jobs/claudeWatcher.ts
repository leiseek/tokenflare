/**
 * Background job: watch Claude Code session transcripts and reconstruct state.
 *
 * Claude was tracked through `~/.claude/settings.json` hooks and nothing else,
 * which left it strictly less resilient than Codex: if the hooks are not
 * registered, are registered against a different server URL, or the surface
 * running Claude Code does not dispatch them, the session is simply invisible
 * and there is no fallback. Codex has had a transcript watcher for exactly this
 * reason; this is its counterpart.
 *
 * Claude Code writes one JSONL per session under
 * `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` regardless of surface,
 * so tailing those recovers the same state the hooks would have reported.
 *
 * The two watchers share `transcriptParse.ts`, so what counts as user-visible
 * assistant text can never drift between providers: plain `text` blocks only,
 * never `tool_use`, never `thinking`.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseTranscriptWindow } from "../hooks/transcriptParse.js";
import type { Store } from "../state/store.js";
import type { Provider, TaskStatus } from "../state/types.js";

export interface ClaudeWatchCtx {
  store: Store;
  /** Root of the Claude config dir (contains projects/). Default: ~/.claude. */
  claudeHome?: string;
  /** Poll interval ms (default 3000). */
  intervalMs?: number;
  log?: (msg: string) => void;
  /** Injected clock for tests. */
  now?: () => number;
}

const PROVIDER: Exclude<Provider, "manual"> = "claude";
/** Trailing bytes to read on first sight, enough to catch the current turn. */
const FIRST_SIGHT_TAIL_BYTES = 512 * 1024;
/** Files untouched for longer than this are history: cursor parked, never read. */
const FIRST_SIGHT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A file modified within this window belongs to a session worth surfacing. */
const LIVE_WINDOW_MS = 15 * 60 * 1000;
/** Session-id UUID embedded in the transcript filename. */
const FILENAME_UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

interface FileCursor {
  path: string;
  offset: number;
  sessionId?: string;
  cwd?: string;
}

/** Cursors live for the process, not the tick. */
const cursors = new Map<string, FileCursor>();
let timer: NodeJS.Timeout | null = null;

/** Resolve the Claude projects dir (~/.claude/projects by default). */
function projectsDir(claudeHome?: string): string {
  const home = claudeHome || process.env.TOKENFLARE_CLAUDE_HOME || path.join(os.homedir(), ".claude");
  return path.join(home, "projects");
}

/**
 * Collect session transcripts under the projects root.
 *
 * Sub-agent transcripts live in a `subagents/` directory beside their parent
 * session's. They are part of a session the rail already shows, so surfacing
 * them would spawn phantom entries for work the user never started directly.
 */
function collectTranscripts(root: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "subagents") continue;
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  }
  return out;
}

/** Map a lifecycle signal to a task status (same vocabulary as the Codex watcher). */
function statusFromLifecycle(lc: "task_started" | "task_complete" | "activity" | null): TaskStatus | null {
  if (lc === "task_started" || lc === "activity") return "running";
  if (lc === "task_complete") return "completed";
  return null;
}

/** Read a byte range from a file, or null if it cannot be read. */
function readRange(file: string, start: number, length: number): Buffer | null {
  if (length <= 0) return null;
  let fd: number | undefined;
  try {
    const buf = Buffer.alloc(length);
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, length, start);
    return buf;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* fail open */
      }
    }
  }
}

/** Run one watch tick: scan changed transcripts, ingest their new tails. */
export function watchClaudeOnce(ctx: ClaudeWatchCtx): void {
  const root = projectsDir(ctx.claudeHome);
  const nowMs = ctx.now ? ctx.now() : Date.now();

  for (const file of collectTranscripts(root)) {
    let size: number;
    let mtimeMs: number;
    try {
      const st = fs.statSync(file);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }

    let cur = cursors.get(file);
    if (!cur) {
      // First sight. A file nobody has touched in a day is history: park the
      // cursor at EOF without reading a byte of it.
      if (Date.now() - mtimeMs > FIRST_SIGHT_MAX_AGE_MS) {
        cursors.set(file, { path: file, offset: size });
        continue;
      }
      const tailStart = Math.max(0, size - FIRST_SIGHT_TAIL_BYTES);
      const seedBuf = readRange(file, tailStart, size - tailStart);
      cur = { path: file, offset: size };
      cursors.set(file, cur);

      const seed = seedBuf
        ? parseTranscriptWindow(seedBuf.toString("utf8"), "claude", tailStart > 0)
        : null;
      if (seed?.session) {
        cur.sessionId = seed.session.sessionId;
        cur.cwd = seed.session.cwd;
      }
      if (!cur.sessionId) cur.sessionId = sessionIdFromFilename(file);
      // Only surface it if the file looks live; otherwise just seed silently.
      if (cur.sessionId && seed && Date.now() - mtimeMs < LIVE_WINDOW_MS) {
        ingest(ctx, cur, seed, nowMs);
      }
      continue;
    }

    if (size < cur.offset) cur.offset = size; // truncated/rotated
    if (size === cur.offset) continue; // nothing new

    const priorOffset = cur.offset;
    const buf = readRange(file, priorOffset, size - priorOffset);
    if (!buf) continue;

    // Parse everything we read, but advance the cursor only past the last
    // COMPLETE line, so a record caught mid-append is re-read next tick rather
    // than lost. A partial line fails JSON.parse and is skipped; the store
    // de-duplicates identical narrative text, so a re-read costs nothing.
    //
    // Note the alternative that looks obvious and is wrong: skipping the
    // window's FIRST line as "possibly partial" discards the entire update
    // whenever a tick picks up exactly one new line — the common case.
    const lastNewline = buf.lastIndexOf(0x0a);
    cur.offset = lastNewline >= 0 ? priorOffset + lastNewline + 1 : priorOffset;

    const result = parseTranscriptWindow(buf.toString("utf8"), "claude", false);
    if (result.session) {
      cur.sessionId = result.session.sessionId;
      cur.cwd = result.session.cwd;
    }
    if (!cur.sessionId) cur.sessionId = sessionIdFromFilename(file);
    if (!cur.sessionId) continue; // unknown session — wait for the next tick

    ingest(ctx, cur, result, nowMs);
  }
}

/** Session id from `<uuid>.jsonl`, when no record in the window carried one. */
function sessionIdFromFilename(file: string): string | undefined {
  return path.basename(file).match(FILENAME_UUID)?.[1];
}

/** Fold a parsed window into the store for one session. */
function ingest(
  ctx: ClaudeWatchCtx,
  cur: FileCursor,
  result: ReturnType<typeof parseTranscriptWindow>,
  now: number,
): void {
  if (!cur.sessionId) return;
  const log = ctx.log ?? (() => undefined);
  const id = `${PROVIDER}:${cur.sessionId}`;
  const prior = ctx.store.getInstance(id);

  const status = statusFromLifecycle(result.lifecycle);
  const latestVis = result.narratives.at(-1);
  if (!prior && !status && !latestVis) return;

  const nextStatus: TaskStatus = status ?? prior?.status ?? "running";
  // Restart the elapsed clock when a finished or idle session picks up again.
  const revived =
    nextStatus === "running" &&
    (!prior?.startedAt ||
      prior.status === "completed" ||
      prior.status === "failed" ||
      prior.status === "idle");
  const label = cur.cwd ? basename(cur.cwd) : (prior?.label ?? "claude");

  ctx.store.upsertInstance(id, {
    taskId: cur.sessionId,
    provider: PROVIDER,
    cwdLabel: label,
    label,
    status: nextStatus,
    startedAt: revived ? now : (prior?.startedAt ?? now),
    lastActivityAt: now,
    lastNarrative: latestVis
      ? {
          id: `${cur.sessionId}:${now}:${latestVis.text.length}`,
          instanceId: id,
          provider: PROVIDER,
          phase: latestVis.phase,
          text: latestVis.text,
          occurredAt: now,
        }
      : (prior?.lastNarrative ?? null),
  });
  if (latestVis) log(`claude watcher: ${cur.sessionId} ${latestVis.phase} (${latestVis.text.length} chars)`);
}

/** Cross-platform basename that also handles Windows backslash paths. */
function basename(p: string): string {
  const base = p.replace(/[\\/]+$/, "").replace(/\\/g, "/").split("/").filter(Boolean).pop();
  return base || "claude";
}

/** Reset cursors. Test-only seam, mirroring the Codex watcher. */
export function resetClaudeCursors(): void {
  cursors.clear();
}

/** Start the periodic watcher. Returns a stop() fn. */
export function startClaudeWatcher(ctx: ClaudeWatchCtx): () => void {
  const intervalMs = Math.max(500, ctx.intervalMs ?? 3_000);
  try {
    watchClaudeOnce(ctx);
  } catch {
    /* a watch failure must never take the server down */
  }
  timer = setInterval(() => {
    try {
      watchClaudeOnce(ctx);
    } catch {
      /* same */
    }
  }, intervalMs);
  if (timer && typeof timer.unref === "function") timer.unref();
  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
