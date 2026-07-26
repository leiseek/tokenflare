/**
 * Pure task-state reducer.
 *
 * Folds a sanitized HookEvent into the current TaskState, with terminal
 * protection so a stale late event never resurrects a completed/failed task.
 * Ported from pulse-island's reduce() discipline.
 */
import type { EvidenceKind, HookEvent, TaskState, TaskStatus } from "./types.js";

/** Map an EvidenceKind to the "natural" status it implies. */
function naturalStatus(ev: EvidenceKind): TaskStatus {
  switch (ev) {
    case "started":
      return "running";
    case "activity":
      return "running";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "observed";
  }
}

/**
 * Returns true if `status` is terminal and should be protected from stale
 * lower-rank events (activity/waiting) for the same taskId.
 */
export function isTerminal(status: TaskStatus): boolean {
  return status === "completed" || status === "failed";
}

/**
 * Reduce a hook event into the task state.
 *
 * Rules:
 *  - A `started` event with a *new* taskId resets the task (new session).
 *  - A `started` event with the *same* taskId revives it to running.
 *  - Terminal tasks (completed/failed) are NOT overwritten by activity/waiting
 *    for the same taskId (stale late events). Only `started`/`completed`/`failed`
 *    can transition out.
 *  - Elapsed time is computed by the view from startedAt; reducer only stores timestamps.
 */
export function reduce(
  prior: TaskState | null,
  ev: HookEvent,
  now: number,
): { task: TaskState; changed: boolean } {
  const incoming = naturalStatus(ev.event);

  // New session id (or no prior) -> fresh task.
  if (!prior || prior.taskId !== ev.taskId) {
    const task: TaskState = {
      taskId: ev.taskId,
      provider: ev.provider,
      cwdLabel: ev.cwdLabel,
      status: incoming === "failed" ? "failed" : incoming,
      startedAt: ev.event === "started" ? ev.occurredAt : now,
      lastActivityAt: ev.occurredAt,
      label: ev.cwdLabel,
    };
    return { task, changed: true };
  }

  // Same taskId: apply terminal-protection.
  if (isTerminal(prior.status) && (ev.event === "activity" || ev.event === "waiting")) {
    // Stale event against a terminal task: ignore status, but bump lastActivityAt.
    const task: TaskState = { ...prior, lastActivityAt: ev.occurredAt };
    return { task, changed: false };
  }

  // Terminal events always win.
  if (ev.event === "completed" || ev.event === "failed") {
    const task: TaskState = { ...prior, status: incoming, lastActivityAt: ev.occurredAt };
    return { task, changed: true };
  }

  // UserPromptSubmit maps to started, so a new turn in the same session revives
  // a completed task and resets the elapsed timer.
  const task: TaskState = {
    ...prior,
    status: incoming,
    lastActivityAt: ev.occurredAt,
    startedAt: ev.event === "started" ? ev.occurredAt : (prior.startedAt ?? ev.occurredAt),
    cwdLabel: ev.cwdLabel || prior.cwdLabel,
    label: ev.cwdLabel || prior.label,
  };
  return { task, changed: true };
}

/**
 * Apply a manual override (POST /api/override/task). Bypasses terminal
 * protection — the user is explicitly forcing a state.
 */
export function applyOverride(
  prior: TaskState | null,
  patch: { status?: TaskStatus; label?: string; provider?: TaskState["provider"] },
  now: number,
): TaskState {
  const base: TaskState = prior ?? {
    taskId: "manual",
    provider: "manual",
    cwdLabel: "manual",
    status: "idle",
    startedAt: now,
    lastActivityAt: now,
    label: "manual",
  };
  return {
    ...base,
    provider: patch.provider ?? base.provider,
    status: patch.status ?? base.status,
    label: patch.label ?? base.label,
    lastActivityAt: now,
  };
}

/** Elapsed seconds since the task started, or 0 if not started. */
export function elapsedSeconds(task: TaskState | null, now: number): number {
  if (!task?.startedAt) return 0;
  return Math.max(0, Math.floor((now - task.startedAt) / 1000));
}
