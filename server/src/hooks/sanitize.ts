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
  "narrative",
  "narrative_phase",
]);

/** Keys we KEEP from a raw Claude Code hook payload. */
const CLAUDE_ALLOW = new Set([
  "session_id",
  "hook_event_name",
  "cwd",
  "transcript_path",
  "narrative",
  "narrative_phase",
]);

/**
 * Key names that, if present on the raw payload, cause a hard reject.
 *
 * These are matched against KEYS ONLY. Matching them against string *values*
 * used to be the behaviour, and it silently broke the display: a coding agent
 * writes the words "password", "authorization" or "credential" in ordinary
 * prose all the time, and a hit rejected the WHOLE event — including the task's
 * status transition. A frozen traffic light was the visible symptom.
 */
const SECRET_KEY_MARKERS = [
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

/**
 * Patterns that identify an actual credential *inside free text*, as opposed to
 * a word that merely names one. Only these redact the narrative; prose never
 * does. Kept deliberately narrow — a false positive costs the user a visible
 * progress line, a false negative would leak a token to the phone.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI / Anthropic style keys
  /\bgh[pousr]_[A-Za-z0-9]{16,}/, // GitHub tokens
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /\b(?:AIza|ya29\.)[A-Za-z0-9_-]{20,}/, // Google API / OAuth
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private key
];

export type SanitizeResult =
  | {
      ok: true;
      data: {
        sessionId: string;
        eventName: string | undefined;
        cwd: string | undefined;
        transcriptPath: string | undefined;
        narrative: string | undefined;
        narrativePhase: "commentary" | "final";
      };
    }
  | { ok: false; reason: string };

/**
 * Reject if any KEY on the payload names a credential. A hook payload should
 * never carry such a field; if it does, the sending shim is misconfigured and
 * we drop the whole thing rather than guess which part is safe.
 */
function containsSecretKey(raw: Record<string, unknown>): string | null {
  for (const key of Object.keys(raw)) {
    const lk = key.toLowerCase();
    if (SECRET_KEY_MARKERS.some((m) => lk.includes(m))) return key;
  }
  return null;
}

/** True if free text contains something shaped like a real credential. */
export function looksLikeSecretValue(text: string): boolean {
  return SECRET_VALUE_PATTERNS.some((re) => re.test(text));
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

  const secretKey = containsSecretKey(obj);
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
  let narrative =
    typeof picked.narrative === "string"
      ? picked.narrative.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, 2_000)
      : undefined;
  // The narrative is free-form assistant prose. Drop it when it carries
  // something shaped like a real credential — but never reject the event over
  // it, so the task's status still reaches the display.
  if (narrative && looksLikeSecretValue(narrative)) narrative = undefined;
  const narrativePhase = picked.narrative_phase === "final" ? "final" : "commentary";

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
      narrative: narrative || undefined,
      narrativePhase,
    },
  };
}
