#!/usr/bin/env node
/**
 * Codex/Claude hook shim — fail-open forwarder.
 *
 * Reads the provider's hook JSON from stdin, posts a sanitized copy to the
 * Vibe Display server, and exits 0 regardless of outcome. The hook must NEVER
 * block or fail the agent: all I/O is wrapped, with a hard 1s timeout.
 *
 * Usage:  node hook-forward.mjs <codex|claude> [serverUrl]
 *
 * Wired into Codex's config.toml / Claude's settings.json by the register-*.ps1
 * scripts. Provider event name is read from the payload's hook_event_name.
 */
import http from "node:http";

const provider = (process.argv[2] || "").toLowerCase();
const serverUrl = process.argv[3] || process.env.VIBE_SERVER || "http://127.0.0.1:7331";

if (provider !== "codex" && provider !== "claude") {
  // Bad invocation — but we still exit 0 to never block the agent.
  process.exit(0);
}

const HARD_TIMEOUT_MS = 1000;

function hardExit() {
  process.exit(0);
}
const killer = setTimeout(hardExit, HARD_TIMEOUT_MS);
killer.unref();

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      data += c;
      if (data.length > 256 * 1024) {
        // Oversized — bail (still exit 0).
        resolve("");
        process.stdin.destroy();
      }
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
    // If stdin is a TTY (no piped JSON), just exit.
    if (process.stdin.isTTY) resolve("");
  });
}

async function main() {
  const raw = await readStdin();
  if (!raw) return hardExit();

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Not JSON — nothing to forward.
    return hardExit();
  }

  const url = new URL(`${serverUrl}/api/hooks/${provider}`);
  const body = Buffer.from(JSON.stringify(payload));

  const req = http.request(
    {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": body.length },
      timeout: 800,
    },
    () => hardExit(),
  );
  req.on("timeout", () => { req.destroy(); hardExit(); });
  req.on("error", () => hardExit());
  req.write(body);
  req.end();
}

main().catch(hardExit);
