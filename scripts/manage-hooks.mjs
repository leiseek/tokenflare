#!/usr/bin/env node
/**
 * Merge or remove Tokenflare lifecycle hooks without overwriting user hooks.
 *
 * Usage:
 *   node manage-hooks.mjs register <codex|claude> <command>
 *   node manage-hooks.mjs unregister <codex|claude>
 *
 * TOKENFLARE_HOOK_HOME overrides the home directory for isolated tests.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const action = process.argv[2];
const provider = process.argv[3];
const command = process.argv[4];

if (!["register", "unregister"].includes(action) || !["codex", "claude"].includes(provider)) {
  console.error("usage: manage-hooks.mjs <register|unregister> <codex|claude> [command]");
  process.exit(2);
}
if (action === "register" && !command) {
  console.error("register requires a hook command");
  process.exit(2);
}

const home = process.env.TOKENFLARE_HOOK_HOME || os.homedir();
const isCodex = provider === "codex";
const configPath = isCodex
  ? path.join(home, ".codex", "hooks.json")
  : path.join(home, ".claude", "settings.json");

const events = isCodex
  ? // Codex CLI supports exactly these 5 hook events. PermissionRequest and
    // SessionEnd are NOT among them (those are Claude Code events) — registering
    // them for Codex would never fire, so we keep the list tight. Note Codex
    // Desktop does not dispatch hooks.json at all; see codexWatcher.ts.
    ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]
  : // Claude Code exposes many more events than this; we register only the ones
    // that change the traffic light, so we add the least possible weight to the
    // agent's hot path. StopFailure is what drives the red light.
    [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "PostToolUseFailure",
      "Notification",
      "Stop",
      "StopFailure",
      "SessionEnd",
    ];

function readConfig(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("top-level value must be an object");
    }
    return value;
  } catch (error) {
    throw new Error(`Refusing to overwrite invalid JSON at ${filePath}: ${error.message}`);
  }
}

function isTokenflareHandler(handler) {
  if (!handler || typeof handler !== "object") return false;
  const text = `${handler.command || ""}\n${handler.commandWindows || ""}\n${handler.command_windows || ""}`;
  return /hook-forward\.(mjs|ps1|sh)/i.test(text);
}

function removeTokenflareHandlers(hookMap) {
  if (!hookMap || typeof hookMap !== "object" || Array.isArray(hookMap)) return {};
  const cleaned = {};
  for (const [event, groups] of Object.entries(hookMap)) {
    if (!Array.isArray(groups)) {
      cleaned[event] = groups;
      continue;
    }
    const remainingGroups = [];
    for (const group of groups) {
      if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) {
        remainingGroups.push(group);
        continue;
      }
      const remainingHandlers = group.hooks.filter((handler) => !isTokenflareHandler(handler));
      if (remainingHandlers.length > 0) {
        remainingGroups.push({ ...group, hooks: remainingHandlers });
      }
    }
    if (remainingGroups.length > 0) cleaned[event] = remainingGroups;
  }
  return cleaned;
}

function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.tokenflare-${process.pid}.tmp`);
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

const config = readConfig(configPath);
const existingHooks = isCodex ? config.hooks : config.hooks;
const hooks = removeTokenflareHandlers(existingHooks);

if (action === "register") {
  for (const event of events) {
    const current = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [
      ...current,
      {
        hooks: [
          {
            type: "command",
            command,
            timeout: 2,
          },
        ],
      },
    ];
  }
}

if (Object.keys(hooks).length > 0) config.hooks = hooks;
else delete config.hooks;
writeJsonAtomic(configPath, config);

process.stdout.write(
  JSON.stringify({
    action,
    provider,
    path: configPath,
    events: action === "register" ? events : [],
  }),
);
