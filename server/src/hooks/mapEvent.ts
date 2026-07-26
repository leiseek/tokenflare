/**
 * Map a provider hook event name to a provider-neutral EvidenceKind.
 *
 * UserPromptSubmit starts a new displayed turn, PermissionRequest/Notification
 * means the agent is waiting, and Stop/SessionEnd completes the displayed turn.
 */
import type { EvidenceKind } from "../state/types.js";

/** Codex hook event names we recognize. */
const CODEX_EVENTS: Record<string, EvidenceKind> = {
  SessionStart: "started",
  UserPromptSubmit: "started",
  PreToolUse: "activity",
  PostToolUse: "activity",
  PermissionRequest: "waiting",
  Stop: "completed",
  SessionEnd: "completed",
  SubagentStart: "activity",
  SubagentStop: "activity",
  PreCompact: "activity",
};

/** Claude Code hook event names we recognize. */
const CLAUDE_EVENTS: Record<string, EvidenceKind> = {
  SessionStart: "started",
  UserPromptSubmit: "started",
  PreToolUse: "activity",
  PostToolUse: "activity",
  PostToolUseFailure: "activity",
  PostToolBatch: "activity",
  // The agent is blocked on the user: this is the amber light.
  PermissionRequest: "waiting",
  Notification: "waiting",
  Elicitation: "waiting",
  // Denial doesn't end the turn — the agent carries on with the refusal.
  PermissionDenied: "activity",
  Stop: "completed",
  // The turn ended in an error rather than an answer: the red light.
  StopFailure: "failed",
  SubagentStart: "activity",
  SubagentStop: "activity",
  PreCompact: "activity",
  PostCompact: "activity",
  SessionEnd: "completed",
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
