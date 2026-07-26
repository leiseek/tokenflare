import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fetchCodexUsage } from "../src/quota/codexWham.js";

/** Build a fake fetch that responds per-URL with canned JSON. */
function fakeFetch(routes: Record<string, { status?: number; json: unknown }>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString();
    const route = Object.entries(routes).find(([k]) => u.includes(k));
    if (!route) return new Response("not found", { status: 404 });
    const { status = 200, json } = route[1];
    return new Response(JSON.stringify(json), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

test("fetchCodexUsage parses usage_windows + reset_credits", async () => {
  const result = await fetchCodexUsage({
    autoReadAuthJson: false,
    authJsonPath: null,
    configOauth: { accessToken: "tok", accountId: "acc" },
    fetchImpl: fakeFetch({
      "/usage": {
        json: {
          usage_windows: [
            { window_kind: "primary", remaining_percent: 78, resets_at: "2026-07-24T14:30:00Z" },
            { window_kind: "secondary", remaining_percent: 91, resets_at: "2026-07-28T09:00:00Z" },
          ],
        },
      },
      "/rate-limit-reset-credits": {
        json: {
          reset_credits: [
            { status: "available", expires_at: "2026-07-25T00:00:00Z" },
            { status: "available", expires_at: "2026-07-26T00:00:00Z" },
            { status: "redeemed" }, // not counted
          ],
        },
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.ok(result.data);
  assert.equal(result.data!.fiveHour?.remaining, 78);
  assert.equal(result.data!.weekly?.remaining, 91);
  assert.equal(result.data!.resets?.available, 2);
});

test("fetchCodexUsage returns null when no auth available", async () => {
  const result = await fetchCodexUsage({
    autoReadAuthJson: false,
    authJsonPath: null,
    configOauth: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.data, null);
});

test("fetchCodexUsage handles 401 by reporting auth failure", async () => {
  const result = await fetchCodexUsage({
    autoReadAuthJson: false,
    authJsonPath: null,
    configOauth: { accessToken: "bad" },
    fetchImpl: fakeFetch({
      "/usage": { status: 401, json: { error: "unauthorized" } },
      "/rate-limit-reset-credits": { status: 401, json: { error: "unauthorized" } },
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /auth failed|401|exhausted/);
});

test("fetchCodexUsage handles network errors gracefully", async () => {
  const throwingFetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
  const result = await fetchCodexUsage({
    autoReadAuthJson: false,
    authJsonPath: null,
    configOauth: { accessToken: "tok" },
    fetchImpl: throwingFetch,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /ECONNREFUSED|threw/);
});

test("fetchCodexUsage normalizes 0..1 remaining to 0..100", async () => {
  const result = await fetchCodexUsage({
    autoReadAuthJson: false,
    authJsonPath: null,
    configOauth: { accessToken: "tok" },
    fetchImpl: fakeFetch({
      "/usage": {
        json: {
          usage_windows: [
            { window_kind: "primary", remaining_percent: 0.78 }, // 0..1 form
          ],
        },
      },
      "/rate-limit-reset-credits": { json: {} },
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.data!.fiveHour?.remaining, 78);
});

test("fetchCodexUsage parses current rate_limit windows by duration", async () => {
  const result = await fetchCodexUsage({
    autoReadAuthJson: false,
    authJsonPath: null,
    configOauth: { accessToken: "tok" },
    fetchImpl: fakeFetch({
      "/usage": {
        json: {
          rate_limit: {
            primary_window: {
              used_percent: 57,
              limit_window_seconds: 604800,
              reset_at: 1785424812,
            },
            secondary_window: {
              used_percent: 18,
              limit_window_seconds: 18000,
              reset_at: 1784823612,
            },
          },
          rate_limit_reset_credits: {
            available_count: 4,
            applicable_available_count: 1,
          },
        },
      },
      "/rate-limit-reset-credits": { json: {} },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.data!.fiveHour?.remaining, 82);
  assert.equal(result.data!.weekly?.remaining, 43);
  assert.equal(result.data!.weekly?.resetAt, 1785424812000);
  // `available_count` is what the account HOLDS; `applicable_available_count`
  // is only non-zero while you are actually rate-limited, so reading it showed
  // "none left" for a healthy account.
  assert.equal(result.data!.resets?.available, 4);
});

test("reset credits: count comes from /usage, expiry from the credits list", async () => {
  const result = await fetchCodexUsage({
    autoReadAuthJson: false,
    authJsonPath: null,
    configOauth: { accessToken: "tok" },
    fetchImpl: fakeFetch({
      "/usage": {
        json: {
          rate_limit: { primary_window: { used_percent: 6, limit_window_seconds: 604800 } },
          rate_limit_reset_credits: { available_count: 3, applicable_available_count: 0 },
        },
      },
      "/rate-limit-reset-credits": {
        json: {
          credits: [
            { status: "available", expires_at: "2026-08-12T18:00:41.290796Z" },
            { status: "available", expires_at: "2026-07-27T00:00:47.338246Z" },
            { status: "redeemed", expires_at: "2026-07-01T00:00:00.000Z" },
          ],
          available_count: 3,
        },
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.data!.resets?.available, 3);
  // Soonest expiry among the still-available credits (the redeemed one is skipped).
  assert.equal(result.data!.resets?.nextExpiresAt, Date.parse("2026-07-27T00:00:47.338246Z"));
});
