import type { Usage } from "../model/types.js";

// USD per million tokens, from platform.claude.com/docs/en/about-claude/pricing (2026-11-03).
// Cache writes use the 5-minute TTL price, the default for cache_control: ephemeral.
interface Price {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

const PRICES: Record<string, Price> = {
  "claude-haiku-4-5": { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  // Haiku 5.5 costs 5x more above 100k prompt tokens; one review request stays far below that.
  "claude-haiku-5-5": { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 },
  "claude-opus-5-5": { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
};

// [HARNESS:OBS] Estimated cost of a review from its token counts.
// WHY: cost per review is the number that decides whether an agent is viable in CI; printing
//      it on every run makes a prompt or model change that doubles it impossible to miss.
// Returns undefined for a model not in the table: no number is better than a wrong one.
export function estimateCost(model: string, usage: Usage): number | undefined {
  const price = PRICES[model];
  if (!price) return undefined;
  const dollars =
    usage.inputTokens * price.input +
    usage.cacheWriteTokens * price.cacheWrite +
    usage.cacheReadTokens * price.cacheRead +
    usage.outputTokens * price.output;
  return dollars / 1_000_000;
}
