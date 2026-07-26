/**
 * Claude transcript watcher tests.
 *
 * Claude used to be tracked through hooks and nothing else, so an unregistered
 * or non-firing hook made a session invisible with no fallback. These cover the
 * watcher that closes that gap.
 *
 * The record shapes below are taken from real ~/.claude/projects transcripts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { watchClaudeOnce, resetClaudeCursors } from "../src/jobs/claudeWatcher.ts";
import { claudeLifecycle } from "../src/hooks/transcriptParse.ts";
import { Store } from "../src/state/store.ts";

const SESSION = "11111111-2222-3333-4444-555555555555";
const INST_ID = `claude:${SESSION}`;
const CWD = "D:\\Workspace\\my-project";

const line = (o: unknown) => JSON.stringify(o);
const USER = line({ type: "user", sessionId: SESSION, cwd: CWD, message: { role: "user", content: "go" } });
const WORKING = line({
  type: "assistant",
  sessionId: SESSION,
  cwd: CWD,
  message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "Checking the config." }] },
});
const DONE = line({
  type: "assistant",
  sessionId: SESSION,
  cwd: CWD,
  message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "All set." }] },
});
const TURN_END = line({ type: "system", subtype: "turn_duration", sessionId: SESSION, cwd: CWD });
const TOOL_ONLY = line({
  type: "assistant",
  sessionId: SESSION,
  cwd: CWD,
  message: {
    role: "assistant",
    stop_reason: "tool_use",
    content: [{ type: "thinking", thinking: "secret reasoning" }, { type: "tool_use", name: "Bash", input: { command: "rm -rf /" } }],
  },
});

/** Build a temp ~/.claude with one project transcript. */
function makeHome(body: string, opts: { stale?: boolean; subagent?: string } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-watch-"));
  const dir = path.join(home, "projects", "D--Workspace-my-project");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(file, body + "\n");
  if (opts.stale) {
    const old = new Date(Date.now() - 3 * 3600_000);
    fs.utimesSync(file, old, old);
  }
  if (opts.subagent) {
    const sub = path.join(dir, "subagents");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "agent-abc123.jsonl"), opts.subagent + "\n");
  }
  return { home, file };
}

test("claudeLifecycle maps the signals a transcript actually carries", () => {
  assert.equal(claudeLifecycle(JSON.parse(WORKING)), "activity");
  assert.equal(claudeLifecycle(JSON.parse(DONE)), "task_complete");
  assert.equal(claudeLifecycle(JSON.parse(TURN_END)), "task_complete");
  assert.equal(claudeLifecycle(JSON.parse(USER)), "activity");
  assert.equal(claudeLifecycle({ type: "ai-title", aiTitle: "x" }), null);
  assert.equal(claudeLifecycle(null), null);
});

test("a live session surfaces with its project label and visible text", () => {
  const { home } = makeHome([USER, WORKING].join("\n"));
  const store = new Store();
  resetClaudeCursors();
  watchClaudeOnce({ store, claudeHome: home, now: () => 1000 });

  const inst = store.getInstance(INST_ID);
  assert.ok(inst, "session must surface without any hook being registered");
  assert.equal(inst.label, "my-project");
  assert.equal(inst.provider, "claude");
  assert.equal(inst.status, "running");
  assert.equal(inst.lastNarrative?.text, "Checking the config.");
});

test("a finished turn reports completed", () => {
  const { home } = makeHome([USER, WORKING, DONE].join("\n"));
  const store = new Store();
  resetClaudeCursors();
  watchClaudeOnce({ store, claudeHome: home, now: () => 1000 });
  assert.equal(store.getInstance(INST_ID)!.status, "completed");
});

test("a system turn_duration record also closes the turn", () => {
  const { home } = makeHome([USER, WORKING, TURN_END].join("\n"));
  const store = new Store();
  resetClaudeCursors();
  watchClaudeOnce({ store, claudeHome: home, now: () => 1000 });
  assert.equal(store.getInstance(INST_ID)!.status, "completed");
});

test("tool calls and thinking blocks never become narrative", () => {
  const { home } = makeHome([USER, TOOL_ONLY].join("\n"));
  const store = new Store();
  resetClaudeCursors();
  watchClaudeOnce({ store, claudeHome: home, now: () => 1000 });

  const inst = store.getInstance(INST_ID)!;
  assert.equal(inst.lastNarrative ?? null, null, "no visible text in this window");
  const dump = JSON.stringify(store.snapshot());
  assert.ok(!dump.includes("secret reasoning"), "thinking block leaked");
  assert.ok(!dump.includes("rm -rf"), "tool input leaked");
});

test("sub-agent transcripts do not become phantom sessions", () => {
  // Sub-agents belong to a session the rail already shows; surfacing them would
  // invent entries for work the user never started directly.
  const { home } = makeHome([USER, WORKING].join("\n"), {
    subagent: line({
      type: "assistant",
      sessionId: "99999999-8888-7777-6666-555555555555",
      cwd: CWD,
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "subagent output" }] },
    }),
  });
  const store = new Store();
  resetClaudeCursors();
  watchClaudeOnce({ store, claudeHome: home, now: () => 1000 });

  assert.equal(store.getInstances().length, 1);
  assert.ok(store.getInstance(INST_ID));
});

test("a stale transcript is seeded silently, not surfaced", () => {
  const { home } = makeHome([USER, WORKING, DONE].join("\n"), { stale: true });
  const store = new Store();
  resetClaudeCursors();
  watchClaudeOnce({ store, claudeHome: home, now: () => 1000 });
  assert.equal(store.getInstance(INST_ID), undefined, "old sessions must not flood the rail on boot");
});

test("appended records are picked up on the next tick", () => {
  const { home, file } = makeHome([USER, WORKING].join("\n"));
  const store = new Store();
  resetClaudeCursors();
  watchClaudeOnce({ store, claudeHome: home, now: () => 1000 });
  assert.equal(store.getInstance(INST_ID)!.status, "running");

  fs.appendFileSync(file, DONE + "\n");
  watchClaudeOnce({ store, claudeHome: home, now: () => 2000 });

  const inst = store.getInstance(INST_ID)!;
  assert.equal(inst.status, "completed");
  assert.equal(inst.lastNarrative?.text, "All set.");
  assert.equal(inst.lastActivityAt, 2000);
});

test("a new turn after completion restarts the elapsed clock", () => {
  const { home, file } = makeHome([USER, WORKING, DONE].join("\n"));
  const store = new Store();
  resetClaudeCursors();
  watchClaudeOnce({ store, claudeHome: home, now: () => 1000 });
  assert.equal(store.getInstance(INST_ID)!.status, "completed");

  fs.appendFileSync(file, [USER, WORKING].join("\n") + "\n");
  watchClaudeOnce({ store, claudeHome: home, now: () => 5000 });

  const inst = store.getInstance(INST_ID)!;
  assert.equal(inst.status, "running");
  assert.equal(inst.startedAt, 5000, "a revived session restarts its timer");
});

test("a window containing exactly one new line is not swallowed", () => {
  // Regression, and it hit both watchers: treating the window's first line as
  // "possibly partial" and skipping it discards the entire update whenever a
  // tick picks up a single record — which is the normal case for a session
  // mid-turn, i.e. exactly when the display needs to update.
  const { home, file } = makeHome(USER);
  const store = new Store();
  resetClaudeCursors();
  watchClaudeOnce({ store, claudeHome: home, now: () => 1000 });

  fs.appendFileSync(file, WORKING + "\n");
  watchClaudeOnce({ store, claudeHome: home, now: () => 2000 });
  assert.equal(store.getInstance(INST_ID)!.lastNarrative?.text, "Checking the config.");

  fs.appendFileSync(file, DONE + "\n");
  watchClaudeOnce({ store, claudeHome: home, now: () => 3000 });
  assert.equal(store.getInstance(INST_ID)!.status, "completed");
  assert.equal(store.getInstance(INST_ID)!.lastNarrative?.text, "All set.");
});

test("a record still being written is picked up once it completes", () => {
  // The writer appends the JSON, then the newline. A cursor that advanced past
  // the un-terminated line would lose the record for good.
  const { home, file } = makeHome(USER);
  const store = new Store();
  resetClaudeCursors();
  watchClaudeOnce({ store, claudeHome: home, now: () => 1000 });

  fs.appendFileSync(file, DONE.slice(0, 40)); // torn mid-write, no newline
  watchClaudeOnce({ store, claudeHome: home, now: () => 2000 });
  assert.equal(store.getInstance(INST_ID)!.status, "running", "a torn line must not be believed");

  fs.appendFileSync(file, DONE.slice(40) + "\n"); // writer finishes the line
  watchClaudeOnce({ store, claudeHome: home, now: () => 3000 });
  assert.equal(store.getInstance(INST_ID)!.status, "completed");
  assert.equal(store.getInstance(INST_ID)!.lastNarrative?.text, "All set.");
});

test("a missing projects dir is not an error", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-empty-"));
  const store = new Store();
  resetClaudeCursors();
  watchClaudeOnce({ store, claudeHome: home, now: () => 1000 });
  assert.equal(store.getInstances().length, 0);
});

test("malformed lines are skipped without throwing", () => {
  const { home } = makeHome(["{not json", USER, "", WORKING].join("\n"));
  const store = new Store();
  resetClaudeCursors();
  watchClaudeOnce({ store, claudeHome: home, now: () => 1000 });
  assert.equal(store.getInstance(INST_ID)!.lastNarrative?.text, "Checking the config.");
});
