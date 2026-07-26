/**
 * Dev-only screenshot harness: boots the real server with representative state
 * and captures the display at the target phone viewport. Not part of the test
 * suite — it exists so UI changes get reviewed by looking at them.
 *
 *   node e2e/shot.mjs [outDir]
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT = resolve(process.argv[2] || join(ROOT, "docs", "img"));
mkdirSync(OUT, { recursive: true });

const port = await new Promise((res) => {
  const s = http.createServer();
  s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); });
});

const tmp = mkdtempSync(join(tmpdir(), "tf-shot-"));
const configPath = join(tmp, "tokenflare.config.json");
writeFileSync(configPath, JSON.stringify({
  server: { host: "127.0.0.1", port },
  codex: { autoReadAuthJson: false, pollSeconds: 0, watch: false, oauth: null },
  claude: { autoReadCredentials: false, credentialsPath: null, pollSeconds: 0, oauth: null, accountName: "Claude Code" },
  display: { defaultTheme: "neon-dark", defaultFont: "jetbrains", defaultBackground: "mesh", defaultReducedMotion: false },
}));

const proc = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "server/src/index.ts"], {
  cwd: ROOT,
  env: { ...process.env, TOKENFLARE_HOST: "127.0.0.1", TOKENFLARE_PORT: String(port), TOKENFLARE_CONFIG: configPath, TOKENFLARE_CODEX_HOME: tmp },
  stdio: ["ignore", "pipe", "pipe"],
  shell: process.platform === "win32",
});

const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up */ }
  await new Promise((r) => setTimeout(r, 250));
}

const post = (path, body) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Representative live state: two concurrent sessions + real-shaped quota.
await post("/api/hooks/claude", {
  hook_event_name: "PostToolUse", session_id: "sess-claude", cwd: "D:/Workspace/tokenflare",
  narrative: "Wired the Claude usage fetcher into the poller and threaded reset times onto the cards. Running the suite now to confirm nothing regressed.",
  narrative_phase: "commentary",
});
await post("/api/hooks/codex", {
  hook_event_name: "PermissionRequest", session_id: "sess-codex", cwd: "D:/Workspace/keeply-rapid",
  narrative: "Ready to run the migration against the staging database.", narrative_phase: "commentary",
});
await post("/api/quota/mock", {
  codex: { weekly: { remaining: 91, resetAt: Date.now() + 6 * 864e5 }, resets: { available: 3, nextExpiresAt: Date.now() + 13 * 36e5 } },
  claude: { fiveHour: { remaining: 59, resetAt: Date.now() + 102 * 6e4 }, weekly: { remaining: 87, resetAt: Date.now() + 14.7 * 36e5 } },
});

const browser = await chromium.launch();
for (const [name, vp] of Object.entries({
  phone: { width: 800, height: 360 },
  tablet: { width: 1180, height: 540 },
  desktop: { width: 1600, height: 900 },
})) {
  const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 2 });
  await page.goto(base);
  await page.waitForSelector(".quota-card");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  await page.close();
}
await browser.close();

try { process.platform === "win32" ? spawn("taskkill", ["/pid", String(proc.pid), "/f", "/t"]) : proc.kill("SIGTERM"); } catch { /* ignore */ }
console.log(`screenshots -> ${OUT}`);
process.exit(0);
