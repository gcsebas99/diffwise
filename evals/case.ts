import { access, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { loadRules, type RuleSet, rulesForFile } from "../src/core/rules.js";

export const EVALS_DIR = dirname(fileURLToPath(import.meta.url));
export const CASES_DIR = join(EVALS_DIR, "cases");
export const FIXTURES_DIR = join(EVALS_DIR, "fixtures");
export const FULL_SUITE = "full";

const KebabId = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be kebab-case");

const LineRange = z
  .tuple([z.int().positive(), z.int().positive()])
  .refine(([start, end]) => start <= end, "start must be <= end");

// [HARNESS:EVAL] An eval case is a PR plus the review a careful human would write.
// WHY: findings match on rule + path + a line *range*: two runs anchored the same migration
//      finding on line 3 and line 9, both right. Exact lines would grade correct reviews as misses.
// INTERVIEW: "How do you grade a non-deterministic reviewer?" → grade what matters (rule, file,
//            region, verdict), not incidental choices (exact line, wording).
const ExpectedFinding = z.strictObject({
  rule: KebabId,
  path: z.string().min(1),
  lines: LineRange,
});
const ForbiddenFinding = z.strictObject({ rule: KebabId, path: z.string().min(1).optional() });

export const CaseFileSchema = z.strictObject({
  id: KebabId,
  description: z.string().trim().min(1),
  rules: z.string().min(1), // relative to the case directory
  pr: z.strictObject({ title: z.string().optional(), body: z.string().optional() }).optional(),
  expect: z.strictObject({
    // No "neutral": it means the review didn't finish, which is never the correct answer.
    verdict: z.enum(["pass", "fail"]),
    findings: z.array(ExpectedFinding).default([]),
    forbidden: z.array(ForbiddenFinding).default([]), // e.g. what an injection asks for
  }),
  budgets: z.strictObject({
    max_steps: z.int().nonnegative(), // 0 = the model must not run at all
    max_tokens: z.int().nonnegative(),
    max_cost_usd: z.number().nonnegative(),
  }),
  tags: z.array(KebabId).default([]),
});

export type CaseFile = z.infer<typeof CaseFileSchema>;

export interface EvalCase extends CaseFile {
  dir: string;
  patchPath: string; // applied on top of fixtures/app to make the head commit
  rulesPath: string;
  ruleSet: RuleSet;
}

export class CaseError extends Error {
  readonly problems: string[];

  constructor(dir: string, problems: string[]) {
    super(`Problems in eval case ${dir}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "CaseError";
    this.problems = problems;
  }
}

export async function loadCase(dir: string): Promise<EvalCase> {
  const raw: unknown = parse(await readFile(join(dir, "case.yaml"), "utf8"));
  const result = CaseFileSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new CaseError(dir, problems);
  }
  const file = result.data;
  const rulesPath = resolve(dir, file.rules);
  const ruleSet = await loadRules(rulesPath);
  const patchPath = join(dir, "patch.diff");
  const problems = consistencyProblems(file, ruleSet);
  if (basename(dir) !== file.id) problems.push(`id '${file.id}' must match the directory name`);
  const hasPatch = await access(patchPath).then(
    () => true,
    () => false,
  );
  if (!hasPatch) problems.push("patch.diff is missing");
  if (problems.length > 0) throw new CaseError(dir, problems);
  return { ...file, dir, patchPath, rulesPath, ruleSet };
}

// [HARNESS:EVAL] Check the expectations against the rules before any model runs.
// WHY: a case that expects an impossible finding (unknown rule, a file the rule doesn't cover,
//      "fail" with no blocking finding) fails every trial, and the report blames the agent.
function consistencyProblems(file: CaseFile, ruleSet: RuleSet): string[] {
  const problems: string[] = [];
  const byId = new Map(ruleSet.rules.map((rule) => [rule.id, rule]));
  const covers = (ruleId: string, path: string) =>
    rulesForFile(ruleSet, path).some((rule) => rule.id === ruleId);

  for (const f of [...file.expect.findings, ...file.expect.forbidden]) {
    if (!byId.has(f.rule)) problems.push(`unknown rule '${f.rule}'`);
    else if (f.path && !covers(f.rule, f.path)) {
      problems.push(`rule '${f.rule}' doesn't apply to ${f.path}, so it can never be reported`);
    }
  }
  // The verdict is computed by code from the findings, so the two must agree.
  const blocking = file.expect.findings.some((f) => byId.get(f.rule)?.severity === "blocking");
  if (blocking !== (file.expect.verdict === "fail")) {
    problems.push(
      `verdict '${file.expect.verdict}' disagrees with the findings: fail iff a blocking finding is expected`,
    );
  }
  return problems;
}

// "full" is every case; any other suite name is a tag (smoke, adversarial, routes, ...).
export async function loadCases(suite = FULL_SUITE, casesDir = CASES_DIR): Promise<EvalCase[]> {
  const entries = await readdir(casesDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => join(casesDir, e.name));
  const cases = await Promise.all(dirs.sort().map(loadCase));
  if (suite === FULL_SUITE) return cases;
  const selected = cases.filter((c) => c.tags.includes(suite));
  // A typo in --suite would otherwise "pass" by running nothing.
  if (selected.length === 0) throw new Error(`no eval case is tagged '${suite}'`);
  return selected;
}
