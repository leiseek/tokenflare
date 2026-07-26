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
 * Parse the wham usage payload into our CodexQuotaInput.
 *
 * The REAL wham /usage shape (verified against a live Codex CLI account) is:
 *   {
 *     "rate_limit": {
 *       "allowed": true,
 *       "primary_window":  { "used_percent": 55, "limit_window_seconds": 604800,
 *                            "reset_after_seconds": 567428, "reset_at": 1785424812 },
 *       "secondary_window": null | { ...same shape... }
 *     },
 *     "rate_limit_reset_credits": { "available_count": 4, "applicable_available_count": 0 }
 *   }
 *
 * Notes:
 *  - `primary_window` is typically the 7-day window (limit_window_seconds=604800).
 *    `secondary_window` (when present) is the 5-hour window.
 *  - Fields are `used_percent` (0..100, USED not remaining) — we convert to remaining.
 *  - `reset_at` is a Unix timestamp in SECONDS (not ms).
 *  - Reset credits live in the SAME /usage response, no separate request needed.
 *
 * We keep defensive fallbacks for the older `usage_windows[]` shape too.
 */
function parseUsagePayload(usage: unknown, resets: unknown): CodexQuotaInput {
  const input: CodexQuotaInput = {};
  if (!usage || typeof usage !== "object") return input;
  const u = usage as Record<string, unknown>;

  // ---- New shape: rate_limit.{primary,secondary}_window ----
  const rl = u.rate_limit;
  if (rl && typeof rl === "object") {
    const r = rl as Record<string, unknown>;
    const pw = r.primary_window;
    const sw = r.secondary_window;
    if (pw && typeof pw === "object") {
      const win = parseWindow(pw as Record<string, unknown>);
      if (win) assignWindow(input, win, "primary", false);
    }
    if (sw && typeof sw === "object") {
      const win = parseWindow(sw as Record<string, unknown>);
      if (win) assignWindow(input, win, "secondary", false);
    }
  }

  // ---- Reset credits (in the usage response) ----
  //
  // Prefer `available_count`: that is how many reset credits the account still
  // holds, which is what the card claims to show. `applicable_available_count`
  // is how many can be redeemed *right now* and is 0 whenever you are not
  // currently rate-limited — reading it made a healthy account with 3 credits
  // display "none left" in red.
  const rrc = u.rate_limit_reset_credits;
  if (rrc && typeof rrc === "object") {
    const c = rrc as Record<string, unknown>;
    const available =
      typeof c.available_count === "number"
        ? c.available_count
        : typeof c.applicable_available_count === "number"
          ? c.applicable_available_count
          : 0;
    input.resets = { available, nextExpiresAt: null };
  }

  // ---- Legacy fallback: usage_windows[] array (older API shape) ----
  if (!input.fiveHour && !input.weekly) {
    const windows = Array.isArray(u.usage_windows) ? u.usage_windows : Array.isArray(u.windows) ? u.windows : [];
    for (const w of windows) {
      if (!w || typeof w !== "object") continue;
      const win = parseWindow(w as Record<string, unknown>);
      if (!win) continue;
      const kind = String((w as Record<string, unknown>).window_kind ?? (w as Record<string, unknown>).kind ?? "");
      assignWindow(input, win, kind, true);
    }
  }

  // ---- /rate-limit-reset-credits: the per-credit list ----
  //
  // This is where expiry dates live — the usage payload only carries counts.
  // We always merge it in (not just as a fallback) so the Resets card can say
  // when the next credit lapses; the count from /usage wins when both exist.
  if (resets && typeof resets === "object") {
    const r = resets as Record<string, unknown>;
    const credits = Array.isArray(r.reset_credits)
      ? r.reset_credits
      : Array.isArray(r.credits)
        ? r.credits
        : [];
    let available = 0;
    let nextExpiresAt: number | null = null;
    for (const credit of credits) {
      if (!credit || typeof credit !== "object") continue;
      const c = credit as Record<string, unknown>;
      const status = String(c.status ?? c.raw_status ?? "").toLowerCase();
      if (status && status !== "available" && status !== "active") continue;
      available += 1;
      const expiresAt = toMs(c.expires_at ?? c.expiresAt ?? null);
      if (expiresAt !== null && (nextExpiresAt === null || expiresAt < nextExpiresAt)) {
        nextExpiresAt = expiresAt;
      }
    }
    // Also honour a top-level available_count if the list was empty/omitted.
    if (!available && typeof r.available_count === "number") available = r.available_count;
    input.resets = input.resets
      ? { available: input.resets.available, nextExpiresAt }
      : { available, nextExpiresAt };
  }

  return input;
}

interface ParsedWindow {
  remaining: number;
  resetAtMs: number | null;
  seconds: number | null;
}

/** Parse both current used-percent windows and legacy remaining-percent windows. */
function parseWindow(w: Record<string, unknown>): ParsedWindow | null {
  // Prefer used_percent; fall back to remaining_percent (convert).
  let remaining: number | null = null;
  if (w.used_percent !== undefined) remaining = 100 - readPercent(w.used_percent);
  else if (w.remaining_percent !== undefined) remaining = readPercent(w.remaining_percent);
  if (remaining === null) return null;

  const resetAt = w.reset_at ?? w.resets_at ?? w.resetAt ?? null;
  const rawSeconds = Number(w.limit_window_seconds);
  return {
    remaining: Math.max(0, Math.min(100, remaining)),
    resetAtMs: toMs(resetAt),
    seconds: Number.isFinite(rawSeconds) && rawSeconds > 0 ? rawSeconds : null,
  };
}

/** Assign a parsed window to the 5h or 7d bucket based on its kind + window length. */
function assignWindow(
  input: CodexQuotaInput,
  win: ParsedWindow,
  kind: string,
  legacy: boolean,
): void {
  const k = String(kind).toLowerCase();
  // The window length is authoritative when the API reports it: anything
  // shorter than a day is the 5h window.
  //
  // Without it we fall back to the name. In the current shape `primary_window`
  // is the 7-day window (limit_window_seconds=604800) and `secondary_window`
  // is the 5-hour one — the opposite of what the name suggests, so this branch
  // must not treat "primary" as 5h.
  const isFiveHour =
    win.seconds !== null
      ? win.seconds < 24 * 60 * 60
      : k.includes("5h") || k.includes("hour") || (legacy ? k === "primary" : k === "secondary");
  if (isFiveHour) {
    input.fiveHour = { remaining: win.remaining, resetAt: win.resetAtMs };
  } else {
    input.weekly = { remaining: win.remaining, resetAt: win.resetAtMs };
  }
}

function readPercent(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return n >= 0 && n <= 1 ? n * 100 : Math.max(0, Math.min(100, n));
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
