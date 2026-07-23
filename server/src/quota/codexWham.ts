/**
 * Codex "wham" usage fetcher.
 *
 * Port of new-api's codex_wham_usage.go to TypeScript using Node's built-in
 * fetch. Hits OpenAI's backend-api/wham endpoints with the Codex CLI originator
 * headers to read the live 5h/weekly quota windows and rate-limit reset credits.
 *
 * On auth failure we re-read ~/.codex/auth.json (Codex CLI refreshes it itself);
 * if that doesn't help we return null and let the caller fall back to config.
 */
import { loadCodexAuth, type CodexAuth } from "./codexAuth.js";
import type { CodexQuotaInput } from "./metrics.js";

const WHAM_BASE = "https://chatgpt.com/backend-api/wham";
const COMMON_HEADERS = {
  Accept: "application/json",
  originator: "codex_cli_rs",
} as const;

/** Options for fetchUsage. */
export interface FetchUsageOpts {
  autoReadAuthJson: boolean;
  authJsonPath: string | null;
  configOauth: {
    accessToken?: string;
    refreshToken?: string;
    accountId?: string;
    expiresAt?: number;
  } | null;
  /** Optional injected fetch (for tests). */
  fetchImpl?: typeof fetch;
  /** Abort signal. */
  signal?: AbortSignal;
}

export interface FetchUsageResult {
  ok: boolean;
  data: CodexQuotaInput | null;
  /** Non-empty when ok=false; reason for logging only. */
  error?: string;
}

/** Fetch live Codex usage + reset credits from wham. */
export async function fetchCodexUsage(opts: FetchUsageOpts): Promise<FetchUsageResult> {
  const f = opts.fetchImpl ?? fetch;

  const auth = loadCodexAuth({
    autoReadAuthJson: opts.autoReadAuthJson,
    authJsonPath: opts.authJsonPath,
    configOauth: opts.configOauth,
  });
  if (!auth) {
    return { ok: false, data: null, error: "no codex auth available" };
  }

  // Try once; on 401/403, re-read auth.json (Codex CLI may have rotated) and retry once.
  for (let attempt = 0; attempt < 2; attempt++) {
    const refreshed: CodexAuth =
      attempt === 1
        ? loadCodexAuth({
            autoReadAuthJson: opts.autoReadAuthJson,
            authJsonPath: opts.authJsonPath,
            configOauth: opts.configOauth,
          }) ?? auth
        : auth;
    try {
      const [usage, resets] = await Promise.all([
        fetchWhamJson(f, `${WHAM_BASE}/usage`, refreshed, opts.signal),
        fetchWhamJson(f, `${WHAM_BASE}/rate-limit-reset-credits`, refreshed, opts.signal),
      ]);

      if (usage.status === 401 || usage.status === 403) {
        if (attempt === 0) continue;
        return { ok: false, data: null, error: `usage auth failed (${usage.status})` };
      }
      if (!usage.ok) {
        return { ok: false, data: null, error: `usage http ${usage.status}` };
      }

      const data = parseUsagePayload(usage.json, resets.ok ? resets.json : null);
      return { ok: true, data };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, data: null, error: `fetch threw: ${msg}` };
    }
  }

  return { ok: false, data: null, error: "exhausted retries" };
}

/** Fetch + parse JSON from a wham endpoint. */
async function fetchWhamJson(
  f: typeof fetch,
  url: string,
  auth: CodexAuth,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const headers: Record<string, string> = {
    ...COMMON_HEADERS,
    Authorization: `Bearer ${auth.accessToken}`,
  };
  if (auth.accountId) headers["chatgpt-account-id"] = auth.accountId;

  const res = await f(url, { headers, signal });
  const ok = res.ok;
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok, status: res.status, json };
}

/**
 * Parse the wham usage + reset-credits payloads into our CodexQuotaInput.
 *
 * The wham usage shape is roughly:
 *   { "usage_windows": [ { "window_kind":"primary"|"secondary", "started_at":..,
 *       "resets_at":.., "limit":.., "used":.., "remaining_percent":.. }, ... ] }
 * We read whichever window reports a "primary" kind as the 5h window, and
 * "secondary" (weekly) as the 7d window. We're defensive: any missing field
 * just omits that metric.
 */
function parseUsagePayload(usage: unknown, resets: unknown): CodexQuotaInput {
  const input: CodexQuotaInput = {};

  if (usage && typeof usage === "object") {
    const u = usage as Record<string, unknown>;
    const windows = Array.isArray(u.usage_windows) ? u.usage_windows : Array.isArray(u.windows) ? u.windows : [];
    for (const w of windows) {
      if (!w || typeof w !== "object") continue;
      const win = w as Record<string, unknown>;
      const kind = String(win.window_kind ?? win.kind ?? "");
      const remaining = readPercent(win.remaining_percent ?? win.percent_remaining ?? win.remaining);
      const resetsAt = win.resets_at ?? win.reset_at ?? win.resetAt ?? null;
      if (kind === "primary") {
        input.fiveHour = { remaining, resetAt: resetsAt as number | string | null };
      } else if (kind === "secondary") {
        input.weekly = { remaining, resetAt: resetsAt as number | string | null };
      }
    }
    // Some payloads also expose top-level fields as a fallback.
    if (!input.fiveHour && u.primary_remaining_percent !== undefined) {
      input.fiveHour = {
        remaining: readPercent(u.primary_remaining_percent),
        resetAt: (u.primary_resets_at ?? null) as number | string | null,
      };
    }
  }

  if (resets && typeof resets === "object") {
    const r = resets as Record<string, unknown>;
    const arr = Array.isArray(r.reset_credits) ? r.reset_credits : Array.isArray(r.credits) ? r.credits : null;
    let available = 0;
    let nextExpiresMs: number | null = null;
    if (arr) {
      for (const c of arr) {
        if (!c || typeof c !== "object") continue;
        const cr = c as Record<string, unknown>;
        const status = String(cr.status ?? cr.raw_status ?? "").toLowerCase();
        const isAvailable = status === "" || status === "available" || status === "active";
        if (!isAvailable) continue;
        available += 1;
        const exp = cr.expires_at ?? cr.expiresAt ?? null;
        const expMs = toMs(exp);
        if (expMs !== null && (nextExpiresMs === null || expMs < nextExpiresMs)) {
          nextExpiresMs = expMs;
        }
      }
    } else if (typeof r.reset_credits_available === "number") {
      available = r.reset_credits_available;
      nextExpiresMs = toMs(r.reset_credits_next_expires_at ?? null);
    }
    input.resets = { available, nextExpiresAt: nextExpiresMs };
  }

  return input;
}

function readPercent(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  // wham may return 0..1 or 0..100; normalize to 0..100.
  if (n >= 0 && n <= 1) return n * 100;
  return Math.max(0, Math.min(100, n));
}

function toMs(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}
