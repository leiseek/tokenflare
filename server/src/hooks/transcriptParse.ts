/**
 * Shared Codex/Claude transcript parsing.
 *
 * Codex "rollout-*.jsonl" and Claude "*.jsonl" session transcripts share a
 * JSONL shape: one JSON record per line. This module extracts ONLY the
 * user-visible assistant text (Codex `commentary`/`final_answer` output_text,
 * Claude plain `text` blocks) — never tool calls, reasoning, or thinking.
 *
 * Both the hook forwarder (last-message view) and the Codex file watcher
 * (incremental tail view) build on these primitives so the extraction logic
 * can never drift between them.
 */

/** A visible assistant update extracted from a transcript. */
export interface VisibleNarrative {
  text: string;
  phase: "commentary" | "final";
}

/** Lifecycle signal inferred from a Codex transcript record. */
export type CodexLifecycle = "task_started" | "task_complete" | "activity" | null;

/** Normalize raw assistant text: strip control chars, trim, cap length. */
export function normalizeNarrative(text: string, maxLen = 2_000): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maxLen);
}

/**
 * Extract a visible Codex assistant message from a single parsed record.
 * Returns null for non-assistant, tool-only, reasoning, or empty messages.
 *
 * Codex record shape (verified against real rollout files):
 *   { type: "response_item", payload: { type:"message", role:"assistant",
 *     phase:"commentary"|"final_answer", content: [{type:"output_text", text}] } }
 */
export function extractCodexRecord(record: unknown): VisibleNarrative | null {
  if (!record || typeof record !== "object") return null;
  const r = record as Record<string, unknown>;
  if (r.type !== "response_item") return null;
  const item = r.payload as Record<string, unknown> | undefined;
  if (!item || item.type !== "message" || item.role !== "assistant") return null;
  const phase = item.phase;
  if (phase !== "commentary" && phase !== "final_answer") return null;
  const content = item.content;
  if (!Array.isArray(content)) return null;
  const text = normalizeNarrative(
    content
      .filter(
        (part): part is { type: string; text: string } =>
          !!part && typeof part === "object" && (part as { type?: unknown }).type === "output_text" && typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("\n"),
  );
  if (!text) return null;
  return { text, phase: phase === "final_answer" ? "final" : "commentary" };
}

/**
 * Extract a visible Claude assistant message from a single parsed record.
 * Returns null for non-assistant, tool-only, thinking, or empty messages.
 *
 * Claude record shape (verified against real transcripts):
 *   { type:"assistant", message: { role:"assistant",
 *     content: [{type:"text", text}, {type:"tool_use"…}, {type:"thinking"…}] } }
 */
export function extractClaudeRecord(record: unknown): VisibleNarrative | null {
  if (!record || typeof record !== "object") return null;
  const r = record as Record<string, unknown>;
  if (r.type !== "assistant") return null;
  const message = r.message as Record<string, unknown> | undefined;
  if (!message || message.role !== "assistant") return null;
  const content = message.content;
  if (!Array.isArray(content)) return null;
  const text = normalizeNarrative(
    content
      .filter(
        (part): part is { type: string; text: string } =>
          !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("\n"),
  );
  if (!text) return null;
  return { text, phase: "commentary" };
}

/**
 * Classify a Codex record's lifecycle signal (for the file watcher).
 * Returns "task_started"/"task_complete" on the matching event_msg, "activity"
 * on a function_call/custom_tool_call (agent is working), else null.
 */
export function codexLifecycle(record: unknown): CodexLifecycle {
  if (!record || typeof record !== "object") return null;
  const r = record as Record<string, unknown>;
  if (r.type === "event_msg") {
    const ptype = (r.payload as { type?: string } | undefined)?.type;
    if (ptype === "task_started") return "task_started";
    if (ptype === "task_complete") return "task_complete";
    return null;
  }
  if (r.type === "response_item") {
    const ptype = (r.payload as { type?: string } | undefined)?.type;
    if (ptype === "function_call" || ptype === "custom_tool_call") return "activity";
  }
  return null;
}

/**
 * Classify a Claude record's lifecycle signal (for the Claude file watcher).
 *
 * Claude transcripts carry no explicit task_started/task_complete events the
 * way Codex rollouts do, so the turn boundary is inferred from what the records
 * actually say (verified against real transcripts):
 *
 *   assistant + stop_reason "tool_use"   -> the agent is calling a tool, working
 *   assistant + stop_reason "end_turn"   -> the turn produced its final answer
 *   system    + subtype "turn_duration"  -> Claude Code closed out the turn
 *   user                                 -> a prompt or a tool result came back
 *
 * Deliberately mapped onto the same vocabulary the Codex watcher uses, so both
 * feed one `statusFromLifecycle`.
 */
export function claudeLifecycle(record: unknown): CodexLifecycle {
  if (!record || typeof record !== "object") return null;
  const r = record as Record<string, unknown>;

  if (r.type === "assistant") {
    const stop = (r.message as { stop_reason?: unknown } | undefined)?.stop_reason;
    if (stop === "end_turn" || stop === "stop_sequence") return "task_complete";
    // "tool_use", null (still streaming), or anything unrecognized: still working.
    return "activity";
  }
  if (r.type === "system") {
    // turn_duration is written once the turn is finished and timed.
    if (r.subtype === "turn_duration") return "task_complete";
    return null;
  }
  if (r.type === "user") return "activity";
  return null;
}

/**
 * Extract the session id + cwd from any Claude record that carries them.
 * Unlike Codex there is no single session_meta line — `sessionId` and `cwd`
 * ride along on the user/assistant/system records themselves.
 */
export function claudeSessionMeta(
  record: unknown,
): { sessionId: string; cwd: string | undefined } | null {
  if (!record || typeof record !== "object") return null;
  const r = record as Record<string, unknown>;
  if (typeof r.sessionId !== "string" || !r.sessionId) return null;
  return { sessionId: r.sessionId, cwd: typeof r.cwd === "string" ? r.cwd : undefined };
}

/** Extract the session_id + cwd from a Codex session_meta record. */
export function codexSessionMeta(
  record: unknown,
): { sessionId: string; cwd: string | undefined } | null {
  if (!record || typeof record !== "object") return null;
  const r = record as Record<string, unknown>;
  if (r.type !== "session_meta") return null;
  const p = r.payload as Record<string, unknown> | undefined;
  const sid = p?.session_id ?? p?.id;
  if (typeof sid !== "string") return null;
  return { sessionId: sid, cwd: typeof p?.cwd === "string" ? p.cwd : undefined };
}

export interface ExtractResult {
  /** Visible assistant narratives, in file order (oldest→newest). */
  narratives: VisibleNarrative[];
  /** Last lifecycle signal seen, if any. */
  lifecycle: CodexLifecycle;
  /** Session metadata, if a session_meta record was present. */
  session: { sessionId: string; cwd: string | undefined } | null;
}

/**
 * Parse a buffer of newline-delimited transcript records.
 * Used by both the watcher (incremental tail) and tests (full fixture).
 *
 * @param text  raw JSONL text (may be a partial window)
 * @param kind  "codex" | "claude"
 * @param skipFirstPartial  if the window starts mid-line (tail read), drop the
 *                          first line since it may be a truncated record.
 */
export function parseTranscriptWindow(
  text: string,
  kind: "codex" | "claude",
  skipFirstPartial = false,
): ExtractResult {
  const narratives: VisibleNarrative[] = [];
  let lifecycle: CodexLifecycle = null;
  let session: { sessionId: string; cwd: string | undefined } | null = null;

  const lines = text.split(/\r?\n/);
  const start = skipFirstPartial ? 1 : 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue; // malformed/truncated line — skip, never throw
    }
    if (kind === "codex") {
      const vis = extractCodexRecord(record);
      if (vis) narratives.push(vis);
      const lc = codexLifecycle(record);
      if (lc) lifecycle = lc;
      const meta = codexSessionMeta(record);
      if (meta) session = meta;
    } else {
      const vis = extractClaudeRecord(record);
      if (vis) narratives.push(vis);
      const lc = claudeLifecycle(record);
      if (lc) lifecycle = lc;
      // Every record carries the ids, so keep the latest rather than the first:
      // a resumed session rewrites cwd, and the newest value is the true one.
      const meta = claudeSessionMeta(record);
      if (meta) session = meta;
    }
  }
  return { narratives, lifecycle, session };
}
