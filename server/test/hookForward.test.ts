import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const forwarder = path.resolve(import.meta.dirname, "../../scripts/hook-forward.mjs");

test("hook forwarder sends only allow-listed lifecycle fields", async () => {
  let received: Record<string, unknown> | null = null;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        forwarder,
        "codex",
        `http://127.0.0.1:${address.port}`,
      ]);
      child.on("error", reject);
      child.on("exit", () => resolve());
      child.stdin.end(
        JSON.stringify({
          session_id: "s1",
          hook_event_name: "UserPromptSubmit",
          cwd: "D:/safe-project",
          prompt: "private prompt",
          tool_input: { command: "secret command" },
          model: "private-model",
        }),
      );
    });

    assert.deepEqual(received, {
      session_id: "s1",
      hook_event_name: "UserPromptSubmit",
      cwd: "D:/safe-project",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("hook forwarder extracts Codex commentary but excludes tool calls and hidden reasoning", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenflare-codex-transcript-"));
  const transcript = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "正在验证真实接入。" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "{\"cmd\":\"private\"}" } }),
    JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "hidden reasoning" }] } }),
  ].join("\n"));

  const received = await captureForward("codex", {
    session_id: "s2",
    hook_event_name: "PreToolUse",
    transcript_path: transcript,
    tool_input: { command: "private command" },
  });
  assert.equal(received.narrative, "正在验证真实接入。");
  assert.equal(received.narrative_phase, "commentary");
  assert.ok(!JSON.stringify(received).includes("private command"));
  assert.ok(!JSON.stringify(received).includes("hidden reasoning"));
});

test("hook forwarder extracts Claude text but excludes thinking and tool_use blocks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenflare-claude-transcript-"));
  const transcript = path.join(dir, "session.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden chain of thought" },
        { type: "text", text: "已完成 Claude Code 状态映射。" },
        { type: "tool_use", name: "Bash", input: { command: "private" } },
      ],
    },
  }));

  const received = await captureForward("claude", {
    session_id: "s3",
    hook_event_name: "Stop",
    transcript_path: transcript,
  });
  assert.equal(received.narrative, "已完成 Claude Code 状态映射。");
  assert.equal(received.narrative_phase, "final");
  assert.ok(!JSON.stringify(received).includes("hidden chain"));
  assert.ok(!JSON.stringify(received).includes("tool_use"));
});

test("hook forwarder extracts narrative on ALL events incl. non-tool ones", async () => {
  // A plain assistant reply (no tool call) — UserPromptSubmit must still surface it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenflare-codex-nontool-"));
  const transcript = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "这是一条纯文本回复，不涉及工具调用。" }] },
  }));

  const received = await captureForward("codex", {
    session_id: "s4",
    hook_event_name: "UserPromptSubmit",
    transcript_path: transcript,
  });
  assert.equal(received.narrative, "这是一条纯文本回复，不涉及工具调用。");
});

async function captureForward(
  provider: "codex" | "claude",
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let received: Record<string, unknown> | null = null;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        forwarder,
        provider,
        `http://127.0.0.1:${address.port}`,
      ]);
      child.on("error", reject);
      child.on("exit", () => resolve());
      child.stdin.end(JSON.stringify(payload));
    });
    assert.ok(received);
    return received;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
