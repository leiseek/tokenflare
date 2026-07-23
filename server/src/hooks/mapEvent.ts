/**
 * Map a provider hook event name to a provider-neutral EvidenceKind.
 *
 * Ported from pulse-island's codex/claude adapters. Critical rule:
 * Stop / SessionEnd -> "activity", NOT "completed" — the agent finishing a
 * response is not the same as the user's task being done.
 */
import type { EvidenceKind } from "../state/types.js";

/** Codex hook event names we recognize. */
const CODEX_EVENTS: Record<string, EvidenceKind> = {
  SessionStart: "started",
  UserPromptSubmit: "activity",
  PreToolUse: "activity",
  PostToolUse: "activity",
  Notification: "waiting",
  Stop: "activity",
  SessionEnd: "activity",
  SubagentStart: "activity",
  SubagentStop: "activity",
  PreCompact: "activity",
};

/** Claude Code hook event names we recognize. */
const CLAUDE_EVENTS: Record<string, EvidenceKind> = {
  SessionStart: "started",
  UserPromptSubmit: "activity",
  PreToolUse: "activity",
  PostToolUse: "activity",
  Notification: "waiting",
  Stop: "activity",
  SubagentStop: "activity",
  PreCompact: "activity",
  SessionEnd: "activity",
};

/**
 * Map a provider event name to an EvidenceKind. Unknown events default to
 * "activity" (so we at least show "running" rather than dropping the signal).
 */
export function mapEvent(
  provider: "codex" | "claude",
  eventName: string | undefined,
): EvidenceKind {
  if (!eventName) return "activity";
  const table = provider === "codex" ? CODEX_EVENTS : CLAUDE_EVENTS;
  return table[eventName] ?? "activity";
}
