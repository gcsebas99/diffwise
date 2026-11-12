import type { RuleCounts } from "./graders/index.js";
import type { EvalMode, TrialRecord } from "./runner.js";

export interface ReportMeta {
  suite: string;
  mode: EvalMode;
  k: number;
  model: string | undefined;
  rules: string; // the rules override, or "case" when each case used its own rules file
  gitSha: string;
  gitDirty: boolean; // a report from uncommitted code can't be reproduced from the sha alone
  startedAt: string; // ISO
  durationMs: number;
}

export interface CaseSummary {
  id: string;
  tags: string[];
  trials: number;
  passes: number;
  errors: number;
  passAtK: boolean; // passed at least once in k trials
  passHatK: boolean; // passed every one of k trials
  failures: string[]; // "trial 2 · findings: missed blocking ...", one per failing grade
}

export interface RuleSummary extends RuleCounts {
  precision: number | null; // null: the rule was never reported, so precision is undefined
  recall: number | null; // null: no case expects the rule
}

export interface Stats {
  n: number;
  mean: number;
  p95: number;
}

export interface Report {
  meta: ReportMeta & { promptVersions: string[] };
  totals: {
    cases: number;
    trials: number;
    errors: number;
    passRate: number; // graded trials that passed / all trials
    passAtK: number; // fraction of cases
    passHatK: number;
  };
  cases: CaseSummary[];
  rules: Record<string, RuleSummary>;
  // Over trials where the model ran: $0 checks-only trials would make reviews look cheaper.
  cost: Stats & { total: number; unknown: number };
  latencyMs: Stats;
  wallMs: Stats;
}

// Nearest-rank p95: an observed value, never interpolated between two.
export function stats(values: readonly number[]): Stats {
  if (values.length === 0) return { n: 0, mean: 0, p95: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1] ?? 0;
  return { n: sorted.length, mean, p95 };
}

const ratio = (num: number, den: number) => (den === 0 ? null : num / den);

export function summarize(
  records: readonly TrialRecord[],
  caseTags: ReadonlyMap<string, string[]>,
  meta: ReportMeta,
): Report {
  const byCase = new Map<string, TrialRecord[]>();
  for (const r of records) byCase.set(r.caseId, [...(byCase.get(r.caseId) ?? []), r]);

  // [HARNESS:EVAL] pass@k vs pass^k: "can it ever do this?" vs "does it always do this?"
  // WHY: a reviewer that catches a missing test 2 runs out of 3 has pass@3 = 1 and pass^3 = 0.
  //      Users see one run per PR, so pass^k is the reliability they get; pass@k is the ceiling.
  // INTERVIEW: "How do you evaluate a non-deterministic agent?" → k trials per case; report
  //            both, and gate on pass^k for anything that must never regress (injections).
  const cases: CaseSummary[] = [...byCase].map(([id, trials]) => {
    const graded = trials.filter((t) => t.status === "graded");
    const passes = graded.filter((t) => t.grade.passed).length;
    const failures = trials.flatMap((t) =>
      t.status === "error"
        ? [`trial ${t.trial} · error: ${t.error.split("\n")[0]}`]
        : t.grade.grades
            .filter((g) => !g.passed)
            .map((g) => `trial ${t.trial} · ${g.name}: ${g.details.join("; ")}`),
    );
    return {
      id,
      tags: caseTags.get(id) ?? [],
      trials: trials.length,
      passes,
      errors: trials.length - graded.length,
      passAtK: passes > 0,
      passHatK: passes === trials.length,
      failures,
    };
  });

  const graded = records.filter((r) => r.status === "graded");
  const counts: Record<string, RuleCounts> = {};
  for (const r of graded) {
    for (const [rule, c] of Object.entries(r.grade.counts)) {
      const sum = counts[rule] ?? { tp: 0, fp: 0, fn: 0 };
      counts[rule] = { tp: sum.tp + c.tp, fp: sum.fp + c.fp, fn: sum.fn + c.fn };
    }
  }
  // [HARNESS:EVAL] Precision and recall per rule, summed over every trial of every case.
  // WHY: one blended score hides which rule is noisy; a review bot that's 95% right overall
  //      but flags every route change gets muted for the route rule, and that's what to fix.
  const rules = Object.fromEntries(
    Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([rule, c]) => [
        rule,
        { ...c, precision: ratio(c.tp, c.tp + c.fp), recall: ratio(c.tp, c.tp + c.fn) },
      ]),
  );

  const modelRuns = graded.filter((r) => r.modelUsed);
  const costs = modelRuns.flatMap((r) => (r.result.cost === undefined ? [] : [r.result.cost]));
  const passed = graded.filter((r) => r.grade.passed).length;
  return {
    meta: {
      ...meta,
      promptVersions: [...new Set(modelRuns.map((r) => r.promptVersion))].sort(),
    },
    totals: {
      cases: cases.length,
      trials: records.length,
      errors: records.length - graded.length,
      passRate: ratio(passed, records.length) ?? 0,
      passAtK: ratio(cases.filter((c) => c.passAtK).length, cases.length) ?? 0,
      passHatK: ratio(cases.filter((c) => c.passHatK).length, cases.length) ?? 0,
    },
    cases,
    rules,
    cost: {
      ...stats(costs),
      total: costs.reduce((sum, v) => sum + v, 0),
      unknown: modelRuns.length - costs.length,
    },
    latencyMs: stats(modelRuns.map((r) => r.latencyMs)),
    wallMs: stats(records.map((r) => r.wallMs)),
  };
}

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const usd = (v: number) => `$${v.toFixed(4)}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function toMarkdown(report: Report): string {
  const { meta, totals } = report;
  const sha = `${meta.gitSha.slice(0, 7)}${meta.gitDirty ? " (dirty)" : ""}`;
  const lines = [
    `# Eval report · ${meta.suite} · ${meta.startedAt}`,
    "",
    `Mode **${meta.mode}**, k = ${meta.k}, rules \`${meta.rules}\`, model \`${meta.model ?? "none"}\`, prompt ${
      meta.promptVersions.map((v) => `\`${v}\``).join(", ") || "none"
    }, diffwise \`${sha}\`.`,
    "",
    "| Cases | Trials | Pass rate | pass@k | pass^k | Errors |",
    "|---|---|---|---|---|---|",
    `| ${totals.cases} | ${totals.trials} | ${pct(totals.passRate)} | ${pct(totals.passAtK)} | ${pct(totals.passHatK)} | ${totals.errors} |`,
    "",
    "## Rules",
    "",
    "| Rule | TP | FP | FN | Precision | Recall |",
    "|---|---|---|---|---|---|",
    ...Object.entries(report.rules).map(
      ([rule, r]) =>
        `| ${rule} | ${r.tp} | ${r.fp} | ${r.fn} | ${pct(r.precision)} | ${pct(r.recall)} |`,
    ),
    "",
    "## Cost and latency (trials where the model ran)",
    "",
    `- Cost: mean ${usd(report.cost.mean)}, p95 ${usd(report.cost.p95)}, total ${usd(report.cost.total)} over ${report.cost.n} trials${
      report.cost.unknown ? ` (${report.cost.unknown} with unknown price)` : ""
    }`,
    `- Model latency: mean ${secs(report.latencyMs.mean)}, p95 ${secs(report.latencyMs.p95)}`,
    `- Wall time per trial (all trials): mean ${secs(report.wallMs.mean)}, p95 ${secs(report.wallMs.p95)}`,
    "",
    "## Cases",
    "",
    "| Case | Passed | pass@k | pass^k | Tags |",
    "|---|---|---|---|---|",
    ...report.cases.map(
      (c) =>
        `| ${c.id} | ${c.passes}/${c.trials}${c.errors ? ` (${c.errors} errors)` : ""} | ${c.passAtK ? "✓" : "✗"} | ${c.passHatK ? "✓" : "✗"} | ${c.tags.join(", ")} |`,
    ),
  ];
  const failing = report.cases.filter((c) => c.failures.length > 0);
  if (failing.length > 0) {
    lines.push("", "## Failures", "");
    for (const c of failing) {
      lines.push(`### ${c.id}`, "", ...c.failures.map((f) => `- ${f}`), "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
