import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildClaudeMetrics,
  buildCodexMetrics,
  mergeMetrics,
  sortMetrics,
} from "../src/quota/metrics.js";

test("buildCodexMetrics produces 5h, 7d, resets with correct classes", () => {
  const m = buildCodexMetrics(
    {
      fiveHour: { remaining: 85, resetAt: "2026-07-24T14:30:00Z" },
      weekly: { remaining: 45, resetAt: "2026-07-28T09:00:00Z" },
      resets: { available: 1, nextExpiresAt: "2026-07-25T00:00:00Z" },
    },
    "live",
  );
  assert.equal(m.length, 3);
  const byKey = Object.fromEntries(m.map((x) => [x.key, x]));

  assert.equal(byKey.codex_5h.window, "5h");
  assert.equal(byKey.codex_5h.quotaClass, "high");
  assert.equal(byKey.codex_5h.source, "live");
  assert.equal(byKey.codex_5h.semantics, "remaining");
  assert.ok(byKey.codex_5h.resetText?.startsWith("resets"));

  assert.equal(byKey.codex_7d.quotaClass, "medium");
  assert.equal(byKey.codex_resets.quotaClass, "medium"); // count 1 -> medium
  assert.equal(byKey.codex_resets.valueText, "1 left");
});

test("buildCodexMetrics clamps bad values", () => {
  const m = buildCodexMetrics({ fiveHour: { remaining: 150 } }, "config");
  assert.equal(m[0].percentage, 100);
  const m2 = buildCodexMetrics({ fiveHour: { remaining: -10 } }, "config");
  assert.equal(m2[0].percentage, 0);
});

test("buildClaudeMetrics produces 5h + 7d", () => {
  const m = buildClaudeMetrics(
    { fiveHour: { remaining: 38 }, weekly: { remaining: 67 } },
    "config",
  );
  assert.equal(m.length, 2);
  assert.equal(m[0].key, "claude_5h");
  assert.equal(m[0].quotaClass, "low"); // 38% remaining -> low
  assert.equal(m[1].key, "claude_7d");
  assert.equal(m[1].quotaClass, "medium"); // 67% -> medium
});

test("mergeMetrics: later wins by key", () => {
  const a = buildCodexMetrics({ fiveHour: { remaining: 85 } }, "live");
  const b = buildCodexMetrics({ fiveHour: { remaining: 12 } }, "config");
  const merged = mergeMetrics(a, b);
  const fh = merged.find((m) => m.key === "codex_5h");
  assert.equal(fh?.percentage, 12);
  assert.equal(fh?.source, "config");
});

test("sortMetrics orders: 5h, 7d, resets, claude 5h, claude 7d", () => {
  const m = [
    ...buildClaudeMetrics({ fiveHour: { remaining: 50 }, weekly: { remaining: 50 } }, "config"),
    ...buildCodexMetrics(
      { fiveHour: { remaining: 50 }, weekly: { remaining: 50 }, resets: { available: 1 } },
      "live",
    ),
  ];
  // Shuffle first.
  m.reverse();
  const sorted = sortMetrics(m);
  assert.deepEqual(
    sorted.map((x) => x.key),
    ["codex_5h", "codex_7d", "codex_resets", "claude_5h", "claude_7d"],
  );
});

test("resets count semantics: progress bar normalizes via count", () => {
  const m = buildCodexMetrics({ resets: { available: 2 } }, "live");
  // 2 of 3 -> 66.67 -> rounded to 67 for display.
  assert.equal(m[0].progressPercent, 67);
});
