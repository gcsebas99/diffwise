import { totalInputTokens } from "../../src/model/types.js";
import type { EvalCase } from "../case.js";
import type { Grade, TrialResult } from "./types.js";

// [HARNESS:EVAL] Budgets: a correct review that took too long or cost too much still fails.
// WHY: cost and latency regress quietly (a prompt change that adds three tool calls still gets
//      the right answer). Budgets tighter than the harness caps catch that drift per case.
export function gradeBudget(c: EvalCase, result: TrialResult): Grade {
  const { max_steps, max_tokens, max_cost_usd } = c.budgets;
  // Counted like the loop's token budget: every input token (cached or not) plus output.
  const tokens = totalInputTokens(result.usage) + result.usage.outputTokens;
  const checks: [ok: boolean, problem: string][] = [
    [result.steps <= max_steps, `${result.steps} steps > ${max_steps}`],
    [tokens <= max_tokens, `${tokens} tokens > ${max_tokens}`],
    // Unknown price: we can't show the review stayed in budget, so we don't claim it did.
    result.cost === undefined
      ? [false, "cost unknown (no price for this model)"]
      : [result.cost <= max_cost_usd, `$${result.cost.toFixed(4)} > $${max_cost_usd}`],
  ];
  const details = checks.filter(([ok]) => !ok).map(([, problem]) => problem);
  const passed = details.length === 0;
  return { name: "budget", passed, score: 1 - details.length / checks.length, details };
}
