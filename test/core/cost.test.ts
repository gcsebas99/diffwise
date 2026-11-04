import { describe, expect, it } from "vitest";
import { estimateCost } from "../../src/core/cost.js";

const usage = {
  inputTokens: 1000,
  cacheWriteTokens: 2000,
  cacheReadTokens: 3000,
  outputTokens: 500,
};

describe("estimateCost", () => {
  it("prices each token kind separately", () => {
    // Haiku 5.5 per MTok: input 0.10, cache write 0.125, cache read 0.01, output 0.50
    // → 100 + 250 + 30 + 250 = 630 dollars per million → $0.00063
    expect(estimateCost("claude-haiku-5-5", usage)).toBeCloseTo(0.00063, 10);
  });

  it("returns undefined for a model it has no price for", () => {
    expect(estimateCost("claude-unknown-9", usage)).toBeUndefined();
  });
});
