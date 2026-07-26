/**
 * Background job: age out sessions that stopped reporting.
 *
 * Nothing else in the system ever removes a TaskInstance. Hooks and the
 * transcript watcher only ever upsert, so without this the session rail grows
 * forever and every dead session sits there frozen at "RUNNING" — the display
 * ends up showing mostly history, with the session you actually care about
 * buried among it.
 *
 * Two stages, both driven purely by `lastActivityAt`:
 *   idle  — after IDLE_AFTER_MS with no signal, a running/waiting session is
 *           demoted to "idle". It stays visible; it just stops claiming to be
 *           working. (A `completed`/`failed` session keeps its terminal status.)
 *   evict — after EVICT_AFTER_MS it is removed from the rail entirely.
 *
 * A session that reports again is simply upserted back to running by its hook
 * or the watcher, so demotion is never sticky.
 */
import type { Store } from "../state/store.js";

/** No signal for this long -> the session is no longer "running". */
export const IDLE_AFTER_MS = 5 * 60 * 1000;
/** No signal for this long -> drop the session from the rail. */
export const EVICT_AFTER_MS = 60 * 60 * 1000;
/** How often to check. */
const SWEEP_INTERVAL_MS = 15 * 1000;

export interface SweepCtx {
  store: Store;
  idleAfterMs?: number;
  evictAfterMs?: number;
  log?: (msg: string) => void;
}

/**
 * Run one sweep. Returns how many instances were demoted and evicted.
 * Pure enough to test directly with an injected `now`.
 */
export function sweepOnce(ctx: SweepCtx, now: number = Date.now()): {
  idled: number;
  evicted: number;
} {
  const idleAfter = ctx.idleAfterMs ?? IDLE_AFTER_MS;
  const evictAfter = ctx.evictAfterMs ?? EVICT_AFTER_MS;
  const log = ctx.log ?? (() => undefined);
  let idled = 0;
  let evicted = 0;

  for (const inst of ctx.store.getInstances()) {
    // A session with no timestamp at all has never reported; treat it as fresh
    // rather than immediately evicting it.
    const last = inst.lastActivityAt ?? inst.startedAt;
    if (last === null || last === undefined) continue;
    const age = now - last;

    if (age >= evictAfter) {
      ctx.store.removeInstance(inst.id);
      evicted += 1;
      log(`evicted idle session ${inst.id} (${Math.round(age / 60000)}m silent)`);
      continue;
    }

    if (age >= idleAfter && (inst.status === "running" || inst.status === "waiting")) {
      ctx.store.upsertInstance(inst.id, { status: "idle" });
      idled += 1;
      log(`session ${inst.id} went idle (${Math.round(age / 60000)}m silent)`);
    }
  }

  return { idled, evicted };
}

/** Start the periodic sweeper. Returns a stop() fn. */
export function startInstanceSweeper(ctx: SweepCtx): () => void {
  const timer = setInterval(() => {
    try {
      sweepOnce(ctx);
    } catch {
      /* a sweep failure must never take the server down */
    }
  }, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
