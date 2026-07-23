/**
 * Shared type definitions for the PWA. Plain .d.ts — not compiled, just here
 * for editor intellisense. Mirrors server/src/state/types.ts.
 */

export type QuotaClass = "high" | "medium" | "low" | "critical";
export type QuotaSemantics = "remaining" | "used" | "count";
export type QuotaWindow = "5h" | "7d" | "resets";
export type QuotaSource = "live" | "config" | "observed";
export type TaskStatus = "idle" | "running" | "waiting" | "completed" | "failed" | "observed";
export type Provider = "codex" | "claude" | "manual";

export interface TaskState {
  taskId: string;
  provider: Provider;
  cwdLabel: string;
  status: TaskStatus;
  startedAt: number | null;
  lastActivityAt: number | null;
  label: string;
}

export interface QuotaMetric {
  key: string;
  label: string;
  provider: Exclude<Provider, "manual">;
  window?: QuotaWindow;
  semantics: QuotaSemantics;
  percentage: number;
  quotaClass: QuotaClass;
  valueText: string;
  resetText?: string;
  progressPercent?: number;
  nextResetAt?: number | null;
  source: QuotaSource;
}

export interface Snapshot {
  revision: number;
  serverTime: number;
  task: TaskState | null;
  metrics: QuotaMetric[];
  source: { codex: QuotaSource; claude: QuotaSource };
}

export interface SnapshotDelta {
  revision: number;
  task?: TaskState | null;
  metrics?: QuotaMetric[];
  source?: { codex: QuotaSource; claude: QuotaSource };
}

export type ServerMsg =
  | { type: "snapshot"; data: Snapshot }
  | { type: "delta"; data: SnapshotDelta }
  | { type: "pong" };

export type ClientMsg =
  | { type: "hello"; client: "pwa"; since?: number }
  | { type: "ping" };
