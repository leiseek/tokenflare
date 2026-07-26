import { strict as assert } from "node:assert";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/state/store.js";
import { watchOnce } from "../src/jobs/codexWatcher.js";
import {
  parseTranscriptWindow,
  extractCodexRecord,
  extractClaudeRecord,
  codexLifecycle,
  codexSessionMeta,
} from "../src/hooks/transcriptParse.js";

/** A valid UUIDv7-shaped filename + id, so the filename-fallback works in tests. */
const SESSION_ID = "019f91d3-8c83-7410-afae-729aeb7f3694";
const SESSION_FILE = "rollout-2026-07-24T09-57-43-019f91d3-8c83-7410-afae-729aeb7f3694.jsonl";

/** A minimal but real-shaped Codex rollout record. */
function codexRecord(partial: Record<string, unknown>): string {
  return JSON.stringify(partial);
}

const META = codexRecord({
  timestamp: "2026-07-24T01:58:08.815Z",
  type: "session_meta",
  payload: { session_id: SESSION_ID, id: SESSION_ID, cwd: "D:\\proj\\demo", originator: "Codex Desktop" },
});
const TASK_START = codexRecord({ timestamp: "t1", type: "event_msg", payload: { type: "task_started" } });
const TASK_COMPLETE = codexRecord({ timestamp: "t9", type: "event_msg", payload: { type: "task_complete" } });
const COMMENTARY = codexRecord({
  timestamp: "t3",
  type: "response_item",
  payload: {
    type: "message",
    role: "assistant",
    phase: "commentary",
    content: [{ type: "output_text", text: "我正在解析 Codex 的真实状态。" }],
  },
});
const FINAL = codexRecord({
  timestamp: "t8",
  type: "response_item",
  payload: {
    type: "message",
    role: "assistant",
    phase: "final_answer",
    content: [{ type: "output_text", text: "已完成。状态映射验证通过。" }],
  },
});
// Tool calls must NOT surface as narrative, but DO imply activity.
const FUNC_CALL = codexRecord({ timestamp: "t4", type: "response_item", payload: { type: "function_call", name: "shell" } });
const REASONING = codexRecord({ timestamp: "t5", type: "response_item", payload: { type: "reasoning", content: [] } });

/* ---------------- transcriptParse unit tests ---------------- */

test("extractCodexRecord pulls assistant output_text, ignores tools/reasoning", () => {
  const vis = extractCodexRecord(JSON.parse(COMMENTARY));
  assert.equal(vis?.phase, "commentary");
  assert.equal(vis?.text, "我正在解析 Codex 的真实状态。");
  assert.equal(extractCodexRecord(JSON.parse(REASONING)), null);
  assert.equal(extractCodexRecord(JSON.parse(FUNC_CALL)), null);
});

test("extractClaudeRecord pulls text blocks, ignores tool_use/thinking", () => {
  const rec = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }, { type: "thinking", text: "hidden" }] } };
  assert.equal(extractClaudeRecord(rec)?.text, "hi");
  // Tool-only assistant record yields null (not surfaced as narrative).
  assert.equal(extractClaudeRecord({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "x" }] } }), null);
});

test("codexLifecycle classifies task_started/complete/activity", () => {
  assert.equal(codexLifecycle(JSON.parse(TASK_START)), "task_started");
  assert.equal(codexLifecycle(JSON.parse(TASK_COMPLETE)), "task_complete");
  assert.equal(codexLifecycle(JSON.parse(FUNC_CALL)), "activity");
  assert.equal(codexLifecycle(JSON.parse(COMMENTARY)), null);
});

test("codexSessionMeta extracts session_id + cwd", () => {
  const meta = codexSessionMeta(JSON.parse(META));
  assert.equal(meta?.sessionId, SESSION_ID);
  assert.equal(meta?.cwd, "D:\\proj\\demo");
});

test("parseTranscriptWindow returns narratives in order + last lifecycle + session", () => {
  const text = [META, TASK_START, COMMENTARY, FUNC_CALL, REASONING, FINAL, TASK_COMPLETE].join("\n");
  const res = parseTranscriptWindow(text, "codex");
  assert.equal(res.narratives.length, 2);
  assert.equal(res.narratives[0].text, "我正在解析 Codex 的真实状态。");
  assert.equal(res.narratives[1].phase, "final");
  assert.equal(res.lifecycle, "task_complete");
  assert.equal(res.session?.sessionId, SESSION_ID);
});

/* ---------------- codexWatcher integration test ---------------- */

/** Make a temp codex home with a session file under sessions/YYYY/MM/DD/. */
function makeTempCodexHome(content: string, opts: { stale?: boolean } = {}): { home: string; file: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-watch-"));
  const dir = path.join(home, "sessions", "2026", "07", "24");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, SESSION_FILE);
  fs.writeFileSync(file, content, "utf8");
  // Force an old mtime so fileIsRecent() returns false (genuinely closed session).
  if (opts.stale) {
    const old = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    fs.utimesSync(file, old, old);
  }
  return { home, file };
}
const INST_ID = `codex:${SESSION_ID}`;

test("watchOnce ingests a codex transcript: running + latest narrative", () => {
  const { home } = makeTempCodexHome([META, TASK_START, COMMENTARY, FINAL].join("\n"));
  const store = new Store();
  // Reset the module-level cursor map for test isolation.
  (watchOnce as unknown as { _cursors?: Map<string, unknown> })._cursors = new Map();
  watchOnce({ store, codexHome: home, now: () => 1000 });

  const inst = store.getInstance(INST_ID);
  assert.ok(inst, "instance should be created");
  assert.equal(inst!.status, "running");
  assert.equal(inst!.cwdLabel, "demo");
  assert.equal(inst!.label, "demo");
  // Final-answer narrative is the latest -> it's what's stored.
  assert.equal(inst!.lastNarrative?.phase, "final");
  assert.equal(inst!.lastNarrative?.text, "已完成。状态映射验证通过。");
});

test("watchOnce reports a finished turn as completed", () => {
  // task_complete ends the turn, and that is exactly what the traffic light is
  // for. This used to be rewritten to "running" whenever the file was recent,
  // so a finished turn never showed as done. The session stays in the rail; the
  // sweeper ages it out and the next task_started revives it.
  const { home } = makeTempCodexHome([META, TASK_START, COMMENTARY, TASK_COMPLETE].join("\n"));
  const store = new Store();
  (watchOnce as unknown as { _cursors?: Map<string, unknown> })._cursors = new Map();
  watchOnce({ store, codexHome: home, now: () => 1500 });
  assert.equal(store.getInstance(INST_ID)!.status, "completed");
});

test("watchOnce does NOT surface a stale, long-closed session", () => {
  // A task_complete session whose file is old (1h ago) is genuinely finished
  // and should not appear on the display (avoids a flood of history on boot).
  const { home } = makeTempCodexHome([META, TASK_START, COMMENTARY, TASK_COMPLETE].join("\n"), { stale: true });
  const store = new Store();
  (watchOnce as unknown as { _cursors?: Map<string, unknown> })._cursors = new Map();
  watchOnce({ store, codexHome: home, now: () => 2000 });
  assert.equal(store.getInstance(INST_ID), undefined);
});

test("watchOnce derives sessionId from the filename when the tail has no session_meta", () => {
  // Simulate a large file: tail contains narrative but the session_meta (with
  // session_id) is only at the very top, outside the tail window. The watcher
  // must still resolve the session id from the filename UUID.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-watch-"));
  const dir = path.join(home, "sessions", "2026", "07", "24");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, SESSION_FILE);
  // No META here — only a commentary record in the tail.
  fs.writeFileSync(file, COMMENTARY, "utf8");
  const store = new Store();
  (watchOnce as unknown as { _cursors?: Map<string, unknown> })._cursors = new Map();
  watchOnce({ store, codexHome: home, now: () => 2500 });
  const inst = store.getInstance(INST_ID);
  assert.ok(inst, "instance resolved via filename UUID even without session_meta");
  assert.equal(inst!.lastNarrative?.text, "我正在解析 Codex 的真实状态。");
});

test("watchOnce is incremental: second tick only reads the new tail", () => {
  const { home, file } = makeTempCodexHome([META, TASK_START, COMMENTARY].join("\n"));
  const store = new Store();
  (watchOnce as unknown as { _cursors?: Map<string, unknown> })._cursors = new Map();
  watchOnce({ store, codexHome: home, now: () => 3000 });
  assert.equal(store.getInstance(INST_ID)!.lastNarrative?.text, "我正在解析 Codex 的真实状态。");

  // Append a newer final answer; the next tick should pick ONLY it up.
  fs.appendFileSync(file, "\n" + FINAL, "utf8");
  watchOnce({ store, codexHome: home, now: () => 4000 });
  assert.equal(store.getInstance(INST_ID)!.lastNarrative?.text, "已完成。状态映射验证通过。");
});

test("watchOnce never throws on a malformed file", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-watch-"));
  const dir = path.join(home, "sessions", "2026", "07", "24");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "broken.jsonl"), "{not valid json\n\x00garbage\n", "utf8");
  const store = new Store();
  (watchOnce as unknown as { _cursors?: Map<string, unknown> })._cursors = new Map();
  // Must not throw.
  watchOnce({ store, codexHome: home, now: () => 5000 });
  assert.equal(store.getInstances().length, 0);
});
