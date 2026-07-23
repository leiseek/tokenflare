/**
 * In-memory authoritative state store.
 *
 * Single desk, single process -> no DB. Holds the current Snapshot and bumps a
 * monotonic revision on every mutation so the WS layer can send snapshots/deltas.
 * Broadcasts deltas to subscribed WS listeners (pulse-island snapshot/delta model).
 */
import type {
  QuotaMetric,
  QuotaSource,
  QuotaSources,
  Snapshot,
  SnapshotDelta,
  TaskState,
} from "./types.js";

export type StoreListener = (delta: SnapshotDelta) => void;

export class Store {
  private revision = 0;
  private task: TaskState | null = null;
  private metrics: QuotaMetric[] = [];
  private sources: QuotaSources = { codex: "config", claude: "config" };
  private listeners = new Set<StoreListener>();

  /** Subscribe to delta broadcasts. Returns an unsubscribe fn. */
  subscribe(fn: StoreListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Current full snapshot. */
  snapshot(): Snapshot {
    return {
      revision: this.revision,
      serverTime: Date.now(),
      task: this.task,
      metrics: this.metrics,
      source: { ...this.sources },
    };
  }

  /** Replace the task and bump revision. */
  setTask(task: TaskState | null, opts: { silent?: boolean } = {}): void {
    this.task = task;
    if (opts.silent) return;
    this.broadcast({ task });
  }

  getTask(): TaskState | null {
    return this.task;
  }

  /** Replace the full metrics array and bump revision. */
  setMetrics(metrics: QuotaMetric[], opts: { silent?: boolean } = {}): void {
    this.metrics = metrics;
    if (opts.silent) return;
    this.broadcast({ metrics });
  }

  getMetrics(): QuotaMetric[] {
    return this.metrics;
  }

  /** Patch a single metric by key (upsert) and bump revision. */
  patchMetric(metric: QuotaMetric, opts: { silent?: boolean } = {}): void {
    const idx = this.metrics.findIndex((m) => m.key === metric.key);
    if (idx >= 0) this.metrics[idx] = metric;
    else this.metrics.push(metric);
    if (opts.silent) return;
    this.broadcast({ metrics: this.metrics });
  }

  setSources(sources: Partial<QuotaSources>, opts: { silent?: boolean } = {}): void {
    this.sources = { ...this.sources, ...sources };
    if (opts.silent) return;
    this.broadcast({ source: { ...this.sources } });
  }

  getSources(): QuotaSources {
    return { ...this.sources };
  }

  getRevision(): number {
    return this.revision;
  }

  /**
   * Broadcast a partial delta. Always bumps revision first so listeners see a
   * strictly increasing revision per broadcast.
   */
  private broadcast(partial: Omit<SnapshotDelta, "revision">): void {
    this.revision += 1;
    const delta: SnapshotDelta = { revision: this.revision, ...partial };
    for (const fn of this.listeners) {
      try {
        fn(delta);
      } catch {
        /* listener errors must not break the store */
      }
    }
  }
}
