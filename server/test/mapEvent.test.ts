import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mapEvent } from "../src/hooks/mapEvent.js";

test("Codex lifecycle events map to display states", () => {
  assert.equal(mapEvent("codex", "SessionStart"), "started");
  assert.equal(mapEvent("codex", "UserPromptSubmit"), "started");
  assert.equal(mapEvent("codex", "PreToolUse"), "activity");
  assert.equal(mapEvent("codex", "PermissionRequest"), "waiting");
  assert.equal(mapEvent("codex", "Stop"), "completed");
  assert.equal(mapEvent("codex", "SessionEnd"), "completed");
});

test("Claude Code lifecycle events map to display states", () => {
  assert.equal(mapEvent("claude", "UserPromptSubmit"), "started");
  assert.equal(mapEvent("claude", "PermissionRequest"), "waiting");
  assert.equal(mapEvent("claude", "Notification"), "waiting");
  assert.equal(mapEvent("claude", "PostToolUseFailure"), "activity");
  assert.equal(mapEvent("claude", "Stop"), "completed");
  assert.equal(mapEvent("claude", "SessionEnd"), "completed");
});
