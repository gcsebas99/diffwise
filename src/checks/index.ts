import type { FileDiff } from "../core/diff.js";
import type { RepoSource } from "../core/repo-source.js";
import type { Finding } from "../core/review.js";
import { type DeterministicCheck, type RuleSet, rulesForFile } from "../core/rules.js";
import { envDocumentedCheck } from "./env-documented.js";
import { secretsCheck } from "./secrets.js";
import type { Check } from "./types.js";

// Typed by the names the rules schema accepts: adding a name there without a check here is a
// compile error, not a rule that silently never runs.
const CHECKS: Record<DeterministicCheck, Check> = {
  secrets: secretsCheck,
  "env-documented": envDocumentedCheck,
};

// [HARNESS:GUARD] Deterministic first: pattern rules run as code, before the model.
// WHY: a regex never misses what it covers, costs nothing, and can't be talked out of a
//      finding by a prompt injection; the model only gets the rules that need judgment.
// INTERVIEW: "What do you give the LLM and what not?" → anything a pattern can decide runs as
//            code; the model gets judgment calls, and can't remove what code already found.
export async function runChecks(
  rules: RuleSet,
  files: readonly FileDiff[],
  source: RepoSource,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const rule of rules.rules) {
    if (rule.check.kind !== "deterministic") continue;
    const scoped = files.filter((file) => rulesForFile(rules, file.path).includes(rule));
    if (scoped.length === 0) continue;
    const hits = await CHECKS[rule.check.name].run({ files: scoped, source });
    // Rule id and severity come from the rules file, like every other finding.
    findings.push(...hits.map((hit) => ({ ...hit, ruleId: rule.id, severity: rule.severity })));
  }
  return findings;
}
