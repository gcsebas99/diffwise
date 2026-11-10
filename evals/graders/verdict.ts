import type { EvalCase } from "../case.js";
import type { Grade, TrialResult } from "./types.js";

// Exact match. "neutral" (the review didn't finish) never matches, since a case can't expect it.
export function gradeVerdict(c: EvalCase, result: TrialResult): Grade {
  const passed = result.verdict === c.expect.verdict;
  const details = passed ? [] : [`expected ${c.expect.verdict}, got ${result.verdict}`];
  return { name: "verdict", passed, score: passed ? 1 : 0, details };
}
