import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * End-to-end: boot the real server with a test config (codex poll disabled so
 * no network), drive hook + mock POSTs, and assert the PWA renders the right
 * traffic-light state + quota cards over WebSocket.
 */

const ROOT = resolve(__dirname, "..", "..");

// Shared server handle + base URL. Set by the first test; reused by the rest.
let serverProc: ChildProcess | null = null;
let baseUrl = "";

/** Boot the server with poll disabled, returning once /healthz responds. */
async function bootServer(mode: "source" | "compiled" = "source"): Promise<string> {
  // Pick a free port by binding a temporary server then closing it.
  const port = await new Promise<number>((res) => {
    const srv = http.createServer();
    srv.listen(0, () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => res(p));
    });
  });

  // Write a test config that disables codex polling (no network in CI).
  const tmp = mkdtempSync(join(tmpdir(), "vibe-e2e-"));
  const configPath = join(tmp, "tokenflare.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      server: { host: "127.0.0.1", port },
      codex: {
        autoReadAuthJson: false,
        pollSeconds: 0,
        oauth: null,
        fallback: {
          fiveHour: { remaining: 50 },
          weekly: { remaining: 60 },
          resets: { available: 1 },
        },
      },
      claude: {
        fallback: { fiveHour: { remaining: 30 }, weekly: { remaining: 70 } },
      },
      display: { defaultTheme: "neon-dark", defaultFont: "jetbrains", defaultBackground: "mesh", defaultReducedMotion: false },
    }),
  );

  // "source" runs via tsx; "compiled" runs the built dist/ artifact.
  const cmd = mode === "compiled"
    ? { bin: process.platform === "win32" ? "node.exe" : "node", args: ["server/dist/src/index.js"] }
    : { bin: process.platform === "win32" ? "npx.cmd" : "npx", args: ["tsx", "server/src/index.ts"] };

  serverProc = spawn(cmd.bin, cmd.args, {
    cwd: ROOT,
    env: {
      ...process.env,
      TOKENFLARE_HOST: "127.0.0.1",
      TOKENFLARE_PORT: String(port),
      TOKENFLARE_CONFIG: configPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
    // Required on Windows to launch npx.cmd (.exe files like node don't need it).
    shell: process.platform === "win32" && cmd.bin === "npx.cmd",
  });

  // Wait for /healthz to respond (up to 15s).
  const url = `http://127.0.0.1:${port}`;
  const start = Date.now();
  while (Date.now() - start < 15_000) {
    try {
      const r = await fetch(`${url}/healthz`);
      if (r.ok) return url;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become healthy on ${url}`);
}

async function killServer() {
  if (!serverProc) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(serverProc.pid), "/f", "/t"]);
    } else {
      serverProc.kill("SIGTERM");
    }
  } catch {
    /* ignore */
  }
  serverProc = null;
}

test.describe.serial("Tokenflare end-to-end", () => {
  test.beforeAll(async () => {
    baseUrl = await bootServer();
  });
  test.afterAll(async () => {
    await killServer();
  });

  test("PWA loads and shows seeded quota cards", async ({ page }) => {
    await page.goto(baseUrl);
    // Hero idle by default (no task yet).
    await expect(page.locator("#statusWord")).toHaveText("IDLE");
    await expect(page.locator("#statusDot")).toHaveAttribute("data-status", "idle");

    // Five metric cards from the seeded config.
    await expect(page.locator(".quota-card")).toHaveCount(5);
    await expect(page.locator(".quota-card[data-key=codex_5h] .quota-label")).toHaveText("Codex 5h");
    await expect(page.locator(".quota-card[data-key=codex_resets] .quota-value")).toHaveText("1 left");
  });

  test("POST /api/hooks/codex SessionStart turns the hero green/running", async ({ page }) => {
    await page.goto(baseUrl);
    await expect(page.locator(".quota-card")).toHaveCount(5);

    const res = await fetch(`${baseUrl}/api/hooks/codex`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "e2e-1",
        cwd: "D:/proj/tokenflare",
      }),
    });
    assert.equal(res.status, 200);

    // The PWA should reflect the WS delta within a moment.
    await expect(page.locator("#statusWord")).toHaveText("RUNNING");
    await expect(page.locator("#statusDot")).toHaveAttribute("data-status", "running");
    await expect(page.locator("#taskLabel")).toHaveText("tokenflare");
  });

  test("waiting hook turns the hero amber", async ({ page }) => {
    await page.goto(baseUrl);
    // start
    await fetch(`${baseUrl}/api/hooks/codex`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "e2e-2", cwd: "D:/proj/x" }),
    });
    await expect(page.locator("#statusWord")).toHaveText("RUNNING");
    // waiting
    await fetch(`${baseUrl}/api/hooks/codex`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "Notification", session_id: "e2e-2", cwd: "D:/proj/x" }),
    });
    await expect(page.locator("#statusWord")).toHaveText("WAITING");
    await expect(page.locator("#statusDot")).toHaveAttribute("data-status", "waiting");
  });

  test("mock quota POST updates the cards live", async ({ page }) => {
    await page.goto(baseUrl);
    await expect(page.locator(".quota-card")).toHaveCount(5);

    await fetch(`${baseUrl}/api/quota/mock`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        codex: { fiveHour: { remaining: 8 }, weekly: { remaining: 95 }, resets: { available: 0 } },
        claude: { fiveHour: { remaining: 45 }, weekly: { remaining: 12 } },
      }),
    });

    // codex_5h at 8% -> critical (red).
    await expect(page.locator(".quota-card[data-key=codex_5h] .quota-value")).toHaveClass(/critical/);
    await expect(page.locator(".quota-card[data-key=codex_5h] .quota-value")).toHaveText("8%");
    // resets at 0 -> none left, critical.
    await expect(page.locator(".quota-card[data-key=codex_resets] .quota-value")).toHaveText("none left");
    // claude_7d at 12% -> low.
    await expect(page.locator(".quota-card[data-key=claude_7d] .quota-value")).toHaveClass(/low/);
  });

  test("reconnect resyncs via snapshot (page never blanks)", async ({ page }) => {
    await page.goto(baseUrl);
    await expect(page.locator(".quota-card")).toHaveCount(5);

    // Force the page's WS client to reconnect via the settings button.
    await page.evaluate(() => {
      const inp = document.getElementById("serverInput") as HTMLInputElement | null;
      // Trigger an input event to commit, then click reconnect.
      if (inp) inp.value = inp.value; // no change, but ensures value present
    });
    await page.click("#gearBtn");
    await page.click("#reconnectBtn");

    // After reconnect, the cards should still be present (snapshot resync).
    await expect(page.locator(".quota-card")).toHaveCount(5);
    await expect(page.locator("#connBadge")).toHaveAttribute("data-conn", "open");
  });

  test("reduced-motion toggle freezes the background animation", async ({ page }) => {
    await page.goto(baseUrl);
    await page.click("#gearBtn");
    await page.check("#reducedMotionToggle");
    await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "true");
  });

  test("theme switcher changes the data-theme attribute", async ({ page }) => {
    await page.goto(baseUrl);
    await page.click("#gearBtn");
    await page.selectOption("#themeSelect", "tokyo-night");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "tokyo-night");
  });

  test("font switcher re-points the font stylesheet (regression: was a no-op)", async ({ page }) => {
    await page.goto(baseUrl);
    await page.click("#gearBtn");
    // Default is jetbrains. The <link#fontLink> href must point at a JetBrains URL.
    const link = page.locator("#fontLink");
    await expect(link).toHaveAttribute("href", /JetBrains/);

    // Switch to Inter -> href changes to Inter.
    await page.selectOption("#fontSelect", "inter");
    await expect(link).toHaveAttribute("href", /Inter/);
    await expect(page.locator("html")).toHaveAttribute("data-font", "inter");

    // Switch to System -> the Google Fonts sheet is disabled (no external font load).
    await page.selectOption("#fontSelect", "system");
    await expect(link).toHaveAttribute("disabled", "");
    await expect(page.locator("html")).toHaveAttribute("data-font", "system");
  });

  test("secret-bearing hook is rejected with 400", async () => {
    const res = await fetch(`${baseUrl}/api/hooks/codex`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: "sk-leak", session_id: "x", hook_event_name: "Stop" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error ?? "", /secret/i);
    // And the reason must NOT contain the leaked value.
    assert.ok(!JSON.stringify(body).includes("sk-leak"));
  });
});

/**
 * Separate suite: the COMPILED build (server/dist) must serve the PWA too.
 * This guards the exact bug where relative PWA-path resolution worked under
 * tsx (src/) but broke under the compiled artifact (dist/src/).
 */
test.describe.serial("Tokenflare compiled build serves the PWA", () => {
  let compiledUrl = "";

  test.beforeAll(async () => {
    compiledUrl = await bootServer("compiled");
  });
  test.afterAll(async () => {
    await killServer();
  });

  test("compiled server serves index.html, CSS, JS, and API", async ({ request }) => {
    // index.html (NOT a "file not found" JSON)
    const html = await request.get(`${compiledUrl}/`);
    expect(html.ok()).toBeTruthy();
    const htmlText = await html.text();
    assert.ok(htmlText.includes("<!DOCTYPE html>"), "index.html missing doctype");

    // static assets resolve from the pwa/ dir
    for (const asset of ["/styles/base.css", "/styles/themes.css", "/styles/components.css", "/js/app.js", "/js/client.js", "/manifest.webmanifest"]) {
      const r = await request.get(`${compiledUrl}${asset}`);
      expect(r.ok(), `${asset} should be 200`).toBeTruthy();
    }

    // API works too
    const state = await request.get(`${compiledUrl}/api/state`);
    expect(state.ok()).toBeTruthy();
    const body = await state.json();
    assert.ok(Array.isArray(body.metrics), "state.metrics should be an array");
  });
});
