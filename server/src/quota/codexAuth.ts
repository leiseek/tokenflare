/**
 * Codex OAuth credential source.
 *
 * Auto-reads the Codex CLI's auth file (~/.codex/auth.json) per the design
 * decision in §12.2. Codex CLI rotates that file itself as tokens refresh;
 * we just (re)read it on demand, so we always have fresh tokens without
 * implementing our own refresh dance in the common case.
 *
 * Falls back to an explicit `oauth` block in the server config.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CodexAuth {
  accessToken: string;
  refreshToken?: string;
  accountId?: string;
  expiresAt?: number; // epoch ms
  /** Where we got it: "authjson" | "config". */
  origin: "authjson" | "config";
}

/** Shape of ~/.codex/auth.json (the parts we care about). */
interface CodexAuthJson {
  OPENAI_API_KEY?: string | null;
  tokens?: {
    access_token?: string | null;
    refresh_token?: string | null;
    id_token?: string | null;
    account_id?: string | null;
    expires_at?: string | number | null; // OpenAI uses seconds-since-epoch string sometimes
  } | null;
  last_refresh?: string | number | null;
  [k: string]: unknown;
}

/** Resolve the default ~/.codex/auth.json path. */
export function defaultAuthJsonPath(): string {
  const home = os.homedir();
  return path.join(home, ".codex", "auth.json");
}

/** Read & parse a JSON file, returning null on any error. */
function readJsonOrNull(p: string): unknown | null {
  try {
    const txt = fs.readFileSync(p, "utf8");
    return JSON.parse(txt) as unknown;
  } catch {
    return null;
  }
}

/** Normalize the various expires_at formats OpenAI emits to epoch ms. */
function normalizeExpiry(v: string | number | null | undefined): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "number") {
    // If it looks like seconds (< 10^12), convert to ms.
    return v > 1e12 ? v : v * 1000;
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * Load Codex auth. Tries the auth.json file first (auto-read), then the
 * explicit config override. Returns null if neither yields a usable token.
 */
export function loadCodexAuth(opts: {
  autoReadAuthJson: boolean;
  authJsonPath: string | null;
  configOauth: {
    accessToken?: string;
    refreshToken?: string;
    accountId?: string;
    expiresAt?: number;
  } | null;
}): CodexAuth | null {
  // 1. Try the Codex CLI auth file.
  if (opts.autoReadAuthJson) {
    const p = opts.authJsonPath || defaultAuthJsonPath();
    const raw = readJsonOrNull(p);
    if (raw && typeof raw === "object") {
      const aj = raw as CodexAuthJson;
      const t = aj.tokens;
      const accessToken = t?.access_token ?? undefined;
      if (accessToken) {
        return {
          accessToken,
          refreshToken: t?.refresh_token ?? undefined,
          accountId: t?.account_id ?? undefined,
          expiresAt: normalizeExpiry(t?.expires_at),
          origin: "authjson",
        };
      }
    }
  }

  // 2. Fall back to explicit config oauth block.
  const cfg = opts.configOauth;
  if (cfg?.accessToken) {
    return {
      accessToken: cfg.accessToken,
      refreshToken: cfg.refreshToken,
      accountId: cfg.accountId,
      expiresAt: cfg.expiresAt,
      origin: "config",
    };
  }

  return null;
}
