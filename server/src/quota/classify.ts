/**
 * Quota severity classifier.
 *
 * Port of cockpit-tools getCodexQuotaClass, generalized to handle all three
 * semantics (remaining / used / count) without the original's remaining-vs-used
 * footgun: we always classify on REMAINING percent, converting "used" first.
 *
 * Thresholds (remaining %): >=80 high, >=40 medium, >=10 low, <10 critical.
 */
import type { QuotaClass, QuotaSemantics } from "../state/types.js";

/** Classify a 0..100 remaining percentage into a 4-tier traffic-light class. */
export function classifyRemaining(remainingPercent: number): QuotaClass {
  const p = clampPercent(remainingPercent);
  if (p >= 80) return "high";
  if (p >= 40) return "medium";
  if (p >= 10) return "low";
  return "critical";
}

/** Classify a 0..100 used percentage (converts to remaining first). */
export function classifyUsed(usedPercent: number): QuotaClass {
  return classifyRemaining(100 - usedPercent);
}

/**
 * Unified classifier: given a value in `semantics`, return the class.
 *  - remaining: percentage IS remaining
 *  - used:      percentage IS used, convert
 *  - count:     value is a count of items; >=2 high, ==1 medium, 0 critical
 */
export function classify(
  value: number,
  semantics: QuotaSemantics,
): QuotaClass {
  if (semantics === "used") return classifyUsed(value);
  if (semantics === "count") return classifyCount(value);
  return classifyRemaining(value);
}

/** Classify a count of available items (e.g. reset credits). */
export function classifyCount(count: number): QuotaClass {
  if (count >= 2) return "high";
  if (count === 1) return "medium";
  return "critical";
}

/**
 * Normalize a metric's value into a "fraction remaining" for the progress bar,
 * so the bar ALWAYS reads "more filled = more quota left" regardless of
 * semantics. Returns an integer 0..100 (rounded for display).
 */
export function progressForDisplay(
  value: number,
  semantics: QuotaSemantics,
): number {
  let p: number;
  if (semantics === "used") {
    p = 100 - value;
  } else if (semantics === "count") {
    // 0 -> 0%, 1 -> 33%, 2 -> 67%, 3+ -> 100%
    p = Math.min(100, (value / 3) * 100);
  } else {
    p = value;
  }
  // Round to an integer for a stable bar width.
  return Math.round(clampPercent(p));
}

/** Clamp a percentage to [0, 100], treating NaN/Infinity as 0. */
export function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(100, p));
}
