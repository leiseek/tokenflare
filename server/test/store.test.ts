import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Store } from "../src/state/store.js";
import { buildCodexMetrics, buildClaudeMetrics } from "../src/quota/metrics.js";

test("store starts empty with revision 0", () => {
  const s = new Store();
  assert.equal(s.getRevision(), 0);
  assert.equal(s.getTask(), null);
  assert.deepEqual(s.getMetrics(), []);
});

test("setTask bumps revision and broadcasts delta", () => {
  const s = new Store();
  const received: number[] = [];
  s.subscribe((d) => received.push(d.revision));
  s.setTask({
    taskId: "t1",
    provider: "codex",
    cwdLabel: "x",
    status: "running",
    startedAt: 1,
    lastActivityAt: 1,
    label: "x",
  });
  assert.equal(s.getRevision(), 1);
  assert.deepEqual(received, [1]);
});

test("setMetrics silent does not broadcast", () => {
  const s = new Store();
  let calls = 0;
  s.subscribe(() => calls++);
  s.setMetrics(buildCodexMetrics({ fiveHour: { remaining: 50 } }, "live"), { silent: true });
  assert.equal(calls, 0);
  assert.equal(s.getRevision(), 0);
  assert.equal(s.getMetrics().length, 1);
});

test("patchMetric upserts by key and bumps revision once", () => {
  const s = new Store();
  s.setMetrics(buildClaudeMetrics({ fiveHour: { remaining: 50 }, weekly: { remaining: 50 } }, "config"));
  const before = s.getRevision();
  s.patchMetric(buildCodexMetrics({ fiveHour: { remaining: 80 } }, "live")[0]);
  assert.ok(s.getRevision() > before);
  const keys = s.getMetrics().map((m) => m.key);
  assert.ok(keys.includes("codex_5h"));
  assert.ok(keys.includes("claude_5h"));
});

test("snapshot returns a deep-enough copy with current serverTime", () => {
  const s = new Store();
  s.setSources({ codex: "live" }, { silent: true });
  const snap = s.snapshot();
  assert.ok(snap.serverTime > 0);
  assert.equal(snap.source.codex, "live");
  assert.equal(snap.revision, s.getRevision());
});

test("listener errors do not break the store", () => {
  const s = new Store();
  s.subscribe(() => { throw new Error("boom"); });
  s.subscribe((d) => { assert.ok(d.revision > 0); });
  // Must not throw.
  s.setTask({
    taskId: "t1", provider: "codex", cwdLabel: "x", status: "running",
    startedAt: 1, lastActivityAt: 1, label: "x",
  });
});
