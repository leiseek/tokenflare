import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Store } from "../src/state/store.js";
import { buildCodexMetrics, buildClaudeMetrics } from "../src/quota/metrics.js";

test("store starts empty with revision 0", () => {
  const s = new Store();
  assert.equal(s.getRevision(), 0);
  assert.equal(s.getTask(), null);
  assert.deepEqual(s.getNarrative(), []);
  assert.deepEqual(s.getMetrics(), []);
});

test("visible progress keeps only the latest per instance and broadcasts", () => {
  const s = new Store();
  let latestLength = 0;
  s.subscribe((delta) => {
    if (delta.narrative) latestLength = delta.narrative.length;
  });
  // Ten updates for one codex instance -> only the newest survives.
  for (let i = 0; i < 10; i++) {
    s.appendNarrative({
      id: `n${i}`,
      instanceId: "codex:ses1",
      provider: "codex",
      phase: "commentary",
      text: `update ${i}`,
      occurredAt: i,
    });
  }
  assert.equal(s.getNarrative().length, 1);
  assert.equal(s.getNarrative()[0].text, "update 9");
  assert.equal(latestLength, 1);
  // A second instance keeps its own single latest entry.
  for (let i = 0; i < 3; i++) {
    s.appendNarrative({
      id: `c${i}`,
      instanceId: "claude:ses2",
      provider: "claude",
      phase: "commentary",
      text: `claude update ${i}`,
      occurredAt: 20 + i,
    });
  }
  assert.equal(s.getNarrative().length, 2);
  assert.equal(s.getNarrative().filter((e) => e.provider === "codex").length, 1);
  assert.equal(s.getNarrative().filter((e) => e.provider === "claude").length, 1);
  assert.equal(s.getNarrative().find((e) => e.provider === "claude")!.text, "claude update 2");
  // Identical consecutive text for the same instance is a no-op.
  const before = s.getRevision();
  s.appendNarrative({ id: "dup", instanceId: "codex:ses1", provider: "codex", phase: "commentary", text: "update 9", occurredAt: 99 });
  assert.equal(s.getRevision(), before);
  s.clearNarrative("codex");
  assert.equal(s.getNarrative().length, 1);
  assert.ok(s.getNarrative().every((entry) => entry.provider === "claude"));
  s.clearNarrative();
  assert.deepEqual(s.getNarrative(), []);
});

test("concurrent instances are independent and do not clobber each other", () => {
  const s = new Store();
  s.setTask({ taskId: "ses1", provider: "codex", cwdLabel: "proj-a", status: "running", startedAt: 1, lastActivityAt: 5, label: "proj-a" });
  s.setTask({ taskId: "ses2", provider: "claude", cwdLabel: "proj-b", status: "running", startedAt: 2, lastActivityAt: 9, label: "proj-b" });
  // Both instances coexist.
  assert.equal(s.getInstances().length, 2);
  // The most-active projection points at the later-activity instance.
  assert.equal(s.getTask()!.taskId, "ses2");
  // A status change on one does not affect the other.
  s.upsertInstance("codex:ses1", { status: "completed" });
  assert.equal(s.getInstance("codex:ses1")!.status, "completed");
  assert.equal(s.getInstance("claude:ses2")!.status, "running");
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
