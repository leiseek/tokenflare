/**
 * Config loading. Reads config/tokenflare.config.json (relative to the
 * workspace root) with env overrides. Bores even with a missing/partial file
 * — every section has defaults so the server never refuses to boot.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export interface ServerConfig {
  host: string;
  port: number;
}

export interface CodexConfig {
  autoReadAuthJson: boolean;
  authJsonPath: string | null;
  pollSeconds: number;
  oauth: {
    accessToken?: string;
    refreshToken?: string;
    accountId?: string;
    expiresAt?: number;
  } | null;
  fallback: {
    fiveHour?: { remaining?: number; resetAt?: number | string | null };
    weekly?: { remaining?: number; resetAt?: number | string | null };
    resets?: { available?: number; nextExpiresAt?: number | string | null };
  };
}

export interface ClaudeConfig {
  fallback: {
    fiveHour?: { remaining?: number };
    weekly?: { remaining?: number };
  };
}

export interface DisplayConfig {
  defaultTheme: string;
  defaultFont: string;
  defaultBackground: string;
  defaultReducedMotion: boolean;
}

export interface AppConfig {
  server: ServerConfig;
  codex: CodexConfig;
  claude: ClaudeConfig;
  display: DisplayConfig;
}

const DEFAULTS: AppConfig = {
  server: { host: "0.0.0.0", port: 7331 },
  codex: {
    autoReadAuthJson: true,
    authJsonPath: null,
    pollSeconds: 300,
    oauth: null,
    fallback: {
      fiveHour: { remaining: 80 },
      weekly: { remaining: 91 },
      resets: { available: 2 },
    },
  },
  claude: {
    fallback: {
      fiveHour: { remaining: 38 },
      weekly: { remaining: 67 },
    },
  },
  display: {
    defaultTheme: "neon-dark",
    defaultFont: "jetbrains",
    defaultBackground: "mesh",
    defaultReducedMotion: false,
  },
};

/** Resolve the config file path. Looks for <root>/config/*.config.json. */
function resolveConfigPath(): string | null {
  // Explicit override wins (used by tests + alternate installs).
  if (process.env.TOKENFLARE_CONFIG && fs.existsSync(process.env.TOKENFLARE_CONFIG)) {
    return process.env.TOKENFLARE_CONFIG;
  }
  // Walk up from cwd to find a config dir, else use the workspace root.
  const candidates = [
    path.resolve(process.cwd(), "config", "tokenflare.config.json"),
    path.resolve(process.cwd(), "tokenflare.config.json"),
    // When run from server/ during dev:
    path.resolve(process.cwd(), "..", "config", "tokenflare.config.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** Deep-merge two plain objects (b wins). Arrays replaced, not concatenated. */
function merge<T>(a: T, b: unknown): T {
  if (Array.isArray(b)) return b as T;
  if (b && typeof b === "object" && a && typeof a === "object") {
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
      out[k] = k in out ? merge((out as Record<string, unknown>)[k], v) : v;
    }
    return out as T;
  }
  return (b ?? a) as T;
}

/** Load config from file + env. Never throws. */
export function loadConfig(): AppConfig {
  let fileConfig: unknown = {};
  const p = resolveConfigPath();
  if (p) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      fileConfig = {};
    }
  }

  let cfg = merge(DEFAULTS, fileConfig);

  // Env overrides.
  if (process.env.TOKENFLARE_HOST) cfg.server.host = String(process.env.TOKENFLARE_HOST);
  if (process.env.TOKENFLARE_PORT) cfg.server.port = Number(process.env.TOKENFLARE_PORT) || cfg.server.port;
  if (process.env.TOKENFLARE_CODEX_POLL) cfg.codex.pollSeconds = Number(process.env.TOKENFLARE_CODEX_POLL) || cfg.codex.pollSeconds;

  return cfg;
}

/** A config with sensitive bits stripped, safe to expose via GET /api/config. */
export function sanitizeConfigForClient(cfg: AppConfig): unknown {
  return {
    server: { port: cfg.server.port },
    codex: {
      autoReadAuthJson: cfg.codex.autoReadAuthJson,
      pollSeconds: cfg.codex.pollSeconds,
      hasOauth: !!cfg.codex.oauth?.accessToken,
      fallback: cfg.codex.fallback,
    },
    claude: { fallback: cfg.claude.fallback },
    display: cfg.display,
  };
}
