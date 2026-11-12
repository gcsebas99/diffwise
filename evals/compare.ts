import type { Report } from "./report.js";

export interface CaseChange {
  id: string;
  before: string; // "3/3"
  after: string;
}

export interface Comparison {
  regressions: CaseChange[]; // pass rate went down
  fixes: CaseChange[]; // pass rate went up
  unchanged: number;
  warnings: string[]; // differences that make the comparison unfair
  cost: { before: number; after: number; delta: number }; // mean per model trial
  // A run that sends more cases to the model can keep the same mean and still cost more.
  totalCost: { before: number; after: number; modelTrials: [number, number] };
  rules: {
    rule: string;
    precision: [number | null, number | null];
    recall: [number | null, number | null];
  }[];
}

// [HARNESS:EVAL] Compare two runs case by case, not by headline pass rate.
// WHY: a prompt change can fix two cases and break two others with the same total; the
//      regressions list is what decides whether it ships. Warnings flag unfair comparisons
//      (different model, suite or k) so a model swap isn't read as a prompt improvement.
// INTERVIEW: "Recall up 10%, false positives doubled: ship it?" → compare per rule and per
//            case; for a review bot, the precision drop usually costs more than recall buys.
export function compareReports(a: Report, b: Report): Comparison {
  const warnings: string[] = [];
  const differs = (label: string, x: unknown, y: unknown) => {
    if (JSON.stringify(x) !== JSON.stringify(y)) {
      warnings.push(`${label} differs: ${JSON.stringify(x)} → ${JSON.stringify(y)}`);
    }
  };
  differs("model", a.meta.model, b.meta.model);
  differs("suite", a.meta.suite, b.meta.suite);
  differs("k", a.meta.k, b.meta.k);
  differs("rules", a.meta.rules, b.meta.rules);
  differs("prompt version", a.meta.promptVersions, b.meta.promptVersions);

  const before = new Map(a.cases.map((c) => [c.id, c]));
  const after = new Map(b.cases.map((c) => [c.id, c]));
  const onlyA = [...before.keys()].filter((id) => !after.has(id));
  const onlyB = [...after.keys()].filter((id) => !before.has(id));
  if (onlyA.length) warnings.push(`only in the first report: ${onlyA.join(", ")}`);
  if (onlyB.length) warnings.push(`only in the second report: ${onlyB.join(", ")}`);

  const regressions: CaseChange[] = [];
  const fixes: CaseChange[] = [];
  let unchanged = 0;
  for (const [id, x] of before) {
    const y = after.get(id);
    if (!y) continue;
    const change = { id, before: `${x.passes}/${x.trials}`, after: `${y.passes}/${y.trials}` };
    const rateX = x.passes / x.trials;
    const rateY = y.passes / y.trials;
    if (rateY < rateX) regressions.push(change);
    else if (rateY > rateX) fixes.push(change);
    else unchanged += 1;
  }

  const ruleIds = [...new Set([...Object.keys(a.rules), ...Object.keys(b.rules)])].sort();
  const rules = ruleIds.map((rule) => ({
    rule,
    precision: [a.rules[rule]?.precision ?? null, b.rules[rule]?.precision ?? null] as [
      number | null,
      number | null,
    ],
    recall: [a.rules[rule]?.recall ?? null, b.rules[rule]?.recall ?? null] as [
      number | null,
      number | null,
    ],
  }));

  return {
    regressions,
    fixes,
    unchanged,
    warnings,
    cost: { before: a.cost.mean, after: b.cost.mean, delta: b.cost.mean - a.cost.mean },
    totalCost: { before: a.cost.total, after: b.cost.total, modelTrials: [a.cost.n, b.cost.n] },
    rules,
  };
}

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

export function comparisonToMarkdown(c: Comparison): string {
  const sign = c.cost.delta >= 0 ? "+" : "−";
  const lines = [
    `# Eval comparison`,
    "",
    ...c.warnings.map((w) => `> ⚠️ ${w}`),
    ...(c.warnings.length ? [""] : []),
    `**${c.regressions.length} regressions**, ${c.fixes.length} fixes, ${c.unchanged} unchanged.`,
    `Mean cost per review: $${c.cost.before.toFixed(4)} → $${c.cost.after.toFixed(4)} (${sign}$${Math.abs(c.cost.delta).toFixed(4)}).`,
    `Total cost: $${c.totalCost.before.toFixed(4)} → $${c.totalCost.after.toFixed(4)}, model ran in ${c.totalCost.modelTrials[0]} → ${c.totalCost.modelTrials[1]} trials.`,
    "",
  ];
  const table = (title: string, rows: CaseChange[]) => {
    if (rows.length === 0) return;
    lines.push(`## ${title}`, "", "| Case | Before | After |", "|---|---|---|");
    lines.push(...rows.map((r) => `| ${r.id} | ${r.before} | ${r.after} |`), "");
  };
  table("Regressions", c.regressions);
  table("Fixes", c.fixes);
  lines.push("## Rules", "", "| Rule | Precision | Recall |", "|---|---|---|");
  lines.push(
    ...c.rules.map(
      (r) =>
        `| ${r.rule} | ${pct(r.precision[0])} → ${pct(r.precision[1])} | ${pct(r.recall[0])} → ${pct(r.recall[1])} |`,
    ),
  );
  return `${lines.join("\n")}\n`;
}
