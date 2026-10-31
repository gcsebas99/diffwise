import type { Severity } from "./rules.js";

export interface Finding {
  ruleId: string;
  severity: Severity; // copied from the rule, so the verdict never trusts the model's opinion
  path: string;
  line: number;
  message: string;
  suggestion?: string;
}

// Owned by the loop, written by report_finding / submit_review. Findings survive any early exit.
export interface ReviewState {
  findings: Finding[];
  summary?: string; // set by submit_review; the loop treats it as "done"
}

export function createReviewState(): ReviewState {
  return { findings: [] };
}
