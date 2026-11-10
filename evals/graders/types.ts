import type { Finding } from "../../src/core/review.js";
import type { Verdict } from "../../src/core/verdict.js";
import type { Usage } from "../../src/model/types.js";

// What one trial produced. Graders see only this and the case, so a live run, a replay and a
// hand-made test result are graded exactly the same way.
export interface TrialResult {
  findings: readonly Finding[];
  verdict: Verdict;
  steps: number;
  usage: Usage;
  cost: number | undefined; // undefined when the model has no known price
}

export interface Grade {
  name: string;
  passed: boolean;
  score: number; // 0..1
  details: string[]; // one line per problem; empty when perfect
}

// Per rule, summed across trials by the report: precision = tp / (tp + fp), recall = tp / (tp + fn).
export interface RuleCounts {
  tp: number;
  fp: number;
  fn: number;
}
