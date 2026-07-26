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
  | "activity" // PreToolUse, PostToolUse, compaction, subagent events
  | "waiting" // PermissionRequest / Notification
  | "completed" // Stop / SessionEnd / manual override
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

/** The current/last task the reducer is tracking (legacy single-task view). */
export interface TaskState {
  taskId: string;
  provider: Provider;
  cwdLabel: string;
  status: TaskStatus;
  startedAt: number | null; // epoch ms
  lastActivityAt: number | null; // epoch ms
  label: string;
}

/**
 * A tracked agent instance. Each tool/session gets its own entry so concurrent
 * Codex + Claude (or multiple sessions) are tracked independently instead of
 * clobbering a single global slot.
 *
 * `id` is the stable instance key: `${provider}:${sessionId}`. The PWA renders
 * one card per instance and shows only the latest narrative for the selected one.
 */
export interface TaskInstance {
  /** Stable key: `${provider}:${sessionId}`. */
  id: string;
  /** Origin session id from the hook/transcript. */
  taskId: string;
  provider: Provider;
  cwdLabel: string;
  status: TaskStatus;
  startedAt: number | null; // epoch ms
  lastActivityAt: number | null; // epoch ms
  label: string;
  /** Most recent visible assistant update for this instance (#4: only latest). */
  lastNarrative?: NarrativeEntry | null;
}

/** Build the canonical instance id from a provider + session id. */
export function instanceId(provider: Provider, sessionId: string): string {
  return `${provider}:${sessionId}`;
}

/**
 * A provider-visible assistant update. This is intentionally not hidden
 * chain-of-thought: hook clients only send Codex commentary/final answers or
 * Claude Code text blocks, never thinking/tool blocks.
 */
export interface NarrativeEntry {
  id: string;
  /** Instance this narrative belongs to: `${provider}:${sessionId}`. */
  instanceId: string;
  provider: Exclude<Provider, "manual">;
  phase: "commentary" | "final";
  text: string;
  occurredAt: number;
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
  /** Account identity shown above this provider's cards (e.g. "Example User"). */
  accountName?: string;
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

/**
 * Where a provider's numbers came from.
 *  - live:        fetched from the provider's API this poll
 *  - observed:    derived from local files (transcripts), not the API
 *  - config:      supplied by an explicit POST /api/quota/mock
 *  - unavailable: no source succeeded — the display says so instead of guessing
 */
export type QuotaSource = "live" | "config" | "observed" | "unavailable";

/** Full state snapshot, sent on connect + GET /api/state. */
export interface Snapshot {
  revision: number;
  serverTime: number;
  /** All tracked instances keyed by id. */
  tasks: TaskInstance[];
  /** Legacy single-task view: the most recently active instance (or null). */
  task: TaskState | null;
  /** Flat list of the latest narrative per instance (one entry per instance). */
  narrative: NarrativeEntry[];
  metrics: QuotaMetric[];
  source: { codex: QuotaSource; claude: QuotaSource };
}

/** Incremental update payload sent over WebSocket deltas. */
export interface SnapshotDelta {
  revision: number;
  /** Touched/added/removed instances (full array = resync). */
  tasks?: TaskInstance[];
  /** Legacy single-task delta (projection of the most active instance). */
  task?: TaskState | null;
  /** Latest narrative per instance (one entry per instance). */
  narrative?: NarrativeEntry[];
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
