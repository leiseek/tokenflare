/**
 * Core domain types for Tokenflare.
 *
 * These are the provider-neutral shapes that flow from hook ingress through
 * the reducer into the snapshot the PWA renders. Inspired by pulse-island's
 * EvidenceKind + SignalState and cockpit-tools' UnifiedQuotaMetric.
 */

/** Provider-neutral hook event kind (port of pulse-island EvidenceKind). */
export type EvidenceKind =
  | "started" // SessionStart
  | "activity" // UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd
  | "waiting" // PermissionRequest / Notification
  | "completed" // explicit task completion (manual override or future Stop+flag)
  | "failed"; // error / abort

/** Traffic-light task status, derived by the reducer from EvidenceKind + time. */
export type TaskStatus =
  | "idle"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "observed";

/** Provider that emitted the current task (or "manual" for an override). */
export type Provider = "codex" | "claude" | "manual";

/** A sanitized hook event ready for the reducer. */
export interface HookEvent {
  provider: Provider;
  taskId: string;
  event: EvidenceKind;
  cwdLabel: string;
  occurredAt: number; // epoch ms
  /** Raw provider event name, kept only for debugging/label hints. */
  rawEventName?: string;
}

/** The current/last task the reducer is tracking. */
export interface TaskState {
  taskId: string;
  provider: Provider;
  cwdLabel: string;
  status: TaskStatus;
  startedAt: number | null; // epoch ms
  lastActivityAt: number | null; // epoch ms
  label: string;
}

/** Quota severity class (4-tier traffic light, port of cockpit-tools getCodexQuotaClass). */
export type QuotaClass = "high" | "medium" | "low" | "critical";

/** How to read `percentage`. Critical to avoid the remaining/used footgun. */
export type QuotaSemantics = "remaining" | "used" | "count";

export type QuotaWindow = "5h" | "7d" | "resets";

/** A single normalized quota card (port of cockpit-tools UnifiedQuotaMetric). */
export interface QuotaMetric {
  key: string;
  label: string;
  provider: Exclude<Provider, "manual">;
  window?: QuotaWindow;
  semantics: QuotaSemantics;
  percentage: number; // 0..100 in the metric's semantics
  quotaClass: QuotaClass;
  valueText: string;
  resetText?: string;
  /** Bar length normalized so "more filled = more quota left" for display. */
  progressPercent?: number;
  nextResetAt?: number | null;
  source: QuotaSource;
}

export type QuotaSource = "live" | "config" | "observed";

/** Full state snapshot, sent on connect + GET /api/state. */
export interface Snapshot {
  revision: number;
  serverTime: number;
  task: TaskState | null;
  metrics: QuotaMetric[];
  source: { codex: QuotaSource; claude: QuotaSource };
}

/** Incremental update payload sent over WebSocket deltas. */
export interface SnapshotDelta {
  revision: number;
  task?: TaskState | null;
  metrics?: QuotaMetric[];
  source?: { codex: QuotaSource; claude: QuotaSource };
}

export interface QuotaSources {
  codex: QuotaSource;
  claude: QuotaSource;
}

/* ----------------------------- WebSocket ------------------------------ */

export type ClientMsg =
  | { type: "hello"; client: "pwa"; since?: number }
  | { type: "ping" };

export type ServerMsg =
  | { type: "snapshot"; data: Snapshot }
  | { type: "delta"; data: SnapshotDelta }
  | { type: "pong" };
