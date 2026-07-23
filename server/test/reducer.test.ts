import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applyOverride, elapsedSeconds, isTerminal, reduce } from "../src/state/reducer.js";
import type { HookEvent, TaskState } from "../src/state/types.js";

const NOW = 1_700_000_000_000;

function ev(
  event: HookEvent["event"],
  taskId = "t1",
  occurredAt: number = NOW,
  extra: Partial<HookEvent> = {},
): HookEvent {
  return {
    provider: "codex",
    taskId,
    event,
    cwdLabel: "auth-service",
    occurredAt,
    rawEventName: event,
    ...extra,
  };
}

test("started on null -> running task with startedAt", () => {
  const { task, changed } = reduce(null, ev("started"), NOW);
  assert.equal(changed, true);
  assert.equal(task.status, "running");
  assert.equal(task.startedAt, NOW);
  assert.equal(task.cwdLabel, "auth-service");
});

test("activity updates lastActivityAt and keeps status running", () => {
  let task: TaskState | null = reduce(null, ev("started", "t1", NOW - 5000), NOW - 5000).task;
  task = reduce(task, ev("activity", "t1", NOW), NOW).task;
  assert.equal(task!.status, "running");
  assert.equal(task!.lastActivityAt, NOW);
  assert.equal(task!.startedAt, NOW - 5000);
});

test("waiting -> status waiting", () => {
  let task = reduce(null, ev("started", "t1", NOW), NOW).task;
  task = reduce(task, ev("waiting", "t1", NOW), NOW).task;
  assert.equal(task!.status, "waiting");
});

test("failed -> status failed (terminal)", () => {
  let task = reduce(null, ev("started", "t1", NOW), NOW).task;
  task = reduce(task, ev("failed", "t1", NOW), NOW).task;
  assert.equal(task!.status, "failed");
  assert.equal(isTerminal(task!.status), true);
});

test("terminal protection: stale activity does NOT resurrect a failed task", () => {
  let task = reduce(null, ev("started", "t1", NOW - 10000), NOW - 10000).task;
  task = reduce(task, ev("failed", "t1", NOW - 5000), NOW - 5000).task;
  assert.equal(task!.status, "failed");
  // A late Stop/PostToolUse arrives for the same session — must not flip back to running.
  const res = reduce(task, ev("activity", "t1", NOW), NOW);
  assert.equal(res.task.status, "failed");
  assert.equal(res.changed, false);
});

test("terminal protection: stale waiting does NOT resurrect failed task either", () => {
  let task = reduce(null, ev("started", "t1", NOW - 10000), NOW - 10000).task;
  task = reduce(task, ev("failed", "t1", NOW - 5000), NOW - 5000).task;
  const res = reduce(task, ev("waiting", "t1", NOW), NOW);
  assert.equal(res.task.status, "failed");
});

test("new session id resets the task", () => {
  let task = reduce(null, ev("started", "t1", NOW - 10000), NOW - 10000).task;
  task = reduce(task, ev("failed", "t1", NOW - 5000), NOW - 5000).task;
  // A brand-new session starts — fresh running task.
  const res = reduce(task, ev("started", "t2", NOW), NOW);
  assert.equal(res.task.taskId, "t2");
  assert.equal(res.task.status, "running");
});

test("isTerminal true only for completed/failed", () => {
  assert.equal(isTerminal("completed"), true);
  assert.equal(isTerminal("failed"), true);
  assert.equal(isTerminal("running"), false);
  assert.equal(isTerminal("waiting"), false);
  assert.equal(isTerminal("idle"), false);
});

test("applyOverride forces status/label, bypassing terminal protection", () => {
  let task = reduce(null, ev("failed", "t1", NOW), NOW).task; // terminal
  task = applyOverride(task, { status: "running", label: "manual override" }, NOW);
  assert.equal(task.status, "running");
  assert.equal(task.label, "manual override");
});

test("elapsedSeconds computes from startedAt", () => {
  const task = reduce(null, ev("started", "t1", NOW - 65_000), NOW).task;
  assert.equal(elapsedSeconds(task, NOW), 65);
  assert.equal(elapsedSeconds(null, NOW), 0);
});

test("Stop maps to activity, not completed (pulse-island rule)", () => {
  let task = reduce(null, ev("started", "t1", NOW - 1000), NOW - 1000).task;
  task = reduce(task, ev("activity", "t1", NOW), NOW).task; // a "Stop" event
  assert.equal(task!.status, "running"); // NOT completed
});
