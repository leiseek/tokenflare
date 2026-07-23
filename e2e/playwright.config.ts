import { defineConfig } from "@playwright/test";

/**
 * Playwright config for Vibe Display e2e.
 *
 * The server is started by a global setup that boots `tsx server/src/index.ts`
 * on a free port and points the tests at it. Landscape phone viewport.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    // Headless; landscape phone-ish viewport.
    headless: true,
    viewport: { width: 800, height: 360 },
    ignoreHTTPSErrors: true,
  },
  reporter: [["list"]],
});
