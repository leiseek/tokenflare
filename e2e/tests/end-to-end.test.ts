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
      // Both quota fetchers are fully disabled: no credentials to read and no
      // network call, so CI never depends on OpenAI/Anthropic being reachable.
      codex: {
        autoReadAuthJson: false,
        pollSeconds: 0,
        watch: false,
        oauth: null,
      },
      claude: {
        autoReadCredentials: false,
        credentialsPath: null,
        pollSeconds: 0,
        oauth: null,
        accountName: "Claude Code",
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
      // Point the codex transcript watcher at an empty dir so the real
      // ~/.codex/sessions never leaks live sessions into the test assertions.
      TOKENFLARE_CODEX_HOME: tmp,
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

  test("PWA loads with no fake quota — shows 'not connected' until real data", async ({ page }) => {
    await page.goto(baseUrl);
    // Hero idle by default (no task yet).
    await expect(page.locator("#statusWord")).toHaveText("IDLE");
    await expect(page.locator("#statusDot")).toHaveAttribute("data-status", "idle");

    // No fabricated placeholder cards: the display waits for real data.
    await expect(page.locator(".quota-card")).toHaveCount(0);
    // Each provider section shows an explicit "not connected" note.
    await expect(page.locator(".quota-section-empty")).toHaveCount(2);
    await expect(page.locator(".quota-section[data-provider=codex]")).toContainText("not connected");
    await expect(page.locator(".quota-section[data-provider=claude]")).toContainText("not connected");
  });

  test("POST /api/hooks/codex SessionStart turns the hero green/running", async ({ page }) => {
    await page.goto(baseUrl);
    await expect(page.locator(".quota-section")).toHaveCount(2);

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
    // The instance appears in the left rail (scope by id; other sessions may persist).
    const card = page.locator(".instance-card[data-id='codex:e2e-1']");
    await expect(card).toHaveCount(1);
    await expect(card.locator(".instance-label")).toHaveText("tokenflare");
  });

  test("waiting hook turns the hero amber", async ({ page }) => {
    await page.goto(baseUrl);
    // start
    await fetch(`${baseUrl}/api/hooks/codex`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "e2e-2", cwd: "D:/proj/x" }),
    });
    await expect(page.locator("#statusWord")).toHaveText("RUNNING");
    // Codex emits PermissionRequest when it is waiting for user approval.
    await fetch(`${baseUrl}/api/hooks/codex`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "e2e-2", cwd: "D:/proj/x" }),
    });
    await expect(page.locator("#statusWord")).toHaveText("WAITING");
    await expect(page.locator("#statusDot")).toHaveAttribute("data-status", "waiting");
  });

  test("multiple instances coexist and each shows its own latest narrative", async ({ page }) => {
    await page.goto(baseUrl);
    const codexVisible = "我正在验证 Codex 的真实状态映射。";
    const claudeVisible = "我正在验证 Claude Code 的真实状态映射。";
    await fetch(`${baseUrl}/api/hooks/codex`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: "e2e-progress",
        cwd: "D:/proj/tokenflare",
        narrative: codexVisible,
        narrative_phase: "commentary",
        tool_input: { command: "must never render" },
      }),
    });
    await fetch(`${baseUrl}/api/hooks/claude`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: "e2e-progress-claude",
        cwd: "D:/proj/other",
        narrative: claudeVisible,
        narrative_phase: "commentary",
      }),
    });

    // Two independent instance cards for the sessions we just posted (earlier
    // tests' sessions may also persist, so scope by data-id).
    const codexCard = page.locator(".instance-card[data-id='codex:e2e-progress']");
    const claudeCard = page.locator(".instance-card[data-id='claude:e2e-progress-claude']");
    await expect(codexCard).toHaveCount(1);
    await expect(claudeCard).toHaveCount(1);
    await expect(codexCard.locator(".instance-label")).toHaveText("tokenflare");
    await expect(claudeCard.locator(".instance-label")).toHaveText("other");

    // Only ONE narrative entry renders (the active instance's latest).
    await expect(page.locator(".narrative-entry")).toHaveCount(1);
    await expect(page.locator(".narrative-panel")).not.toContainText("must never render");

    // The most-recently-active instance (claude, posted last) is shown by default.
    await expect(page.locator(".narrative-text")).toHaveText(claudeVisible);

    // Selecting the codex instance swaps the narrative to its latest.
    await page.click(".instance-card[data-id='codex:e2e-progress']");
    await expect(page.locator(".narrative-entry")).toHaveCount(1);
    await expect(page.locator(".narrative-text")).toHaveText(codexVisible);
    await expect(codexCard).toHaveAttribute("aria-pressed", "true");

    // Selection persists across reload.
    await page.reload();
    await expect(codexCard).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".narrative-text")).toHaveText(codexVisible);
  });

  test("mock quota POST updates the cards live", async ({ page }) => {
    await page.goto(baseUrl);
    // Start empty (no fabricated data)...
    await expect(page.locator(".quota-card")).toHaveCount(0);

    await fetch(`${baseUrl}/api/quota/mock`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        codex: { fiveHour: { remaining: 8 }, weekly: { remaining: 95 }, resets: { available: 0 } },
        claude: { fiveHour: { remaining: 45 }, weekly: { remaining: 12 } },
      }),
    });

    // ...then real-shaped mock data populates the cards.
    // codex_5h at 8% -> critical (red).
    await expect(page.locator(".quota-card[data-key=codex_5h] .quota-value")).toHaveClass(/critical/);
    await expect(page.locator(".quota-card[data-key=codex_5h] .quota-value")).toHaveText("8%");
    // resets at 0 -> none left, critical.
    await expect(page.locator(".quota-card[data-key=codex_resets] .quota-value")).toHaveText("none left");
    // claude_7d at 12% -> low.
    await expect(page.locator(".quota-card[data-key=claude_7d] .quota-value")).toHaveClass(/low/);
    // Account-name headers are rendered above each provider's cards.
    await expect(page.locator(".quota-section-head")).toHaveCount(2);
  });

  test("a window the API omits renders as 'n/a', not as a missing card", async ({ page }) => {
    await page.goto(baseUrl);
    // ChatGPT drops the 5h window for some plans, so /usage comes back with
    // only the weekly one. Silently omitting the card made the display look
    // broken; it has to say the window wasn't reported.
    await fetch(`${baseUrl}/api/quota/mock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codex: { weekly: { remaining: 94 }, resets: { available: 3 } } }),
    });

    const fiveHour = page.locator(".quota-card[data-key=codex_5h]");
    await expect(fiveHour).toHaveCount(1);
    await expect(fiveHour).toHaveAttribute("data-state", "missing");
    await expect(fiveHour.locator(".quota-value")).toHaveText("n/a");
    await expect(fiveHour.locator(".quota-reset")).toHaveText("not reported");
    // The windows that WERE reported still read as real values.
    await expect(page.locator(".quota-card[data-key=codex_7d] .quota-value")).toHaveText("94%");
    await expect(page.locator(".quota-card[data-key=codex_resets] .quota-value")).toHaveText("3 left");
  });

  test("prose naming a credential still updates the traffic light", async ({ page }) => {
    await page.goto(baseUrl);
    // Regression: the edge sanitizer used to scan string VALUES for words like
    // "password"/"authorization" and reject the whole event, so the light froze
    // whenever the agent discussed auth.
    const res = await fetch(`${baseUrl}/api/hooks/claude`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "e2e-secretprose",
        cwd: "D:/proj/auth-service",
        narrative: "Reviewing the authorization header and password reset flow.",
      }),
    });
    assert.equal(res.status, 200);

    const card = page.locator(".instance-card[data-id='claude:e2e-secretprose']");
    await expect(card).toHaveCount(1);
    await page.click(".instance-card[data-id='claude:e2e-secretprose']");
    await expect(page.locator(".narrative-text")).toContainText("authorization header");
  });

  test("a real-looking token is stripped but the event still lands", async ({ page }) => {
    await page.goto(baseUrl);
    const res = await fetch(`${baseUrl}/api/hooks/claude`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "e2e-realtoken",
        cwd: "D:/proj/leaky",
        narrative: "the key is sk-abcdefghijklmnopqrstuvwxyz012345",
      }),
    });
    assert.equal(res.status, 200);

    await expect(page.locator(".instance-card[data-id='claude:e2e-realtoken']")).toHaveCount(1);
    await page.click(".instance-card[data-id='claude:e2e-realtoken']");
    // Status arrived; the token did not.
    await expect(page.locator(".narrative-panel")).not.toContainText("sk-abcdefg");
    await expect(page.locator(".narrative-empty")).toHaveCount(1);
  });

  test("the quota column fits the phone viewport with every card visible", async ({ page }) => {
    // Regression: at 800x360 the five cards plus two provider headers overflowed
    // the column and the last card was clipped off the bottom of the screen.
    await page.setViewportSize({ width: 800, height: 360 });
    await page.goto(baseUrl);
    await fetch(`${baseUrl}/api/quota/mock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        codex: { weekly: { remaining: 91 }, resets: { available: 3 } },
        claude: { fiveHour: { remaining: 59 }, weekly: { remaining: 87 } },
      }),
    });
    await expect(page.locator(".quota-card")).toHaveCount(5);

    const grid = await page.locator(".quota-grid").boundingBox();
    assert.ok(grid, "quota grid must be laid out");
    for (const key of ["codex_5h", "codex_7d", "codex_resets", "claude_5h", "claude_7d"]) {
      const box = await page.locator(`.quota-card[data-key=${key}]`).boundingBox();
      assert.ok(box, `${key} card must be laid out`);
      assert.ok(
        box.y >= grid.y - 1 && box.y + box.height <= grid.y + grid.height + 1,
        `${key} card is clipped outside the quota column`,
      );
    }
    // And the page itself never scrolls.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
    );
    assert.ok(overflow <= 0, `page overflows vertically by ${overflow}px`);
  });

  test("session labels and status words are never truncated", async ({ page }) => {
    // Regression: the elapsed timer had its own column and squeezed the label
    // to "tokenfla…" and the status to "CLAUDE · RU…" — the two pieces of text
    // the panel exists to show.
    await page.setViewportSize({ width: 800, height: 360 });
    await page.goto(baseUrl);
    await fetch(`${baseUrl}/api/hooks/claude`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "e2e-trunc", cwd: "D:/Workspace/tokenflare" }),
    });
    const card = page.locator(".instance-card[data-id='claude:e2e-trunc']");
    await expect(card).toHaveCount(1);

    for (const sel of [".instance-label", ".instance-status"]) {
      const clipped = await card.locator(sel).evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      assert.equal(clipped, false, `${sel} is truncated`);
    }
    await expect(card.locator(".instance-label")).toHaveText("tokenflare");
    await expect(card.locator(".instance-status")).toHaveText("CLAUDE · RUNNING");
  });

  test("reconnect resyncs via snapshot (page never blanks)", async ({ page }) => {
    await page.goto(baseUrl);
    await expect(page.locator(".quota-section")).toHaveCount(2);

    // Force the page's WS client to reconnect via the settings button.
    await page.evaluate(() => {
      const inp = document.getElementById("serverInput") as HTMLInputElement | null;
      // Trigger an input event to commit, then click reconnect.
      if (inp) inp.value = inp.value; // no change, but ensures value present
    });
    await page.click("#gearBtn");
    await page.click("#reconnectBtn");

    // After reconnect, the provider sections should still be present (snapshot resync).
    await expect(page.locator(".quota-section")).toHaveCount(2);
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
