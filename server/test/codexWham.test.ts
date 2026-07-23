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
