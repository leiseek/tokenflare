/**
 * Session sweeper tests.
 *
 * Without this job nothing ever removes a TaskInstance: the rail grew forever
 * and dead sessions sat there frozen at "RUNNING".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/state/store.ts";
import { sweepOnce, IDLE_AFTER_MS, EVICT_AFTER_MS } from "../src/jobs/sweepInstances.ts";

const NOW = 10_000_000;

function storeWith(lastActivityAt: number, status: "running" | "waiting" | "completed" | "idle"): Store {
  const store = new Store();
  store.upsertInstance("claude:s1", {
    taskId: "s1",
    provider: "claude",
    cwdLabel: "proj",
    label: "proj",
    status,
    startedAt: lastActivityAt,
    lastActivityAt,
  });
  return store;
}

test("a session that reported recently is left alone", () => {
  const store = storeWith(NOW - 1_000, "running");
  const { idled, evicted } = sweepOnce({ store }, NOW);
  assert.equal(idled, 0);
  assert.equal(evicted, 0);
  assert.equal(store.getInstance("claude:s1")!.status, "running");
});

test("a silent running session is demoted to idle", () => {
  const store = storeWith(NOW - IDLE_AFTER_MS - 1, "running");
  const { idled } = sweepOnce({ store }, NOW);
  assert.equal(idled, 1);
  assert.equal(store.getInstance("claude:s1")!.status, "idle");
});

test("a silent waiting session is demoted too", () => {
  const store = storeWith(NOW - IDLE_AFTER_MS - 1, "waiting");
  sweepOnce({ store }, NOW);
  assert.equal(store.getInstance("claude:s1")!.status, "idle");
});

test("a completed session keeps its terminal status while it lingers", () => {
  const store = storeWith(NOW - IDLE_AFTER_MS - 1, "completed");
  const { idled } = sweepOnce({ store }, NOW);
  assert.equal(idled, 0);
  assert.equal(store.getInstance("claude:s1")!.status, "completed");
});

test("a long-silent session is evicted from the rail", () => {
  const store = storeWith(NOW - EVICT_AFTER_MS - 1, "running");
  const { evicted } = sweepOnce({ store }, NOW);
  assert.equal(evicted, 1);
  assert.equal(store.getInstance("claude:s1"), undefined);
  assert.equal(store.getInstances().length, 0);
});

test("eviction drops the session's narrative as well", () => {
  const store = storeWith(NOW - EVICT_AFTER_MS - 1, "running");
  store.appendNarrative({
    id: "n1",
    instanceId: "claude:s1",
    provider: "claude",
    phase: "commentary",
    text: "working",
    occurredAt: NOW - EVICT_AFTER_MS,
  });
  sweepOnce({ store }, NOW);
  assert.equal(store.getNarrative().length, 0);
});

test("sweeping broadcasts so connected displays see the change", () => {
  const store = storeWith(NOW - EVICT_AFTER_MS - 1, "running");
  const deltas: unknown[] = [];
  store.subscribe((d) => deltas.push(d));
  sweepOnce({ store }, NOW);
  assert.ok(deltas.length > 0, "eviction must reach the WebSocket layer");
});

test("a session with no timestamps is treated as fresh, not evicted", () => {
  const store = new Store();
  store.upsertInstance("codex:s2", { taskId: "s2", provider: "codex", status: "running" });
  const { idled, evicted } = sweepOnce({ store }, NOW);
  assert.equal(idled, 0);
  assert.equal(evicted, 0);
  assert.ok(store.getInstance("codex:s2"));
});

test("thresholds are configurable", () => {
  const store = storeWith(NOW - 5_000, "running");
  sweepOnce({ store, idleAfterMs: 1_000, evictAfterMs: 60_000 }, NOW);
  assert.equal(store.getInstance("claude:s1")!.status, "idle");
  sweepOnce({ store, idleAfterMs: 1_000, evictAfterMs: 2_000 }, NOW);
  assert.equal(store.getInstance("claude:s1"), undefined);
});
