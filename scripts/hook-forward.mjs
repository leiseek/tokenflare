#!/usr/bin/env node
/**
 * Codex/Claude hook shim — fail-open forwarder.
 *
 * Reads the provider's hook JSON from stdin, posts a sanitized copy to the
 * Tokenflare server, and exits 0 regardless of outcome. The hook must NEVER
 * block or fail the agent: all I/O is wrapped, with a hard 1s timeout.
 *
 * Usage:  node hook-forward.mjs <codex|claude> [serverUrl]
 *
 * Wired into Codex's config.toml / Claude's settings.json by the register-*.ps1
 * scripts. Provider event name is read from the payload's hook_event_name.
 */
import http from "node:http";
import https from "node:https";
import fs from "node:fs";

const provider = (process.argv[2] || "").toLowerCase();
const serverUrl = process.argv[3] || process.env.TOKENFLARE_SERVER || "http://127.0.0.1:7331";

if (provider !== "codex" && provider !== "claude") {
  // Bad invocation — but we still exit 0 to never block the agent.
  process.exit(0);
}

const HARD_TIMEOUT_MS = 1000;
// How much of the transcript tail to scan for the newest visible message.
//
// The agent spawns this file as a FRESH PROCESS per hook event, so there is no
// in-process state to carry an offset between invocations — an earlier version
// kept a Map here believing otherwise, and it was dead code that never had a
// hit. We simply read a bounded tail and take the last visible message; the
// server de-duplicates identical consecutive text, so re-reading is harmless.
// 256KB is ~2-3 turns of transcript: enough to always contain the latest
// message, small enough to stay well inside the hook's 1s budget.
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

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

function normalizeNarrative(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 2_000);
}

/** Pull visible assistant text from a single parsed transcript record. */
function visibleFromRecord(record) {
  if (provider === "codex") {
    const item = record?.type === "response_item" ? record.payload : null;
    if (
      !item ||
      item.type !== "message" ||
      item.role !== "assistant" ||
      !["commentary", "final_answer"].includes(item.phase) ||
      !Array.isArray(item.content)
    ) return null;
    const text = normalizeNarrative(
      item.content
        .filter((part) => part?.type === "output_text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n"),
    );
    return text ? { text, phase: item.phase === "final_answer" ? "final" : "commentary" } : null;
  }
  // claude
  const message = record?.type === "assistant" ? record.message : null;
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return null;
  const text = normalizeNarrative(
    message.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n"),
  );
  return text ? { text, phase: "commentary" } : null;
}

/**
 * Read a bounded tail of the transcript and return the visible assistant
 * messages it contains (oldest→newest).
 *
 * Runs on EVERY event, not just tool events, so a plain assistant reply — which
 * produces no PreToolUse/PostToolUse — still surfaces.
 */
function extractNarrative(transcriptPath, eventName) {
  if (typeof transcriptPath !== "string") return null;

  let fd;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    if (size === start) return null;

    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);

    let raw = buffer.toString("utf8");
    // If we started mid-file, the first line may be partial — drop it.
    if (start > 0) raw = raw.slice(raw.indexOf("\n") + 1);
    const lines = raw.split(/\r?\n/);

    const found = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line || !line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const vis = visibleFromRecord(record);
      if (vis) found.push(vis);
    }
    if (!found.length) return null;
    // Promote the final phase when the agent is stopping.
    if (eventName === "Stop" || eventName === "SessionEnd") {
      found[found.length - 1] = { ...found[found.length - 1], phase: "final" };
    }
    return found;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* fail open */ }
    }
  }
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

  // Sanitize at the source: prompts, tool input/output, transcripts and model
  // content never leave the agent process, even when ServerUrl is remote.
  const sanitized = {};
  for (const key of ["session_id", "hook_event_name", "cwd", "transcript_path"]) {
    if (typeof payload[key] === "string") sanitized[key] = payload[key];
  }
  const visible = extractNarrative(payload.transcript_path, payload.hook_event_name);
  if (visible && visible.length) {
    // Send the newest one as the narrative (store keeps only the latest).
    const latest = visible[visible.length - 1];
    sanitized.narrative = latest.text;
    sanitized.narrative_phase = latest.phase;
  }
  if (!sanitized.session_id && !sanitized.hook_event_name) return hardExit();

  const url = new URL(`${serverUrl}/api/hooks/${provider}`);
  const body = Buffer.from(JSON.stringify(sanitized));
  const transport = url.protocol === "https:" ? https : http;

  const req = transport.request(
    {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
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
