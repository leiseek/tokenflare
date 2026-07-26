/**
 * Claude Code usage fetcher.
 *
 * Reads the same 5h / 7d limit windows the `/usage` command shows, from
 * Anthropic's OAuth usage endpoint, using the local Claude Code credentials.
 *
 * This replaces the old hand-typed `claude.fallback` percentages in the config
 * file, which were the "placeholder numbers" problem: they looked like live
 * data but were whatever the user last typed.
 *
 * NOTE: `/api/oauth/usage` is the endpoint Claude Code itself calls; it is not
 * a documented public API and its shape may change. Every field is read
 * defensively and any failure degrades to "no cards" rather than fake numbers.
 *
 * Verified response shape:
 *   {
 *     "five_hour": { "utilization": 28.0, "resets_at": "2026-07-26T11:59:59Z" },
 *     "seven_day": null,
 *     "limits": [
 *       { "kind":"session",       "group":"session", "percent":28, "resets_at":"…", "is_active":true  },
 *       { "kind":"weekly_scoped", "group":"weekly",  "percent":9,  "resets_at":"…", "is_active":false,
 *         "scope": { "model": { "display_name": "Fable" } } }
 *     ]
 *   }
 *
 * `percent` / `utilization` are USED percentages; we convert to remaining.
 * The weekly group can hold several scoped rows (per model); we surface the
 * highest used percentage, since that is the limit that bites first.
 */
import { loadClaudeAuth } from "./claudeAuth.js";
import type { ClaudeQuotaInput } from "./metrics.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** Headers Claude Code sends. `anthropic-beta` gates the OAuth scope. */
const COMMON_HEADERS = {
  Accept: "application/json",
  "anthropic-beta": "oauth-2025-04-20",
  "User-Agent": "tokenflare (+https://github.com/leiseek/tokenflare)",
  "x-app": "cli",
} as const;

export interface FetchClaudeUsageOpts {
  autoReadCredentials: boolean;
  credentialsPath: string | null;
  configOauth: { accessToken?: string } | null;
  /** Optional injected fetch (for tests / proxying). */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface FetchClaudeUsageResult {
  ok: boolean;
  data: ClaudeQuotaInput | null;
  /** Plan name from the credentials file, e.g. "max". */
  plan?: string;
  /** Non-empty when ok=false; for logging only. */
  error?: string;
}

/** Fetch live Claude Code 5h / 7d usage. */
export async function fetchClaudeUsage(
  opts: FetchClaudeUsageOpts,
): Promise<FetchClaudeUsageResult> {
  const f = opts.fetchImpl ?? fetch;

  // Re-read on every poll: Claude Code rotates the token in place, so a stale
  // in-memory copy is the usual cause of a sudden 401.
  const auth = loadClaudeAuth({
    autoReadCredentials: opts.autoReadCredentials,
    credentialsPath: opts.credentialsPath,
    configOauth: opts.configOauth,
  });
  if (!auth) {
    return { ok: false, data: null, error: "no claude credentials (run `claude` and log in)" };
  }

  try {
    const res = await f(USAGE_URL, {
      headers: { ...COMMON_HEADERS, Authorization: `Bearer ${auth.accessToken}` },
      signal: opts.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        data: null,
        error:
          res.status === 401 || res.status === 403
            ? `auth rejected (${res.status}) — token expired or region blocked`
            : `http ${res.status}`,
      };
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      return { ok: false, data: null, error: "response was not JSON" };
    }
    return { ok: true, data: parseUsagePayload(json), plan: auth.subscriptionType };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, data: null, error: `fetch threw: ${msg}` };
  }
}

/** One row of the `limits[]` array, after defensive reading. */
interface LimitRow {
  group: string;
  usedPercent: number;
  resetsAt: string | null;
}

/** Parse the usage payload into our provider-neutral shape. */
export function parseUsagePayload(usage: unknown): ClaudeQuotaInput {
  const out: ClaudeQuotaInput = {};
  if (!usage || typeof usage !== "object") return out;
  const u = usage as Record<string, unknown>;

  // ---- Preferred source: the `limits[]` array ----
  const rows: LimitRow[] = [];
  if (Array.isArray(u.limits)) {
    for (const raw of u.limits) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const pct = readPercent(r.percent);
      if (pct === null) continue;
      rows.push({
        group: String(r.group ?? r.kind ?? "").toLowerCase(),
        usedPercent: pct,
        resetsAt: typeof r.resets_at === "string" ? r.resets_at : null,
      });
    }
  }

  const session = worstOf(rows, (g) => g === "session" || g.includes("five") || g.includes("5h"));
  if (session) {
    out.fiveHour = { remaining: 100 - session.usedPercent, resetAt: session.resetsAt };
  }
  const weekly = worstOf(rows, (g) => g.startsWith("weekly") || g.includes("seven") || g.includes("7d"));
  if (weekly) {
    out.weekly = { remaining: 100 - weekly.usedPercent, resetAt: weekly.resetsAt };
  }

  // ---- Fallback: the top-level five_hour / seven_day objects ----
  if (!out.fiveHour) {
    const w = readWindow(u.five_hour);
    if (w) out.fiveHour = w;
  }
  if (!out.weekly) {
    const w = readWindow(u.seven_day);
    if (w) out.weekly = w;
  }

  return out;
}

/** The row with the highest USED percentage in a group (the binding limit). */
function worstOf(rows: LimitRow[], matches: (group: string) => boolean): LimitRow | null {
  let best: LimitRow | null = null;
  for (const r of rows) {
    if (!matches(r.group)) continue;
    if (!best || r.usedPercent > best.usedPercent) best = r;
  }
  return best;
}

/** Read a top-level `{ utilization, resets_at }` window object. */
function readWindow(v: unknown): { remaining: number; resetAt: string | null } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const used = readPercent(o.utilization);
  if (used === null) return null;
  return {
    remaining: 100 - used,
    resetAt: typeof o.resets_at === "string" ? o.resets_at : null,
  };
}

/** Read a 0..100 (or 0..1) percentage, or null if absent/unparseable. */
function readPercent(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  // Anthropic reports 0..100; tolerate a 0..1 fraction just in case.
  const pct = n > 0 && n <= 1 ? n * 100 : n;
  return Math.max(0, Math.min(100, pct));
}
