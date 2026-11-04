import type { Finding } from "./review.js";

export type Verdict = "pass" | "fail" | "neutral";

export interface VerdictResult {
  verdict: Verdict;
  counts: { blocking: number; advisory: number };
}

// [HARNESS:GUARD] The verdict is computed by code from findings, never taken from the model.
// WHY: severities come from the rules file, so "fail" means a rule the repo marked blocking was
//      violated. A model saying "LGTM" can't turn that into a pass.
// INTERVIEW: "Why not let the model decide pass/fail?" → it's a policy decision; the model
//            gathers evidence, code applies the policy, the same way every time.
export function computeVerdict(findings: readonly Finding[], complete: boolean): VerdictResult {
  const blocking = findings.filter((f) => f.severity === "blocking").length;
  const counts = { blocking, advisory: findings.length - blocking };
  // A blocking finding fails the review even when the run stopped early: it's already proven.
  if (blocking > 0) return { verdict: "fail", counts };
  // Incomplete means "we don't know", which is never the same as "nothing wrong".
  if (!complete) return { verdict: "neutral", counts };
  return { verdict: "pass", counts };
}
