import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sanitize, deriveLabel } from "../src/hooks/sanitize.js";

test("sanitize keeps allow-listed fields (codex)", () => {
  const raw = {
    session_id: "s1",
    hook_event_name: "PreToolUse",
    cwd: "D:/proj/auth",
    // these must be dropped:
    prompt: "refactor the login",
    transcript_path: "/tmp/x.jsonl",
    tool_input: { file: "a.ts" },
    tool_output: "diff...",
    model: "gpt-5",
  };
  const r = sanitize(raw, "codex");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.data.sessionId, "s1");
    assert.equal(r.data.eventName, "PreToolUse");
    assert.equal(r.data.cwd, "D:/proj/auth");
    // transcript_path is in the codex allow-list (used only for label).
    assert.equal(r.data.transcriptPath, "/tmp/x.jsonl");
    // The dropped fields are simply absent from the result.
    assert.ok(!("prompt" in r.data));
    assert.ok(!("model" in r.data));
  }
});

test("sanitize accepts a bounded visible narrative and phase", () => {
  const r = sanitize({
    session_id: "s1",
    hook_event_name: "PostToolUse",
    narrative: `Visible update${".".repeat(2_100)}`,
    narrative_phase: "final",
  }, "codex");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.data.narrative?.startsWith("Visible update"), true);
    assert.equal(r.data.narrative?.length, 2_000);
    assert.equal(r.data.narrativePhase, "final");
  }
});

test("sanitize hard-rejects secret-like keys", () => {
  const cases = [
    { api_key: "sk-xxx", session_id: "s1", hook_event_name: "Stop" },
    { Authorization: "Bearer abc", session_id: "s1", hook_event_name: "Stop" },
    { my_password: "hunter2", session_id: "s1", hook_event_name: "Stop" },
  ];
  for (const raw of cases) {
    const r = sanitize(raw, "codex");
    assert.equal(r.ok, false, `expected reject for ${JSON.stringify(raw)}`);
    if (!r.ok) {
      // reason must NOT leak the secret value.
      assert.ok(!/sk-xxx|hunter2|Bearer abc/.test(r.reason), "reason leaked a secret value");
    }
  }
});

test("prose that merely NAMES a credential still delivers the event", () => {
  // Regression: scanning string values for words like "password"/"authorization"
  // rejected the whole payload, so the traffic light froze whenever the agent
  // happened to discuss auth. The event must survive; only the text is at stake.
  const r = sanitize(
    {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      cwd: "/home/dev/secrets-manager",
      narrative: "Fixed the authorization header and rotated the password reset token.",
    },
    "claude",
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.data.sessionId, "s1");
    assert.match(r.data.narrative ?? "", /authorization header/);
  }
});

test("a narrative carrying a real-looking credential is dropped, not rejected", () => {
  const cases = [
    "here is the key sk-abcdefghijklmnopqrstuvwxyz123456",
    "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    "-----BEGIN RSA PRIVATE KEY-----",
  ];
  for (const narrative of cases) {
    const r = sanitize({ session_id: "s1", hook_event_name: "Stop", narrative }, "claude");
    assert.equal(r.ok, true, `event must still be delivered for: ${narrative.slice(0, 24)}`);
    if (r.ok) assert.equal(r.data.narrative, undefined, `narrative must be dropped: ${narrative.slice(0, 24)}`);
  }
});

test("sanitize does not flag session_id as a secret", () => {
  const r = sanitize({ session_id: "abc-123", hook_event_name: "SessionStart" }, "claude");
  assert.equal(r.ok, true);
});

test("sanitize rejects non-object payloads", () => {
  assert.equal(sanitize("hello", "codex").ok, false);
  assert.equal(sanitize([1, 2, 3], "codex").ok, false);
  assert.equal(sanitize(null, "codex").ok, false);
});

test("sanitize requires session_id or hook_event_name", () => {
  assert.equal(sanitize({ cwd: "/x" }, "codex").ok, false);
});

test("deriveLabel uses cwd basename, falls back to transcript, then 'task'", () => {
  assert.equal(deriveLabel("D:/proj/auth-service"), "auth-service");
  assert.equal(deriveLabel("C:\\dev\\app\\"), "app");
  assert.equal(deriveLabel(undefined, "/tmp/some-transcript-abc.jsonl"), "some-transcript-abc");
  assert.equal(deriveLabel(undefined, undefined), "task");
});
