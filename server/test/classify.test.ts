import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  classify,
  classifyCount,
  classifyRemaining,
  classifyUsed,
  clampPercent,
  progressForDisplay,
} from "../src/quota/classify.js";

test("classifyRemaining boundaries: 80/40/10", () => {
  assert.equal(classifyRemaining(100), "high");
  assert.equal(classifyRemaining(80), "high");
  assert.equal(classifyRemaining(79.9), "medium");
  assert.equal(classifyRemaining(40), "medium");
  assert.equal(classifyRemaining(39.9), "low");
  assert.equal(classifyRemaining(10), "low");
  assert.equal(classifyRemaining(9.9), "critical");
  assert.equal(classifyRemaining(0), "critical");
});

test("classifyUsed converts to remaining first (the footgun fix)", () => {
  // 90% used -> 10% remaining -> low (almost empty, NOT high)
  assert.equal(classifyUsed(90), "low");
  // 5% used -> 95% remaining -> high
  assert.equal(classifyUsed(5), "high");
});

test("classify dispatches on semantics", () => {
  assert.equal(classify(85, "remaining"), "high");
  // 85% used -> 15% remaining -> low
  assert.equal(classify(85, "used"), "low");
  assert.equal(classify(3, "count"), "high");
  assert.equal(classify(1, "count"), "medium");
  assert.equal(classify(0, "count"), "critical");
});

test("classifyCount thresholds: >=2 high, ==1 medium, 0 critical", () => {
  assert.equal(classifyCount(5), "high");
  assert.equal(classifyCount(2), "high");
  assert.equal(classifyCount(1), "medium");
  assert.equal(classifyCount(0), "critical");
});

test("progressForDisplay normalizes so 'more filled = more left'", () => {
  // remaining: directly proportional
  assert.equal(progressForDisplay(100, "remaining"), 100);
  assert.equal(progressForDisplay(50, "remaining"), 50);
  assert.equal(progressForDisplay(0, "remaining"), 0);
  // used: inverted (50% used -> 50% remaining -> bar half full)
  assert.equal(progressForDisplay(50, "used"), 50);
  assert.equal(progressForDisplay(100, "used"), 0); // all used -> empty bar
  assert.equal(progressForDisplay(0, "used"), 100); // none used -> full bar
  // count: 0->0, 1->~33, 2->~66, 3->100
  assert.equal(progressForDisplay(0, "count"), 0);
  assert.equal(progressForDisplay(1, "count"), Math.round(100 / 3));
  assert.equal(progressForDisplay(3, "count"), 100);
});

test("clampPercent handles NaN/Infinity/out-of-range", () => {
  assert.equal(clampPercent(150), 100);
  assert.equal(clampPercent(-5), 0);
  assert.equal(clampPercent(42), 42);
  assert.equal(clampPercent(NaN), 0);
  assert.equal(clampPercent(Infinity), 0);
});
