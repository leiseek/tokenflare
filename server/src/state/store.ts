/**
 * In-memory authoritative state store.
 *
 * Single desk, single process -> no DB. Holds the current Snapshot and bumps a
 * monotonic revision on every mutation so the WS layer can send snapshots/deltas.
 * Broadcasts deltas to subscribed WS listeners (pulse-island snapshot/delta model).
 *
 * Multi-instance: each provider/session pair is an independent TaskInstance so
 * concurrent Codex + Claude (or several sessions) never clobber one another.
 * The legacy single `task` view is a projection of the most recently active
 * instance, kept so existing consumers keep working during the transition.
 */
import type {
  QuotaMetric,
  NarrativeEntry,
  QuotaSource,
  QuotaSources,
  Snapshot,
  SnapshotDelta,
  TaskInstance,
  TaskState,
} from "./types.js";

export type StoreListener = (delta: SnapshotDelta) => void;

/** Convert a TaskInstance to the legacy single-task shape. */
function instanceToTask(inst: TaskInstance): TaskState {
  return {
    taskId: inst.taskId,
    provider: inst.provider,
    cwdLabel: inst.cwdLabel,
    status: inst.status,
    startedAt: inst.startedAt,
    lastActivityAt: inst.lastActivityAt,
    label: inst.label,
  };
}

export class Store {
  private revision = 0;
  private tasks = new Map<string, TaskInstance>();
  private narrative: NarrativeEntry[] = [];
  private metrics: QuotaMetric[] = [];
  private sources: QuotaSources = { codex: "config", claude: "config" };
  private listeners = new Set<StoreListener>();

  /** Subscribe to delta broadcasts. Returns an unsubscribe fn. */
  subscribe(fn: StoreListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The most recently active instance (by lastActivityAt), or null. */
  private mostActive(): TaskInstance | null {
    let best: TaskInstance | null = null;
    for (const inst of this.tasks.values()) {
      if (!best || (inst.lastActivityAt ?? 0) > (best.lastActivityAt ?? 0)) best = inst;
    }
    return best;
  }

  /** Current full snapshot. */
  snapshot(): Snapshot {
    const top = this.mostActive();
    return {
      revision: this.revision,
      serverTime: Date.now(),
      tasks: [...this.tasks.values()],
      task: top ? instanceToTask(top) : null,
      narrative: [...this.narrative],
      metrics: this.metrics,
      source: { ...this.sources },
    };
  }

  /**
   * Upsert an instance by id. Merges partial fields onto the existing entry.
   * Returns the resulting instance. Bumps revision + broadcasts tasks/task.
   */
  upsertInstance(id: string, patch: Partial<TaskInstance>, opts: { silent?: boolean } = {}): TaskInstance {
    const prior = this.tasks.get(id);
    const merged: TaskInstance = {
      id,
      taskId: patch.taskId ?? prior?.taskId ?? id,
      provider: patch.provider ?? prior?.provider ?? "manual",
      cwdLabel: patch.cwdLabel ?? prior?.cwdLabel ?? "",
      status: patch.status ?? prior?.status ?? "idle",
      startedAt: patch.startedAt ?? prior?.startedAt ?? null,
      lastActivityAt: patch.lastActivityAt ?? prior?.lastActivityAt ?? null,
      label: patch.label ?? prior?.label ?? prior?.cwdLabel ?? "",
      lastNarrative: "lastNarrative" in patch ? patch.lastNarrative : prior?.lastNarrative ?? null,
    };
    this.tasks.set(id, merged);
    if (opts.silent) return merged;
    this.broadcast({
      tasks: [...this.tasks.values()],
      task: instanceToTask(this.mostActive() ?? merged),
    });
    return merged;
  }

  /** Replace the legacy single task (projects onto the most-active instance). */
  setTask(task: TaskState | null, opts: { silent?: boolean } = {}): void {
    if (!task) {
      // Legacy "clear" — leave instances intact; just resync the projection.
      if (opts.silent) return;
      this.broadcast({ task: null, tasks: [...this.tasks.values()] });
      return;
    }
    const id = `${task.provider}:${task.taskId}`;
    this.upsertInstance(
      id,
      {
        taskId: task.taskId,
        provider: task.provider,
        cwdLabel: task.cwdLabel,
        status: task.status,
        startedAt: task.startedAt,
        lastActivityAt: task.lastActivityAt,
        label: task.label,
      },
      opts,
    );
  }

  getTask(): TaskState | null {
    const top = this.mostActive();
    return top ? instanceToTask(top) : null;
  }

  getInstance(id: string): TaskInstance | undefined {
    return this.tasks.get(id);
  }

  getInstances(): TaskInstance[] {
    return [...this.tasks.values()];
  }

  /** Remove an instance by id. */
  removeInstance(id: string, opts: { silent?: boolean } = {}): void {
    if (!this.tasks.delete(id)) return;
    this.narrative = this.narrative.filter((n) => n.instanceId !== id);
    if (opts.silent) return;
    this.broadcast({ tasks: [...this.tasks.values()], narrative: [...this.narrative] });
  }

  /**
   * Record the latest visible assistant update for an instance.
   * Each instance keeps ONLY its newest narrative (#4: latest only).
   * De-duplicates identical consecutive text.
   */
  appendNarrative(entry: NarrativeEntry, opts: { silent?: boolean } = {}): void {
    const id = entry.instanceId;
    const inst = this.tasks.get(id);
    // De-dupe against the instance's last narrative (or the flat list if no instance yet).
    const existing = inst?.lastNarrative ?? this.narrative.find((n) => n.instanceId === id) ?? null;
    if (existing?.text === entry.text) return;
    if (inst) inst.lastNarrative = entry;
    // Flat list: one entry per instance (replace any prior for this instance).
    this.narrative = [...this.narrative.filter((n) => n.instanceId !== id), entry].sort(
      (a, b) => a.occurredAt - b.occurredAt,
    );
    if (opts.silent) return;
    this.broadcast({ narrative: [...this.narrative], tasks: [...this.tasks.values()] });
  }

  clearNarrative(
    provider?: NarrativeEntry["provider"],
    opts: { silent?: boolean } = {},
  ): void {
    const next = provider ? this.narrative.filter((entry) => entry.provider !== provider) : [];
    if (next.length === this.narrative.length) return;
    this.narrative = next;
    if (opts.silent) return;
    this.broadcast({ narrative: [...this.narrative] });
  }

  getNarrative(): NarrativeEntry[] {
    return [...this.narrative];
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
