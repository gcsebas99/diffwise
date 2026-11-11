import { describe, expect, it } from "vitest";
import { compareReports, comparisonToMarkdown } from "../../evals/compare.js";
import type { TrialGrade } from "../../evals/graders/index.js";
import { type ReportMeta, stats, summarize, toMarkdown } from "../../evals/report.js";
import type { TrialRecord } from "../../evals/runner.js";

const META: ReportMeta = {
  suite: "full",
  mode: "replay",
  k: 3,
  model: "claude-haiku-5-5",
  gitSha: "0123456789abcdef",
  gitDirty: false,
  startedAt: "2026-11-10T00:00:00.000Z",
  durationMs: 1000,
};
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function trial(
  caseId: string,
  n: number,
  passed: boolean,
  opts: {
    counts?: TrialGrade["counts"];
    cost?: number | undefined;
    model?: boolean;
    latencyMs?: number;
  } = {},
): TrialRecord {
  const model = opts.model ?? true;
  const failing = { name: "findings", passed: false, score: 0, details: ["missed blocking x"] };
  return {
    caseId,
    trial: n,
    wallMs: 100,
    status: "graded",
    result: {
      findings: [],
      verdict: "pass",
      steps: model ? 2 : 0,
      usage,
      cost: "cost" in opts ? opts.cost : 0.001,
    },
    grade: { passed, grades: passed ? [] : [failing], counts: opts.counts ?? {} },
    outcome: "completed",
    modelUsed: model,
    promptVersion: model ? "abc123" : "none",
    latencyMs: opts.latencyMs ?? 1000,
  };
}

const error = (caseId: string, n: number): TrialRecord => ({
  caseId,
  trial: n,
  wallMs: 5,
  status: "error",
  error: "No cassette at x.jsonl\nmore",
});

const TAGS = new Map([
  ["always", ["smoke"]],
  ["flaky", ["routes"]],
  ["never", []],
]);

describe("stats", () => {
  it("nearest-rank p95 is an observed value", () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    expect(stats(values)).toEqual({ n: 20, mean: 10.5, p95: 19 });
    expect(stats([5])).toEqual({ n: 1, mean: 5, p95: 5 });
    expect(stats([])).toEqual({ n: 0, mean: 0, p95: 0 });
  });
});

describe("summarize", () => {
  const records = [
    ...[1, 2, 3].map((n) => trial("always", n, true)),
    trial("flaky", 1, true),
    trial("flaky", 2, false),
    trial("flaky", 3, true),
    ...[1, 2, 3].map((n) => trial("never", n, false)),
  ];
  const report = summarize(records, TAGS, META);

  it("pass@k: passed at least once; pass^k: passed every time", () => {
    const flaky = report.cases.find((c) => c.id === "flaky");
    expect(flaky).toMatchObject({ passes: 2, trials: 3, passAtK: true, passHatK: false });
    expect(report.totals).toMatchObject({ cases: 3, trials: 9, errors: 0 });
    expect(report.totals.passRate).toBeCloseTo(5 / 9);
    expect(report.totals.passAtK).toBeCloseTo(2 / 3);
    expect(report.totals.passHatK).toBeCloseTo(1 / 3);
  });

  it("names the failing grader and trial", () => {
    expect(report.cases.find((c) => c.id === "flaky")?.failures).toEqual([
      "trial 2 · findings: missed blocking x",
    ]);
  });

  it("sums counts per rule across trials; precision or recall is null when undefined", () => {
    const r = summarize(
      [
        trial("a", 1, true, { counts: { route: { tp: 1, fp: 0, fn: 0 } } }),
        trial("a", 2, false, { counts: { route: { tp: 0, fp: 1, fn: 1 } } }),
        trial("b", 1, false, { counts: { secrets: { tp: 0, fp: 2, fn: 0 } } }),
      ],
      new Map(),
      META,
    );
    expect(r.rules.route).toEqual({ tp: 1, fp: 1, fn: 1, precision: 0.5, recall: 0.5 });
    expect(r.rules.secrets).toEqual({ tp: 0, fp: 2, fn: 0, precision: 0, recall: null });
  });

  it("errors count as trials that didn't pass, and are reported apart", () => {
    const r = summarize([trial("a", 1, true), error("a", 2)], new Map(), META);
    expect(r.totals).toMatchObject({ trials: 2, errors: 1, passRate: 0.5, passHatK: 0 });
    expect(r.cases[0]?.failures).toEqual(["trial 2 · error: No cassette at x.jsonl"]);
  });

  it("cost and latency cover only trials where the model ran; unknown prices are counted", () => {
    const r = summarize(
      [
        trial("a", 1, true, { cost: 0.002, latencyMs: 2000 }),
        trial("a", 2, true, { cost: undefined, latencyMs: 4000 }),
        trial("b", 1, true, { model: false, cost: 0, latencyMs: 0 }),
      ],
      new Map(),
      META,
    );
    expect(r.cost).toMatchObject({ n: 1, mean: 0.002, total: 0.002, unknown: 1 });
    expect(r.latencyMs).toMatchObject({ n: 2, mean: 3000 });
    expect(r.meta.promptVersions).toEqual(["abc123"]);
  });

  it("renders the headline numbers, rule table and failures as markdown", () => {
    const md = toMarkdown(report);
    expect(md).toContain(
      "Mode **replay**, k = 3, model `claude-haiku-5-5`, prompt `abc123`, diffwise `0123456`.",
    );
    expect(md).toContain("| 3 | 9 | 56% | 67% | 33% | 0 |");
    expect(md).toContain("| flaky | 2/3 | ✓ | ✗ | routes |");
    expect(md).toContain("### never");
  });
});

describe("compareReports", () => {
  const before = summarize(
    [trial("a", 1, true), trial("b", 1, false), trial("c", 1, true, { cost: 0.002 })],
    new Map(),
    META,
  );
  const after = summarize(
    [trial("a", 1, false), trial("b", 1, true), trial("d", 1, true, { cost: 0.004 })],
    new Map(),
    { ...META, model: "claude-sonnet-5-5" },
  );
  const cmp = compareReports(before, after);

  it("lists regressions and fixes case by case", () => {
    expect(cmp.regressions).toEqual([{ id: "a", before: "1/1", after: "0/1" }]);
    expect(cmp.fixes).toEqual([{ id: "b", before: "0/1", after: "1/1" }]);
    expect(cmp.unchanged).toBe(0);
  });

  it("warns when the comparison isn't like for like", () => {
    expect(cmp.warnings).toEqual([
      'model differs: "claude-haiku-5-5" → "claude-sonnet-5-5"',
      "only in the first report: c",
      "only in the second report: d",
    ]);
  });

  it("reports the change in mean cost", () => {
    expect(cmp.cost.before).toBeCloseTo((0.001 + 0.001 + 0.002) / 3);
    expect(cmp.cost.after).toBeCloseTo((0.001 + 0.001 + 0.004) / 3);
    expect(comparisonToMarkdown(cmp)).toContain("**1 regressions**, 1 fixes, 0 unchanged.");
  });
});
