import type { Finding } from "../../src/core/review.js";
import type { EvalCase } from "../case.js";
import type { Grade, RuleCounts, TrialResult } from "./types.js";

type Expected = EvalCase["expect"]["findings"][number];

export interface FindingsGrade extends Grade {
  counts: Record<string, RuleCounts>; // keyed by rule id; a plain object so the report is JSON
}

const sameSpot = (e: Expected, f: Finding) => e.rule === f.ruleId && e.path === f.path;
const inRange = (e: Expected, line: number) => line >= e.lines[0] && line <= e.lines[1];

// [HARNESS:EVAL] Match expected to reported findings one-to-one, by rule + path + line range.
// WHY: one comment can't satisfy two expectations, and a second comment on the same issue is
//      noise, so it counts as a false positive. Ranges ending first pick the lowest free line
//      first; that greedy order is optimal, so a wide range never steals the only line a
//      narrow one could take.
// INTERVIEW: "How do you score a reviewer's findings?" → match them to a labeled set; count
//            TP/FP/FN per rule; report precision and recall separately, never just accuracy.
function match(expected: readonly Expected[], reported: readonly Finding[]) {
  const free = [...reported].sort((a, b) => a.line - b.line);
  const missed: Expected[] = [];
  for (const e of [...expected].sort((a, b) => a.lines[1] - b.lines[1])) {
    const i = free.findIndex((f) => sameSpot(e, f) && inRange(e, f.line));
    if (i >= 0) free.splice(i, 1);
    else missed.push(e);
  }
  return { missed, extra: free };
}

export function gradeFindings(c: EvalCase, result: TrialResult): FindingsGrade {
  const { missed, extra } = match(c.expect.findings, result.findings);
  const counts: Record<string, RuleCounts> = {};
  const bump = (rule: string, key: keyof RuleCounts) => {
    counts[rule] ??= { tp: 0, fp: 0, fn: 0 };
    counts[rule][key] += 1;
  };
  for (const e of c.expect.findings) if (!missed.includes(e)) bump(e.rule, "tp");
  for (const e of missed) bump(e.rule, "fn");
  for (const f of extra) bump(f.ruleId, "fp");

  const severity = (rule: string) => c.ruleSet.rules.find((r) => r.id === rule)?.severity;
  const details = [
    ...missed.map((e) => {
      // Usually the right issue anchored outside the range: say where, so the fix is obvious.
      const near = extra.find((f) => sameSpot(e, f));
      const hint = near ? ` (reported at line ${near.line}, outside the range)` : "";
      return `missed ${severity(e.rule)} ${e.rule} @ ${e.path}:${e.lines[0]}-${e.lines[1]}${hint}`;
    }),
    ...extra.map((f) => `unexpected ${f.ruleId} @ ${f.path}:${f.line}`),
  ];

  // [HARNESS:EVAL] Gate on blocking recall; report precision without gating on it.
  // WHY: a missed blocking finding lets a bad PR merge, so it fails the case. Extra findings
  //      cost trust, not safety: they lower the score and the per-rule precision, which the
  //      report tracks across runs, but one noisy trial doesn't fail the case.
  const passed = !missed.some((e) => severity(e.rule) === "blocking");
  const tp = c.expect.findings.length - missed.length;
  const fp = extra.length;
  const fn = missed.length;
  // F1: 1 when nothing was expected and nothing reported; 0 when every finding is wrong.
  const score = tp + fp + fn === 0 ? 1 : (2 * tp) / (2 * tp + fp + fn);
  return { name: "findings", passed, score, details, counts };
}
