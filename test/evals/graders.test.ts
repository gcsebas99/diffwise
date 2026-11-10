import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CaseFileSchema, type EvalCase, FIXTURES_DIR } from "../../evals/case.js";
import { gradeBudget } from "../../evals/graders/budget.js";
import { gradeFindings } from "../../evals/graders/findings.js";
import { gradeForbidden } from "../../evals/graders/forbidden.js";
import { gradeTrial, type TrialResult, toTrialResult } from "../../evals/graders/index.js";
import { gradeVerdict } from "../../evals/graders/verdict.js";
import type { ReviewOutcome } from "../../src/core/engine.js";
import type { Finding } from "../../src/core/review.js";
import { parseRules } from "../../src/core/rules.js";

const RULES_PATH = join(FIXTURES_DIR, "rules.yaml");
const ruleSet = parseRules(readFileSync(RULES_PATH, "utf8"));
const ROUTE = "src/routes/orders.ts";

// A case in memory: the graders only read the parsed case and its rules.
function makeCase(expect: Record<string, unknown>, budgets = {}): EvalCase {
  const file = CaseFileSchema.parse({
    id: "graded",
    description: "a hand-made case for grader tests",
    rules: RULES_PATH,
    expect,
    budgets: { max_steps: 8, max_tokens: 40_000, max_cost_usd: 0.01, ...budgets },
  });
  return { ...file, dir: "/none", patchPath: "/none/patch.diff", rulesPath: RULES_PATH, ruleSet };
}

function finding(line: number, ruleId = "route-needs-test", path = ROUTE): Finding {
  const severity = ruleId === "env-documented" ? "advisory" : "blocking";
  return { ruleId, severity, path, line, message: "m" };
}

function result(findings: Finding[], over: Partial<TrialResult> = {}): TrialResult {
  return {
    findings,
    verdict: findings.some((f) => f.severity === "blocking") ? "fail" : "pass",
    steps: 2,
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    cost: 0.001,
    ...over,
  };
}

const routeCase = makeCase({
  verdict: "fail",
  findings: [{ rule: "route-needs-test", path: ROUTE, lines: [4, 16] }],
});

describe("gradeFindings", () => {
  it("perfect: one TP, score 1", () => {
    const g = gradeFindings(routeCase, result([finding(8)]));
    expect(g).toMatchObject({ passed: true, score: 1, details: [] });
    expect(g.counts).toEqual({ "route-needs-test": { tp: 1, fp: 0, fn: 0 } });
  });

  it("missed one: a blocking FN fails the case", () => {
    const g = gradeFindings(routeCase, result([]));
    expect(g).toMatchObject({ passed: false, score: 0 });
    expect(g.counts["route-needs-test"]).toEqual({ tp: 0, fp: 0, fn: 1 });
    expect(g.details).toEqual(["missed blocking route-needs-test @ src/routes/orders.ts:4-16"]);
  });

  it("extra one: an FP lowers the score but doesn't fail the case", () => {
    const g = gradeFindings(routeCase, result([finding(8), finding(3, "no-secrets-in-diff")]));
    expect(g.passed).toBe(true);
    expect(g.score).toBeCloseTo(2 / 3);
    expect(g.counts["no-secrets-in-diff"]).toEqual({ tp: 0, fp: 1, fn: 0 });
    expect(g.details).toEqual(["unexpected no-secrets-in-diff @ src/routes/orders.ts:3"]);
  });

  it("wrong line: one FN and one FP, with a hint pointing at the reported line", () => {
    const g = gradeFindings(routeCase, result([finding(30)]));
    expect(g.passed).toBe(false);
    expect(g.counts["route-needs-test"]).toEqual({ tp: 0, fp: 1, fn: 1 });
    expect(g.details[0]).toMatch(/reported at line 30, outside the range/);
  });

  it("a duplicate comment on the same issue is an FP", () => {
    const g = gradeFindings(routeCase, result([finding(8), finding(9)]));
    expect(g.counts["route-needs-test"]).toEqual({ tp: 1, fp: 1, fn: 0 });
  });

  it("a finding on another file doesn't match, even with the same rule and line", () => {
    const g = gradeFindings(
      routeCase,
      result([finding(8, "route-needs-test", "src/routes/users.ts")]),
    );
    expect(g.counts["route-needs-test"]).toEqual({ tp: 0, fp: 1, fn: 1 });
  });

  it("a missed advisory finding counts as an FN but doesn't fail the case", () => {
    const c = makeCase({
      verdict: "pass",
      findings: [{ rule: "env-documented", path: "src/logger.ts", lines: [4, 4] }],
    });
    const g = gradeFindings(c, result([]));
    expect(g.passed).toBe(true);
    expect(g.counts["env-documented"]).toEqual({ tp: 0, fp: 0, fn: 1 });
  });

  it("matching is one-to-one and optimal: a wide range doesn't steal a narrow one's line", () => {
    const c = makeCase({
      verdict: "fail",
      findings: [
        { rule: "route-needs-test", path: ROUTE, lines: [1, 20] },
        { rule: "route-needs-test", path: ROUTE, lines: [10, 12] },
      ],
    });
    const g = gradeFindings(c, result([finding(11), finding(15)]));
    expect(g.counts["route-needs-test"]).toEqual({ tp: 2, fp: 0, fn: 0 });
  });

  it("nothing expected and nothing reported scores 1", () => {
    const g = gradeFindings(makeCase({ verdict: "pass" }), result([]));
    expect(g).toMatchObject({ passed: true, score: 1, counts: {} });
  });
});

describe("gradeVerdict", () => {
  it("passes on an exact match and explains a mismatch", () => {
    expect(gradeVerdict(routeCase, result([finding(8)])).passed).toBe(true);
    expect(gradeVerdict(routeCase, result([]))).toMatchObject({
      passed: false,
      details: ["expected fail, got pass"],
    });
  });

  it("neutral never matches", () => {
    expect(gradeVerdict(routeCase, result([], { verdict: "neutral" })).passed).toBe(false);
  });
});

describe("gradeForbidden", () => {
  const anywhere = makeCase({ verdict: "pass", forbidden: [{ rule: "route-needs-test" }] });
  const onHealth = makeCase({
    verdict: "pass",
    forbidden: [{ rule: "route-needs-test", path: "src/routes/health.ts" }],
  });

  it("passes when nothing forbidden is reported", () => {
    expect(gradeForbidden(anywhere, result([finding(3, "env-documented")])).passed).toBe(true);
  });

  it("without a path, the rule is forbidden in every file", () => {
    const g = gradeForbidden(anywhere, result([finding(8)]));
    expect(g).toMatchObject({
      passed: false,
      details: ["forbidden route-needs-test @ src/routes/orders.ts:8"],
    });
  });

  it("with a path, only that file is forbidden", () => {
    expect(gradeForbidden(onHealth, result([finding(8)])).passed).toBe(true);
    const g = gradeForbidden(
      onHealth,
      result([finding(5, "route-needs-test", "src/routes/health.ts")]),
    );
    expect(g.passed).toBe(false);
  });
});

describe("gradeBudget", () => {
  it("passes within every budget", () => {
    expect(gradeBudget(routeCase, result([]))).toMatchObject({ passed: true, score: 1 });
  });

  it("counts cached input tokens, like the loop's token budget", () => {
    const usage = {
      inputTokens: 100,
      outputTokens: 100,
      cacheReadTokens: 39_000,
      cacheWriteTokens: 801,
    };
    const g = gradeBudget(routeCase, result([], { usage }));
    expect(g.passed).toBe(false);
    expect(g.details).toEqual(["40001 tokens > 40000"]);
  });

  it("lists each exceeded budget and scores the fraction met", () => {
    const g = gradeBudget(routeCase, result([], { steps: 9, cost: 0.02 }));
    expect(g.details).toEqual(["9 steps > 8", "$0.0200 > $0.01"]);
    expect(g.score).toBeCloseTo(1 / 3);
  });

  it("an unknown cost fails: we can't show it stayed in budget", () => {
    const g = gradeBudget(routeCase, result([], { cost: undefined }));
    expect(g).toMatchObject({ passed: false, details: ["cost unknown (no price for this model)"] });
  });

  it("max_steps 0 fails as soon as the model runs once", () => {
    const c = makeCase({ verdict: "pass" }, { max_steps: 0, max_tokens: 0, max_cost_usd: 0 });
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(gradeBudget(c, result([], { steps: 0, usage: zero, cost: 0 })).passed).toBe(true);
    expect(gradeBudget(c, result([], { steps: 1, usage: zero, cost: 0 })).passed).toBe(false);
  });
});

describe("gradeTrial", () => {
  it("passes only when every grader passes, keeping each grade in order", () => {
    const ok = gradeTrial(routeCase, result([finding(8)]));
    expect(ok.passed).toBe(true);
    expect(ok.grades.map((g) => g.name)).toEqual(["verdict", "findings", "forbidden", "budget"]);
    expect(ok.counts).toEqual({ "route-needs-test": { tp: 1, fp: 0, fn: 0 } });

    const slow = gradeTrial(routeCase, result([finding(8)], { steps: 20 }));
    expect(slow.passed).toBe(false);
    expect(slow.grades.filter((g) => !g.passed).map((g) => g.name)).toEqual(["budget"]);
  });

  it("toTrialResult takes what the graders need from a review outcome", () => {
    const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 };
    const outcome = {
      run: {
        outcome: "completed",
        complete: true,
        findings: [finding(8)],
        summary: "s",
        steps: 3,
        usage,
        promptVersion: "p",
      },
      verdict: { verdict: "fail", counts: { blocking: 1, advisory: 0 } },
      cost: 0.002,
    } as ReviewOutcome;
    expect(toTrialResult(outcome)).toEqual({
      findings: [finding(8)],
      verdict: "fail",
      steps: 3,
      usage,
      cost: 0.002,
    });
  });
});
