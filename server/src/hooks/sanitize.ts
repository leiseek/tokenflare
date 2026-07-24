/**
 * Edge content sanitizer.
 *
 * Ported from pulse-island's parse_codex_hook / contains_secret_key_token:
 * keep only an allow-list of fields, hard-reject anything that smells like a
 * secret. The raw hook JSON (which may contain prompts/transcripts/credentials)
 * never travels past this function.
 */
import path from "node:path";

/** Keys we KEEP from a raw Codex hook payload. */
const CODEX_ALLOW = new Set([
  "session_id",
  "hook_event_name",
  "cwd",
  "transcript_path", // used ONLY to derive a label, dropped after basename
]);

/** Keys we KEEP from a raw Claude Code hook payload. */
const CLAUDE_ALLOW = new Set([
  "session_id",
  "hook_event_name",
  "cwd",
  "transcript_path",
]);

/** Substrings that, if found in any key or string value, cause a hard reject. */
const SECRET_MARKERS = [
  "api_key",
  "apikey",
  "secret",
  "password",
  "credential",
  "bearer",
  "authorization",
  "access_token",
  "refresh_token",
  "id_token",
  "x-api-key",
];

export type SanitizeResult =
  | {
      ok: true;
      data: {
        sessionId: string;
        eventName: string | undefined;
        cwd: string | undefined;
        transcriptPath: string | undefined;
      };
    }
  | { ok: false; reason: string };

/** Lowercase a value for marker matching without losing the original. */
function asString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/** Reject if any key or string value contains a secret marker. */
function containsSecret(raw: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(raw)) {
    const lk = key.toLowerCase();
    if (SECRET_MARKERS.some((m) => lk.includes(m))) return key;

    // session_id legitimately contains "id"; it's allow-listed, don't scan its value.
    if (key === "session_id") continue;

    const s = asString(value);
    if (s !== null) {
      const ls = s.toLowerCase();
      const hit = SECRET_MARKERS.find((m) => ls.includes(m));
      if (hit) return `${key} (value matched "${hit}")`;
    }
  }
  return null;
}

/** Pick allow-listed keys only. */
function pickAllow(raw: Record<string, unknown>, allow: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (allow.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Derive a short, human-readable label from cwd or transcript path.
 *
 * Handles both POSIX (/) and Windows (\) separators on any host, since a
 * Codex/Claude hook on Windows will send a backslash path that this server
 * might be running anywhere.
 */
export function deriveLabel(cwd?: string, transcriptPath?: string): string {
  if (cwd && cwd.trim() !== "") {
    const trimmed = cwd.replace(/[\\/]+$/, "");
    // Normalize backslashes to forward slashes so basename works cross-platform.
    const base = trimmed.replace(/\\/g, "/").split("/").filter(Boolean).pop();
    if (base) return base;
  }
  if (transcriptPath && transcriptPath.trim() !== "") {
    try {
      const base = path.basename(transcriptPath).replace(/\.[^.]+$/, "");
      if (base) return base.slice(0, 24);
    } catch {
      /* ignore */
    }
  }
  return "task";
}

/** Sanitize a raw Codex or Claude hook payload. */
export function sanitize(
  raw: unknown,
  provider: "codex" | "claude",
): SanitizeResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "payload must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;

  const secretKey = containsSecret(obj);
  if (secretKey) {
    // Log the KEY NAME only, never the value.
    return { ok: false, reason: `rejected: secret-like key "${secretKey}"` };
  }

  const allow = provider === "codex" ? CODEX_ALLOW : CLAUDE_ALLOW;
  const picked = pickAllow(obj, allow);

  const sessionId = typeof picked.session_id === "string" ? picked.session_id : "";
  const eventName =
    typeof picked.hook_event_name === "string" ? picked.hook_event_name : undefined;
  const cwd = typeof picked.cwd === "string" ? picked.cwd : undefined;
  const transcriptPath =
    typeof picked.transcript_path === "string" ? picked.transcript_path : undefined;

  if (!sessionId && !eventName) {
    return { ok: false, reason: "missing session_id and hook_event_name" };
  }

  return {
    ok: true,
    data: {
      sessionId: sessionId || `eph-${Date.now()}`,
      eventName,
      cwd,
      transcriptPath,
    },
  };
}
