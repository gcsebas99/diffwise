import type { ReviewOutcome } from "../../src/core/engine.js";
import type { EvalCase } from "../case.js";
import { gradeBudget } from "./budget.js";
import { gradeFindings } from "./findings.js";
import { gradeForbidden } from "./forbidden.js";
import type { Grade, RuleCounts, TrialResult } from "./types.js";
import { gradeVerdict } from "./verdict.js";

export type { Grade, RuleCounts, TrialResult } from "./types.js";

export interface TrialGrade {
  passed: boolean;
  grades: Grade[];
  counts: Record<string, RuleCounts>; // from the findings grader, for per-rule precision/recall
}

export function toTrialResult(outcome: ReviewOutcome): TrialResult {
  const { run, verdict, cost } = outcome;
  return {
    findings: run.findings,
    verdict: verdict.verdict,
    steps: run.steps,
    usage: run.usage,
    cost,
  };
}

// A case passes only if every grader passes: right verdict, every blocking finding found,
// nothing forbidden, within budget. Each grade is kept, so the report can say which one failed.
export function gradeTrial(c: EvalCase, result: TrialResult): TrialGrade {
  const findings = gradeFindings(c, result);
  const grades = [
    gradeVerdict(c, result),
    findings,
    gradeForbidden(c, result),
    gradeBudget(c, result),
  ];
  return { passed: grades.every((g) => g.passed), grades, counts: findings.counts };
}
