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

/** Proxy config for outbound HTTP (wham fetch). null = direct. */
export interface ProxyConfig {
  /** Full proxy URL, e.g. "socks5://127.0.0.1:10808" or "http://127.0.0.1:7890". */
  url: string;
}

export interface CodexConfig {
  autoReadAuthJson: boolean;
  authJsonPath: string | null;
  pollSeconds: number;
  /**
   * Tail ~/.codex/sessions transcripts to track Codex Desktop/CLI sessions.
   * Desktop does not dispatch hooks, so this is how Codex sessions surface.
   * Default true.
   */
  watch: boolean;
  /** Watcher poll interval in ms (default 3000). */
  watchIntervalMs?: number;
  oauth: {
    accessToken?: string;
    refreshToken?: string;
    accountId?: string;
    expiresAt?: number;
  } | null;
}

export interface ClaudeConfig {
  /**
   * Read ~/.claude/.credentials.json (or the macOS Keychain) to fetch live 5h /
   * 7d usage, the same numbers Claude Code's `/usage` command shows.
   * Default true. Set false to leave Claude cards off entirely.
   */
  autoReadCredentials: boolean;
  /** Override the credentials file path. null = platform default. */
  credentialsPath: string | null;
  /** Usage poll interval in seconds (default 300). */
  pollSeconds: number;
  /** Explicit token override; normally null (the credentials file is used). */
  oauth: { accessToken?: string } | null;
  /** Display name for the Claude account shown above its quota cards.
   *  Defaults to "Claude Code". */
  accountName?: string;
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
  /** Outbound proxy for the wham fetcher. null/undefined = direct connection. */
  proxy?: ProxyConfig | null;
}

const DEFAULTS: AppConfig = {
  server: { host: "0.0.0.0", port: 7331 },
  proxy: null,
  codex: {
    autoReadAuthJson: true,
    authJsonPath: null,
    pollSeconds: 300,
    watch: true,
    watchIntervalMs: 3000,
    oauth: null,
  },
  claude: {
    autoReadCredentials: true,
    credentialsPath: null,
    pollSeconds: 300,
    oauth: null,
    accountName: "Claude Code",
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
  if (process.env.TOKENFLARE_CLAUDE_POLL) cfg.claude.pollSeconds = Number(process.env.TOKENFLARE_CLAUDE_POLL) || cfg.claude.pollSeconds;
  if (process.env.TOKENFLARE_CLAUDE_CREDENTIALS) cfg.claude.credentialsPath = String(process.env.TOKENFLARE_CLAUDE_CREDENTIALS);
  if (process.env.TOKENFLARE_CODEX_WATCH === "false" || process.env.TOKENFLARE_CODEX_WATCH === "0") cfg.codex.watch = false;
  if (process.env.TOKENFLARE_CODEX_WATCH === "true" || process.env.TOKENFLARE_CODEX_WATCH === "1") cfg.codex.watch = true;
  if (process.env.TOKENFLARE_PROXY) cfg.proxy = { url: String(process.env.TOKENFLARE_PROXY) };
  // Also honor the conventional HTTP(S)_PROXY env vars as a fallback.
  if (!cfg.proxy) {
    const hp = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    if (hp) cfg.proxy = { url: hp };
  }

  return cfg;
}

/** A config with sensitive bits stripped, safe to expose via GET /api/config. */
export function sanitizeConfigForClient(cfg: AppConfig): unknown {
  return {
    server: { port: cfg.server.port },
    codex: {
      autoReadAuthJson: cfg.codex.autoReadAuthJson,
      pollSeconds: cfg.codex.pollSeconds,
      watch: cfg.codex.watch,
      hasOauth: !!cfg.codex.oauth?.accessToken,
    },
    claude: {
      autoReadCredentials: cfg.claude.autoReadCredentials,
      pollSeconds: cfg.claude.pollSeconds,
      hasOauth: !!cfg.claude.oauth?.accessToken,
      accountName: cfg.claude.accountName,
    },
    display: cfg.display,
  };
}
