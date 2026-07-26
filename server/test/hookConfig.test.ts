import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const manager = path.resolve(import.meta.dirname, "../../scripts/manage-hooks.mjs");

function run(home: string, action: "register" | "unregister", provider: "codex" | "claude", command?: string) {
  const args = [manager, action, provider];
  if (command) args.push(command);
  execFileSync(process.execPath, args, {
    env: { ...process.env, TOKENFLARE_HOOK_HOME: home },
    stdio: "pipe",
  });
}

test("Codex hook manager preserves user hooks and is idempotent", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokenflare-codex-hooks-"));
  try {
    const dir = path.join(home, ".codex");
    fs.mkdirSync(dir);
    const configPath = path.join(dir, "hooks.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "check-policy" }] }],
        },
      }),
    );

    const command = 'node "C:/tokenflare/hook-forward.mjs" codex "http://127.0.0.1:7331"';
    run(home, "register", "codex", command);
    run(home, "register", "codex", command);

    const registered = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(registered.hooks.PreToolUse.length, 2);
    assert.equal(registered.hooks.Stop[0].hooks[0].command, command);
    // Codex CLI supports exactly 5 events; these two are NOT among them.
    assert.equal(registered.hooks.PermissionRequest, undefined);
    assert.equal(registered.hooks.SessionEnd, undefined);
    // All 5 supported events present.
    for (const ev of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
      assert.ok(registered.hooks[ev], `codex hook for ${ev} should be registered`);
    }

    run(home, "unregister", "codex");
    const removed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(removed.hooks.PreToolUse.length, 1);
    assert.equal(removed.hooks.PreToolUse[0].hooks[0].command, "check-policy");
    assert.equal(removed.hooks.Stop, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Claude hook manager preserves settings and installs current events", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokenflare-claude-hooks-"));
  try {
    const dir = path.join(home, ".claude");
    fs.mkdirSync(dir);
    const configPath = path.join(dir, "settings.json");
    fs.writeFileSync(configPath, JSON.stringify({ model: "sonnet", hooks: {} }));

    run(home, "register", "claude", "node hook-forward.mjs claude");
    const registered = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(registered.model, "sonnet");
    assert.ok(registered.hooks.Notification);
    assert.ok(registered.hooks.PermissionRequest);
    assert.ok(registered.hooks.PostToolUseFailure);
    assert.ok(registered.hooks.SessionEnd);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
