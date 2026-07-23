/**
 * HTTP + WebSocket server.
 *
 * - Serves the PWA static files from ../pwa
 * - REST: GET /api/state, GET /api/config, POST /api/hooks/:provider,
 *          POST /api/override/task, POST /api/quota/mock
 * - WS:    /ws  (snapshot on hello, delta broadcast, ping/pong keepalive)
 *
 * Uses Node's built-in http + the `ws` library. No framework — keeps deps tiny.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { AppConfig } from "./config.js";
import { sanitizeConfigForClient } from "./config.js";
import { sanitize, deriveLabel } from "./hooks/sanitize.js";
import { mapEvent } from "./hooks/mapEvent.js";
import { reduce, applyOverride } from "./state/reducer.js";
import { Store } from "./state/store.js";
import { buildCodexMetrics, buildClaudeMetrics, mergeMetrics, sortMetrics } from "./quota/metrics.js";
import type { CodexQuotaInput, ClaudeQuotaInput } from "./quota/metrics.js";
import type { ClientMsg, ServerMsg, SnapshotDelta } from "./state/types.js";
import type { QuotaMetric, QuotaSource, TaskStatus } from "./state/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PWA_DIR = path.resolve(__dirname, "..", "..", "pwa");

/** Max revision gap before we force a full snapshot instead of a delta. */
const MAX_DELTA_GAP = 50;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export interface ServerDeps {
  config: AppConfig;
  store: Store;
}

export function createServer(deps: ServerDeps): http.Server {
  const { config, store } = deps;

  // ---- WebSocket setup (attached after http server is created) ----
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  // Broadcast a delta to all connected clients. Old clients or ones far behind
  // get a full snapshot instead (pulse-island revision-gap recovery).
  function broadcast(delta: SnapshotDelta): void {
    for (const ws of clients) {
      if (ws.readyState !== ws.OPEN) continue;
      const since = lastSince.get(ws);
      if (since !== undefined && delta.revision - since > MAX_DELTA_GAP) {
        send(ws, { type: "snapshot", data: store.snapshot() });
      } else {
        send(ws, { type: "delta", data: delta });
      }
    }
  }

  const unsub = store.subscribe((delta) => broadcast(delta));
  const lastSince = new WeakMap<WebSocket, number>();

  function send(ws: WebSocket, msg: ServerMsg): void {
    try {
      ws.send(JSON.stringify(msg));
      const data = "data" in msg ? msg.data : null;
      if (data && "revision" in data && typeof data.revision === "number") {
        lastSince.set(ws, data.revision);
      }
    } catch {
      /* socket gone */
    }
  }

  // ---- HTTP handler ----
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // CORS: open for LAN/PWA use.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // ---- API routes ----
    if (pathname === "/api/state" && req.method === "GET") {
      return json(res, 200, store.snapshot());
    }

    if (pathname === "/api/config" && req.method === "GET") {
      return json(res, 200, sanitizeConfigForClient(config));
    }

    if (pathname === "/api/override/task" && req.method === "POST") {
      const body = await readJson(req);
      const status = pickString(body, "status") as TaskStatus | undefined;
      const label = pickString(body, "label");
      const task = applyOverride(store.getTask(), { status, label }, Date.now());
      store.setTask(task);
      return json(res, 200, { ok: true, task });
    }

    const hookMatch = pathname.match(/^\/api\/hooks\/(codex|claude)$/);
    if (hookMatch && req.method === "POST") {
      const provider = hookMatch[1] as "codex" | "claude";
      const raw = await readJson(req);
      const result = sanitize(raw, provider);
      if (!result.ok) {
        return json(res, 400, { ok: false, error: result.reason });
      }
      const { sessionId, eventName, cwd, transcriptPath } = result.data;
      const event = mapEvent(provider, eventName);
      const cwdLabel = deriveLabel(cwd, transcriptPath);
      const reduced = reduce(
        store.getTask(),
        {
          provider,
          taskId: sessionId,
          event,
          cwdLabel,
          occurredAt: Date.now(),
          rawEventName: eventName,
        },
        Date.now(),
      );
      store.setTask(reduced.task);
      return json(res, 200, { ok: true, status: reduced.task.status, changed: reduced.changed });
    }

    if (pathname === "/api/quota/mock" && req.method === "POST") {
      const body = (await readJson(req)) as
        | { codex?: CodexQuotaInput; claude?: ClaudeQuotaInput }
        | null;
      const codexIn = body?.codex;
      const claudeIn = body?.claude;
      const metrics: QuotaMetric[] = [];
      let codexSrc: QuotaSource = store.getSources().codex;
      let claudeSrc: QuotaSource = store.getSources().claude;
      if (codexIn && typeof codexIn === "object") {
        metrics.push(...buildCodexMetrics(codexIn, "live"));
        codexSrc = "live";
      } else {
        metrics.push(...buildCodexMetrics(config.codex.fallback, codexSrc));
      }
      if (claudeIn && typeof claudeIn === "object") {
        metrics.push(...buildClaudeMetrics(claudeIn, "config"));
        claudeSrc = "config";
      } else {
        metrics.push(...buildClaudeMetrics(config.claude.fallback, claudeSrc));
      }
      store.setMetrics(sortMetrics(metrics));
      store.setSources({ codex: codexSrc, claude: claudeSrc });
      return json(res, 200, { ok: true, metrics: store.getMetrics() });
    }

    if (pathname === "/healthz" && req.method === "GET") {
      return json(res, 200, { ok: true, ts: Date.now() });
    }

    // ---- Static PWA serving ----
    return serveStatic(req, res, pathname);
  });

  // ---- WS upgrade handling ----
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    clients.add(ws);
    // Always send a full snapshot on connect.
    send(ws, { type: "snapshot", data: store.snapshot() });

    ws.on("message", (buf) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(buf.toString()) as ClientMsg;
      } catch {
        return;
      }
      if (msg.type === "hello") {
        lastSince.set(ws, msg.since ?? store.getRevision());
        send(ws, { type: "snapshot", data: store.snapshot() });
      } else if (msg.type === "ping") {
        send(ws, { type: "pong" });
      }
    });

    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

  server.on("close", () => {
    unsub();
    wss.close();
  });

  return server;
}

/* ------------------------------ helpers ------------------------------- */

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
      // Cap payload size to avoid abuse.
      if (chunks.reduce((n, c) => n + c.length, 0) > 1_000_000) {
        req.destroy();
        resolve(null);
      }
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function pickString(o: unknown, k: string): string | undefined {
  if (o && typeof o === "object" && k in (o as Record<string, unknown>)) {
    const v = (o as Record<string, unknown>)[k];
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

/** Serve a file from PWA_DIR, with SPA fallback to index.html. */
function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): void {
  // Prevent path traversal.
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(PWA_DIR, safe);
  if (safe === "/" || safe === "" || safe === "\\") filePath = path.join(PWA_DIR, "index.html");
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // Unknown path -> fall back to index.html (SPA). Except for /api/* already handled.
    if (safe.startsWith("/api/")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
      return;
    }
    filePath = path.join(PWA_DIR, "index.html");
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "file not found" }));
  }
}
