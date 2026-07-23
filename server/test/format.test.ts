import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatCount, formatPercent, formatResetText, toEpochMs } from "../src/quota/format.js";

const NOW = Date.UTC(2026, 6, 24, 12, 0, 0); // 2026-07-24T12:00:00Z

test("formatPercent rounds and handles bad input", () => {
  assert.equal(formatPercent(78.4), "78%");
  assert.equal(formatPercent(78.6), "79%");
  assert.equal(formatPercent(NaN), "--");
});

test("formatCount: 0 -> none left, n -> n left", () => {
  assert.equal(formatCount(0), "none left");
  assert.equal(formatCount(-1), "none left");
  assert.equal(formatCount(2), "2 left");
});

test("formatResetText: minutes", () => {
  const r = formatResetText(NOW + 15 * 60_000, NOW);
  assert.equal(r, "resets in 15m");
});

test("formatResetText: hours + minutes", () => {
  const r = formatResetText(NOW + 125 * 60_000, NOW); // 2h 5m
  assert.equal(r, "resets in 2h 5m");
});

test("formatResetText: whole hours", () => {
  const r = formatResetText(NOW + 3 * 3_600_000, NOW); // 3h
  assert.equal(r, "resets in 3h");
});

test("formatResetText: days", () => {
  const r = formatResetText(NOW + 3 * 86_400_000, NOW); // 3d
  assert.equal(r, "resets in 3d");
});

test("formatResetText: past -> resets soon", () => {
  assert.equal(formatResetText(NOW - 1000, NOW), "resets soon");
});

test("formatResetText: null/undefined -> undefined", () => {
  assert.equal(formatResetText(null, NOW), undefined);
  assert.equal(formatResetText(undefined, NOW), undefined);
});

test("formatResetText accepts ISO strings", () => {
  const r = formatResetText("2026-07-24T12:30:00Z", NOW); // 30m ahead
  assert.equal(r, "resets in 30m");
});

test("toEpochMs normalizes numbers, strings, rejects garbage", () => {
  assert.equal(toEpochMs(123), 123);
  assert.ok(toEpochMs("2026-07-24T12:00:00Z")! > 0);
  assert.equal(toEpochMs("not-a-date"), null);
  assert.equal(toEpochMs(null), null);
});
