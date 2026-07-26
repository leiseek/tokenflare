/**
 * Claude Code usage parsing tests.
 *
 * The payload below is the shape returned by a real `/api/oauth/usage` call
 * (values changed). It is the source of truth for the 5h / 7d cards, replacing
 * the hand-typed config percentages the display used to show.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseUsagePayload, fetchClaudeUsage } from "../src/quota/claudeUsage.ts";
import { buildClaudeMetrics } from "../src/quota/metrics.ts";

const LIVE_PAYLOAD = {
  five_hour: { utilization: 28.0, resets_at: "2026-07-26T11:59:59.297155+00:00" },
  seven_day: null,
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 28,
      severity: "normal",
      resets_at: "2026-07-26T11:59:59.297155+00:00",
      scope: null,
      is_active: true,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 9,
      severity: "normal",
      resets_at: "2026-07-27T00:59:59.297402+00:00",
      scope: { model: { id: null, display_name: "Fable" } },
      is_active: false,
    },
  ],
};

test("parses the live payload into remaining-percent windows", () => {
  const out = parseUsagePayload(LIVE_PAYLOAD);
  // The API reports USED percent; the cards show REMAINING.
  assert.equal(out.fiveHour?.remaining, 72);
  assert.equal(out.weekly?.remaining, 91);
  assert.equal(out.fiveHour?.resetAt, "2026-07-26T11:59:59.297155+00:00");
  assert.equal(out.weekly?.resetAt, "2026-07-27T00:59:59.297402+00:00");
});

test("the weekly group reports its worst scoped limit", () => {
  // Several per-model weekly rows; the one closest to its cap is the one that
  // will actually stop you, so that is what the card must show.
  const out = parseUsagePayload({
    limits: [
      { group: "weekly", percent: 9, resets_at: "2026-07-27T00:00:00Z" },
      { group: "weekly", percent: 64, resets_at: "2026-07-28T00:00:00Z" },
      { group: "weekly", percent: 30, resets_at: "2026-07-29T00:00:00Z" },
    ],
  });
  assert.equal(out.weekly?.remaining, 36);
  assert.equal(out.weekly?.resetAt, "2026-07-28T00:00:00Z");
});

test("falls back to the top-level five_hour object when limits[] is absent", () => {
  const out = parseUsagePayload({
    five_hour: { utilization: 40, resets_at: "2026-07-26T11:00:00Z" },
    seven_day: { utilization: 12, resets_at: "2026-07-30T11:00:00Z" },
  });
  assert.equal(out.fiveHour?.remaining, 60);
  assert.equal(out.weekly?.remaining, 88);
});

test("an unrecognized payload yields no windows, never zeros", () => {
  // A shape change at Anthropic must show "not connected", not a fake 0%.
  for (const bad of [null, undefined, {}, { limits: [] }, "nope", 42]) {
    const out = parseUsagePayload(bad);
    assert.equal(out.fiveHour, undefined);
    assert.equal(out.weekly, undefined);
  }
});

test("cards carry reset text and the remaining-percent class", () => {
  const cards = buildClaudeMetrics(parseUsagePayload(LIVE_PAYLOAD), "live", "Claude Code · max");
  assert.equal(cards.length, 2);
  const [fiveHour, weekly] = cards;
  assert.equal(fiveHour.key, "claude_5h");
  assert.equal(fiveHour.valueText, "72%");
  assert.equal(fiveHour.semantics, "remaining");
  assert.equal(fiveHour.accountName, "Claude Code · max");
  assert.ok(fiveHour.nextResetAt, "5h card must expose a reset timestamp");
  assert.equal(weekly.key, "claude_7d");
  assert.equal(weekly.valueText, "91%");
  assert.equal(weekly.quotaClass, "high");
});

test("a failed fetch returns no data instead of placeholder numbers", async () => {
  const result = await fetchClaudeUsage({
    autoReadCredentials: false,
    credentialsPath: null,
    configOauth: { accessToken: "tok" },
    fetchImpl: (async () =>
      new Response("nope", { status: 401 })) as unknown as typeof fetch,
  });
  assert.equal(result.ok, false);
  assert.equal(result.data, null);
  assert.match(result.error ?? "", /auth rejected/);
});

test("no credentials at all is reported, not guessed around", async () => {
  const result = await fetchClaudeUsage({
    autoReadCredentials: false,
    credentialsPath: null,
    configOauth: null,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /no claude credentials/);
});

test("a live fetch carries the token and returns parsed windows", async () => {
  let seenAuth: string | null = null;
  const result = await fetchClaudeUsage({
    autoReadCredentials: false,
    credentialsPath: null,
    configOauth: { accessToken: "tok-123" },
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      seenAuth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify(LIVE_PAYLOAD), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });
  assert.equal(result.ok, true);
  assert.equal(seenAuth, "Bearer tok-123");
  assert.equal(result.data?.fiveHour?.remaining, 72);
});
