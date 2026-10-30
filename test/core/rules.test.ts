import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { loadRules, parseRules, RulesError, rulesForFile } from "../../src/core/rules.js";

const llmRule = {
  id: "route-needs-test",
  title: "API route changes need a test change",
  severity: "blocking",
  applies_to: ["src/routes/**"],
  check: "llm",
  instructions: "If a route handler's behavior changes, the PR must change a test.",
};
const secretsRule = {
  id: "no-secrets-in-diff",
  title: "No secrets in code or logs",
  severity: "blocking",
  applies_to: ["**/*"],
  check: "deterministic:secrets",
};

const rulesYaml = (...rules: Record<string, unknown>[]) => stringify({ version: 1, rules });

// Returns the problem list so tests can assert on exact, user-facing messages.
function problemsOf(text: string): string[] {
  try {
    parseRules(text);
  } catch (err) {
    if (err instanceof RulesError) return err.problems;
    throw err;
  }
  throw new Error("expected parseRules to fail");
}

describe("parseRules", () => {
  it("parses a valid file and turns check strings into tagged values", () => {
    const { rules } = parseRules(rulesYaml(llmRule, secretsRule));
    expect(rules.map((r) => [r.id, r.check])).toEqual([
      ["route-needs-test", { kind: "llm" }],
      ["no-secrets-in-diff", { kind: "deterministic", name: "secrets" }],
    ]);
  });

  it("names the rule, field, bad value and allowed values for an invalid severity", () => {
    expect(problemsOf(rulesYaml({ ...llmRule, severity: "high" }))).toEqual([
      "rule 'route-needs-test': severity: expected blocking|advisory, got 'high'",
    ]);
  });

  it("rejects an unknown check kind", () => {
    expect(problemsOf(rulesYaml({ ...llmRule, check: "regex" }))).toEqual([
      "rule 'route-needs-test': check: unknown check 'regex', expected llm|deterministic:<name>",
    ]);
  });

  it("rejects an unknown deterministic check name", () => {
    expect(problemsOf(rulesYaml({ ...secretsRule, check: "deterministic:nope" }))).toEqual([
      "rule 'no-secrets-in-diff': check: unknown deterministic check 'nope', expected one of secrets|env-documented",
    ]);
  });

  it("requires instructions on llm rules", () => {
    const { instructions: _, ...noInstructions } = llmRule;
    expect(problemsOf(rulesYaml(noInstructions))).toEqual([
      "rule 'route-needs-test': instructions: is required when check is llm (it tells the reviewer what to look for)",
    ]);
  });

  it("rejects duplicate ids", () => {
    expect(problemsOf(rulesYaml(llmRule, llmRule))).toEqual([
      "rule 'route-needs-test': id: duplicate id 'route-needs-test'",
    ]);
  });

  it("rejects unknown keys instead of silently dropping them", () => {
    expect(problemsOf(rulesYaml({ ...secretsRule, instruction: "typo" }))).toEqual([
      "rule 'no-secrets-in-diff': unknown key 'instruction'",
    ]);
  });

  it("reports every problem in one pass", () => {
    expect(problemsOf(rulesYaml({ ...llmRule, severity: "high", check: "regex" }))).toHaveLength(2);
  });

  it("reports YAML syntax errors with a location", () => {
    expect(problemsOf("version: 1\nrules: [")).toEqual([
      expect.stringMatching(/^YAML syntax error: .*line 2/),
    ]);
  });

  it("rejects an empty file and an unsupported version", () => {
    expect(problemsOf("")).toEqual(["file is empty"]);
    expect(problemsOf(stringify({ version: 2, rules: [llmRule] }))).toEqual([
      "version: expected 1, got 2",
    ]);
  });
});

describe("loadRules", () => {
  it("reads and parses a file from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diffwise-rules-"));
    const path = join(dir, ".review-rules.yaml");
    await writeFile(path, rulesYaml(llmRule));
    const { rules } = await loadRules(path);
    expect(rules.map((r) => r.id)).toEqual(["route-needs-test"]);
  });

  it("explains a missing file", async () => {
    const path = join(tmpdir(), "does-not-exist", ".review-rules.yaml");
    await expect(loadRules(path)).rejects.toThrow(RulesError);
    await expect(loadRules(path)).rejects.toThrow(/file not found/);
  });
});

describe("rulesForFile", () => {
  const ruleSet = parseRules(
    rulesYaml(llmRule, secretsRule, {
      ...llmRule,
      id: "migration-reversible",
      applies_to: ["migrations/**", "db/migrations/**"],
    }),
  );
  const idsFor = (path: string) => rulesForFile(ruleSet, path).map((r) => r.id);

  it("matches nested paths under a glob", () => {
    expect(idsFor("src/routes/v2/orders.ts")).toEqual(["route-needs-test", "no-secrets-in-diff"]);
  });

  it("matches any of a rule's globs", () => {
    expect(idsFor("db/migrations/003.ts")).toEqual(["no-secrets-in-diff", "migration-reversible"]);
  });

  it("includes dotfiles and dot-directories in **/*", () => {
    expect(idsFor(".env.example")).toEqual(["no-secrets-in-diff"]);
    expect(idsFor(".github/workflows/ci.yml")).toEqual(["no-secrets-in-diff"]);
  });

  it("does not match outside a rule's globs", () => {
    expect(idsFor("src/app.ts")).toEqual(["no-secrets-in-diff"]);
    expect(idsFor("test/routes/orders.test.ts")).toEqual(["no-secrets-in-diff"]);
  });

  it("treats a leading ./ the same as a bare repo-relative path", () => {
    expect(idsFor("./src/routes/orders.ts")).toEqual(idsFor("src/routes/orders.ts"));
  });
});
