/**
 * Background job: watch Codex session transcripts and reconstruct live state.
 *
 * The ChatGPT desktop app (and the VSCode extension) do NOT dispatch hooks.json
 * hooks — that's a Codex CLI feature. So to track Codex sessions regardless of
 * which surface launched them, we tail the rollout-*.jsonl files Codex always
 * writes under ~/.codex/sessions/YYYY/MM/DD/ and derive status + visible
 * assistant progress from them.
 *
 * The watcher keeps an in-memory byte offset per file and only reads the newly
 * appended tail on each tick (cheap). It coexists with the hook ingress — both
 * write to the same per-instance store entries keyed by `codex:<sessionId>`.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseTranscriptWindow, type VisibleNarrative } from "../hooks/transcriptParse.js";
import type { Store } from "../state/store.js";
import type { Provider, TaskStatus } from "../state/types.js";

export interface WatchCtx {
  store: Store;
  /** Root of the Codex config dir (contains sessions/). Default: ~/.codex. */
  codexHome?: string;
  /** Poll interval ms (default 3000). */
  intervalMs?: number;
  /** Logger. */
  log?: (msg: string) => void;
  /** Injected clock for tests. */
  now?: () => number;
}

const PROVIDER: Exclude<Provider, "manual"> = "codex";
/** On first sight of a file, read only this many trailing bytes to detect the
 *  session's current state without replaying its full history. Codex rewrites
 *  session_meta roughly once per turn, so 2MB is enough to catch both a recent
 *  meta (for the cwd) and the latest lifecycle/narrative signals even on large
 *  multi-megabyte session files. */
const FIRST_SIGHT_TAIL_BYTES = 2 * 1024 * 1024;
/**
 * On first sight, only files touched within this window are worth reading. A
 * long-lived `~/.codex/sessions` tree holds hundreds of old transcripts; seeding
 * every one of them meant up to FIRST_SIGHT_TAIL_BYTES of disk I/O per file at
 * startup. Older files just get their cursor parked at EOF, for free.
 */
const FIRST_SIGHT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** UUIDv7 pattern embedded in Codex rollout filenames: rollout-<ts>-<uuid>.jsonl. */
const FILENAME_UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** Extract the session id from a rollout filename (fallback when the tail has no session_meta). */
function sessionIdFromFilename(file: string): string | undefined {
  const m = path.basename(file).match(FILENAME_UUID);
  return m?.[1];
}

interface FileCursor {
  path: string;
  offset: number;
  /** Cached sessionId once we've seen a session_meta record. */
  sessionId?: string;
  cwd?: string;
}

let timer: NodeJS.Timeout | null = null;

/** Resolve the Codex sessions dir (~/.codex/sessions by default). */
function sessionsDir(codexHome?: string): string {
  const home = codexHome || process.env.TOKENFLARE_CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(home, "sessions");
}

/** Recursively collect all *.jsonl rollout files under a root dir. */
function collectTranscripts(root: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  // Walk year/month/day nested dirs; tolerate a flat layout too.
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
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
    }
  }
  return out;
}

/** Map a codex lifecycle signal to a task status. */
function statusFromLifecycle(
  lc: "task_started" | "task_complete" | "activity" | null,
): TaskStatus | null {
  if (lc === "task_started") return "running";
  if (lc === "task_complete") return "completed";
  if (lc === "activity") return "running";
  return null;
}

/** Run one watch tick: scan changed files, ingest their new tails. */
export function watchOnce(ctx: WatchCtx): void {
  const log = ctx.log ?? (() => undefined);
  const root = sessionsDir(ctx.codexHome);
  const files = collectTranscripts(root);
  // Static per-process cursor map ( survives across ticks ).
  const cursors = (watchOnce as unknown as { _cursors?: Map<string, FileCursor> })._cursors ?? new Map<string, FileCursor>();
  (watchOnce as unknown as { _cursors?: Map<string, FileCursor> })._cursors = cursors;

  for (const file of files) {
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
      // First sight of a file we've never seen. If it hasn't been touched in a
      // day it is history: park the cursor at EOF without reading anything.
      if (Date.now() - mtimeMs > FIRST_SIGHT_MAX_AGE_MS) {
        cursors.set(file, { path: file, offset: size });
        continue;
      }
      // Otherwise read only the last tail slice to detect the session's CURRENT
      // state (so an already-running session surfaces immediately), then seed
      // the offset at the full size so we never replay history.
      const tailStart = Math.max(0, size - FIRST_SIGHT_TAIL_BYTES);
      let seedBuf: Buffer | null = null;
      if (tailStart < size) {
        try {
          seedBuf = Buffer.alloc(size - tailStart);
          const fd = fs.openSync(file, "r");
          fs.readSync(fd, seedBuf, 0, seedBuf.length, tailStart);
          fs.closeSync(fd);
        } catch {
          seedBuf = null;
        }
      }
      cur = { path: file, offset: size };
      cursors.set(file, cur);
      // Resolve the session id: prefer the tail's session_meta (also gives cwd),
      // but fall back to the UUID embedded in the filename — critical for large
      // files whose only session_meta is at the very top, far outside the tail.
      const seed = seedBuf
        ? parseTranscriptWindow(seedBuf.toString("utf8"), "codex", tailStart > 0)
        : null;
      if (seed?.session) {
        cur.sessionId = seed.session.sessionId;
        cur.cwd = seed.session.cwd;
      }
      if (!cur.sessionId) cur.sessionId = sessionIdFromFilename(file);
      // Only surface a first-sight session if the file looks live. Files last
      // touched hours ago just get their offset seeded silently.
      if (cur.sessionId && seed && fileIsRecent(file, undefined, mtimeMs)) {
        ingestWindow(ctx, cur, seed, now(ctx), /*firstSightLive*/ true);
      }
      continue; // offset is now at EOF; future appends handled on later ticks
    }
    // File shrank/truncated (rotation): reset to current size.
    if (size < cur.offset) cur.offset = size;
    if (size === cur.offset) continue; // nothing new

    let buf: Buffer;
    try {
      buf = Buffer.alloc(size - cur.offset);
      const fd = fs.openSync(file, "r");
      fs.readSync(fd, buf, 0, buf.length, cur.offset);
      fs.closeSync(fd);
    } catch {
      continue;
    }
    // Parse everything we read, but advance the cursor only past the last
    // COMPLETE line.
    //
    // This used to skip the window's first line as "possibly partial", which
    // threw away the whole update whenever a tick picked up exactly one new
    // record — the common case for a session mid-turn. Holding the cursor at
    // the last newline instead means a record caught mid-append is simply
    // re-read next tick; a partial line fails JSON.parse and is skipped, and
    // the store de-duplicates identical narrative text, so re-reading a
    // complete-but-not-yet-newline-terminated record costs nothing.
    const priorOffset = cur.offset;
    const lastNewline = buf.lastIndexOf(0x0a);
    cur.offset = lastNewline >= 0 ? priorOffset + lastNewline + 1 : priorOffset;
    const text = buf.toString("utf8");
    const result = parseTranscriptWindow(text, "codex", false);

    // Learn the session id / cwd from session_meta if present; otherwise fall
    // back to the filename UUID (large files may have no meta in the new tail).
    if (result.session) {
      cur.sessionId = result.session.sessionId;
      cur.cwd = result.session.cwd;
    }
    if (!cur.sessionId) cur.sessionId = sessionIdFromFilename(file);
    if (!cur.sessionId) continue; // still unknown — wait for the next tick

    ingestWindow(ctx, cur, result, now(ctx), false);
  }
}

/**
 * Fold a parsed transcript window into the store for one session.
 * Shared by the incremental tail read and the first-sight seed.
 */
function ingestWindow(
  ctx: WatchCtx,
  cur: FileCursor,
  result: ReturnType<typeof parseTranscriptWindow>,
  now: number,
  firstSightLive: boolean,
): void {
  if (!cur.sessionId) return;
  const log = ctx.log ?? (() => undefined);
  const id = `${PROVIDER}:${cur.sessionId}`;
  const prior = ctx.store.getInstance(id);

  const latestVis = result.narratives.at(-1);
  // Codex emits task_complete at the END of a turn. That is exactly what the
  // traffic light is for, so report it as completed — the session stays in the
  // rail and the next task_started (or the next appended activity) revives it.
  // Previously this was rewritten to "running" whenever the file was recent,
  // which meant a finished turn never showed as done.
  const status = statusFromLifecycle(result.lifecycle);

  // On a non-live incremental tick with no new signal and no prior instance,
  // there's nothing to surface.
  if (!prior && !status && !latestVis && !firstSightLive) return;

  const nextStatus: TaskStatus = status ?? prior?.status ?? "running";
  // Reset the elapsed clock when a session picks up a new turn — either it has
  // never started, or it was finished/idle and is now running again.
  const revived =
    nextStatus === "running" &&
    (!prior?.startedAt || prior.status === "completed" || prior.status === "failed" || prior.status === "idle");
  const startedAt = revived ? now : prior?.startedAt ?? now;
  ctx.store.upsertInstance(id, {
    taskId: cur.sessionId,
    provider: PROVIDER,
    cwdLabel: cur.cwd ? basename(cur.cwd) : (prior?.cwdLabel ?? "codex"),
    label: cur.cwd ? basename(cur.cwd) : (prior?.label ?? "codex"),
    status: nextStatus,
    startedAt,
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
      : prior?.lastNarrative ?? null,
  });
  if (latestVis) log(`codex watcher: ${cur.sessionId} ${latestVis.phase} (${latestVis.text.length} chars)`);
}

/** Resolve the current time from the ctx clock (injectable for tests). */
function now(ctx: WatchCtx): number {
  return ctx.now ? ctx.now() : Date.now();
}

/**
 * True if a file was modified within the "live session" window (default 15 min).
 * Pass `knownMtimeMs` to reuse a stat the caller already performed.
 */
function fileIsRecent(file: string, maxAgeMs = 15 * 60 * 1000, knownMtimeMs?: number): boolean {
  try {
    const mtime = knownMtimeMs ?? fs.statSync(file).mtimeMs;
    return Date.now() - mtime < maxAgeMs;
  } catch {
    return false;
  }
}

/** Cross-platform basename that handles backslash paths (Windows cwds). */
function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const base = trimmed.replace(/\\/g, "/").split("/").filter(Boolean).pop();
  return base || "codex";
}

/** Start the periodic watcher. Returns a stop() fn. */
export function startCodexWatcher(ctx: WatchCtx): () => void {
  const intervalMs = Math.max(500, ctx.intervalMs ?? 3_000);
  void watchOnce(ctx);
  timer = setInterval(() => watchOnce(ctx), intervalMs);
  if (timer && typeof timer.unref === "function") timer.unref();
  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
