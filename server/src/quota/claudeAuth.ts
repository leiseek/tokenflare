/**
 * Claude Code OAuth credential source.
 *
 * Mirrors codexAuth.ts: Claude Code keeps its own OAuth token fresh, so we just
 * (re)read wherever it stores it and never implement a refresh dance ourselves.
 *
 * Storage location differs by platform:
 *  - Linux / Windows: ~/.claude/.credentials.json
 *  - macOS:           the login Keychain, item "Claude Code-credentials"
 *
 * Only the local user's own credentials are read, and only to ask Anthropic for
 * that same user's quota. The token itself never leaves this process.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface ClaudeAuth {
  accessToken: string;
  expiresAt?: number; // epoch ms
  /** Plan name from the credential file, e.g. "max" / "pro". */
  subscriptionType?: string;
  /** Where we got it, for logging. */
  origin: "credentials-file" | "keychain" | "config";
}

/** Shape of ~/.claude/.credentials.json (the parts we use). */
interface ClaudeCredentialsJson {
  claudeAiOauth?: {
    accessToken?: string | null;
    refreshToken?: string | null;
    expiresAt?: number | null;
    scopes?: string[] | null;
    subscriptionType?: string | null;
  } | null;
  [k: string]: unknown;
}

/** Resolve the default ~/.claude/.credentials.json path. */
export function defaultCredentialsPath(): string {
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

/** Read the macOS Keychain item Claude Code uses. Returns null off macOS. */
function readKeychain(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 },
    ).trim();
  } catch {
    return null;
  }
}

/** Parse a credentials blob into a ClaudeAuth, or null if unusable. */
function parseCredentials(text: string, origin: ClaudeAuth["origin"]): ClaudeAuth | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const oauth = (raw as ClaudeCredentialsJson).claudeAiOauth;
  const accessToken = oauth?.accessToken;
  if (!accessToken) return null;
  return {
    accessToken,
    expiresAt: typeof oauth?.expiresAt === "number" ? oauth.expiresAt : undefined,
    subscriptionType: oauth?.subscriptionType ?? undefined,
    origin,
  };
}

/**
 * Load Claude Code auth: credentials file first, then the macOS Keychain, then
 * an explicit config override. Returns null if none yields a usable token.
 */
export function loadClaudeAuth(opts: {
  autoReadCredentials: boolean;
  credentialsPath: string | null;
  configOauth: { accessToken?: string } | null;
}): ClaudeAuth | null {
  if (opts.autoReadCredentials) {
    const p = opts.credentialsPath || defaultCredentialsPath();
    try {
      const hit = parseCredentials(fs.readFileSync(p, "utf8"), "credentials-file");
      if (hit) return hit;
    } catch {
      /* fall through to the keychain */
    }

    const kc = readKeychain();
    if (kc) {
      const hit = parseCredentials(kc, "keychain");
      if (hit) return hit;
    }
  }

  if (opts.configOauth?.accessToken) {
    return { accessToken: opts.configOauth.accessToken, origin: "config" };
  }
  return null;
}
