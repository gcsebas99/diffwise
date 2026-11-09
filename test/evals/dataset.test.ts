import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CASES_DIR, type EvalCase, FIXTURES_DIR, loadCase, loadCases } from "../../evals/case.js";
import { type CaseRepo, materialize } from "../../evals/materialize.js";
import { runChecks } from "../../src/checks/index.js";
import { loadConfig } from "../../src/config.js";
import { commentableRanges, type FileDiff } from "../../src/core/diff.js";
import { reviewChanges } from "../../src/core/engine.js";
import { LocalGitSource } from "../../src/core/local-git-source.js";
import { loadRules } from "../../src/core/rules.js";

// The dataset is tested before any model sees it: a broken case would be graded as an agent
// failure on every trial.

interface Built {
  c: EvalCase;
  repo: CaseRepo;
  source: LocalGitSource;
  files: FileDiff[];
}

let cases: EvalCase[];
const built = new Map<string, Built>();

beforeAll(async () => {
  cases = await loadCases();
  for (const c of cases) {
    const repo = await materialize(c);
    const source = await LocalGitSource.open(repo.path, repo.base, repo.head);
    built.set(c.id, { c, repo, source, files: await source.diff() });
  }
}, 60_000);

afterAll(async () => {
  await Promise.all([...built.values()].map((b) => b.repo.cleanup()));
});

const get = (id: string): Built => {
  const b = built.get(id);
  if (!b) throw new Error(`case ${id} was not built`);
  return b;
};

describe("eval dataset", () => {
  it("has the suites the CI gate relies on", async () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
    expect(await loadCases("smoke")).toHaveLength(4);
    expect((await loadCases("adversarial")).length).toBeGreaterThanOrEqual(2);
    await expect(loadCases("smoek")).rejects.toThrow(/no eval case is tagged 'smoek'/);
  });

  it("has a positive and a negative case for every rule", async () => {
    const rules = await loadRules(join(FIXTURES_DIR, "rules.yaml"));
    for (const rule of rules.rules) {
      const positive = cases.some((c) => c.expect.findings.some((f) => f.rule === rule.id));
      const negative = cases.some((c) => c.expect.forbidden.some((f) => f.rule === rule.id));
      expect({ rule: rule.id, positive, negative }).toEqual({
        rule: rule.id,
        positive: true,
        negative: true,
      });
    }
  });

  it("every patch changes something and every expected range is commentable", () => {
    for (const { c, files } of built.values()) {
      expect(files.length, c.id).toBeGreaterThan(0);
      for (const f of c.expect.findings) {
        const file = files.find((x) => x.path === f.path);
        const [start, end] = f.lines;
        const hit = file && commentableRanges(file).some(([s, e]) => s <= end && e >= start);
        expect(hit, `${c.id}: ${f.rule} @ ${f.path}:${start}-${end}`).toBe(true);
      }
      // A forbidden finding on a file the PR doesn't touch can't happen, so it tests nothing.
      for (const f of c.expect.forbidden) {
        if (f.path)
          expect(
            files.map((x) => x.path),
            `${c.id}: forbidden ${f.path}`,
          ).toContain(f.path);
      }
    }
  });

  it("cases that need no model already grade correctly on the real engine", async () => {
    const noModel = cases.filter((c) => c.budgets.max_steps === 0);
    expect(noModel.length).toBeGreaterThan(0);
    for (const c of noModel) {
      const { source, files } = get(c.id);
      const out = await reviewChanges({ source, rules: c.ruleSet, files, config: loadConfig({}) });
      expect(out.modelSkipped, c.id).toBe("no-llm-rules");
      expect(out.verdict.verdict, c.id).toBe(c.expect.verdict);
      // Exactly the expected findings: nothing missing, nothing extra.
      const found = out.run.findings.map((f) => ({ rule: f.ruleId, path: f.path, line: f.line }));
      expect(found, c.id).toHaveLength(c.expect.findings.length);
      for (const e of c.expect.findings) {
        const match = found.some(
          (f) =>
            f.rule === e.rule && f.path === e.path && f.line >= e.lines[0] && f.line <= e.lines[1],
        );
        expect(match, `${c.id}: ${e.rule} @ ${e.path}`).toBe(true);
      }
    }
  });

  it("deterministic checks report nothing on the cases the model must judge", async () => {
    for (const c of cases.filter((x) => x.budgets.max_steps > 0)) {
      const { source, files } = get(c.id);
      expect(await runChecks(c.ruleSet, files, source), c.id).toEqual([]);
    }
  });
});

describe("materialize", () => {
  it("builds identical commits every time", async () => {
    const [c] = cases;
    if (!c) throw new Error("no cases");
    const again = await materialize(c);
    const sha = (path: string) =>
      execFileSync("git", ["-C", path, "rev-parse", "main", "pr"], { encoding: "utf8" });
    expect(sha(again.path)).toBe(sha(get(c.id).repo.path));
    await again.cleanup();
  });

  it("names the case when its patch doesn't apply", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "diffwise-case-")), "broken-patch");
    await cp(join(CASES_DIR, "route-no-test"), dir, { recursive: true });
    const yaml = await readFile(join(dir, "case.yaml"), "utf8");
    await writeFile(
      join(dir, "case.yaml"),
      yaml
        .replace("id: route-no-test", "id: broken-patch")
        .replace("../../fixtures/rules.yaml", join(FIXTURES_DIR, "rules.yaml")),
    );
    const patch = await readFile(join(dir, "patch.diff"), "utf8");
    await writeFile(
      join(dir, "patch.diff"),
      patch.replace("import type { Router }", "import { X }"),
    );
    await expect(materialize(await loadCase(dir))).rejects.toThrow(
      /eval case 'broken-patch': patch.diff doesn't apply/,
    );
    await rm(join(dir, ".."), { recursive: true, force: true });
  });
});

describe("loadCase", () => {
  const RULES = join(FIXTURES_DIR, "rules.yaml");
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "diffwise-cases-"));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  async function write(id: string, yaml: string, patch = true): Promise<string> {
    const dir = join(root, id);
    await cp(join(CASES_DIR, "route-no-test"), dir, { recursive: true });
    if (!patch) await rm(join(dir, "patch.diff"));
    await writeFile(join(dir, "case.yaml"), yaml.replaceAll("RULES", RULES));
    return dir;
  }

  const budgets = "budgets: { max_steps: 1, max_tokens: 1, max_cost_usd: 0 }";

  it("rejects schema errors with the field path", async () => {
    const dir = await write(
      "bad-range",
      `id: bad-range\ndescription: x\nrules: RULES\nexpect:\n  verdict: fail\n  findings:\n    - { rule: route-needs-test, path: src/routes/orders.ts, lines: [9, 3] }\n${budgets}\n`,
    );
    await expect(loadCase(dir)).rejects.toThrow(/expect\.findings\.0\.lines: start must be <= end/);
  });

  it("rejects neutral as an expected verdict", async () => {
    const dir = await write(
      "neutral",
      `id: neutral\ndescription: x\nrules: RULES\nexpect:\n  verdict: neutral\n${budgets}\n`,
    );
    await expect(loadCase(dir)).rejects.toThrow(/expect\.verdict/);
  });

  it("lists every consistency problem at once", async () => {
    const dir = await write(
      "inconsistent",
      [
        "id: wrong-id",
        "description: x",
        "rules: RULES",
        "expect:",
        "  verdict: fail",
        "  findings:",
        "    - { rule: route-needs-test, path: src/db.ts, lines: [1, 2] }",
        "  forbidden:",
        "    - { rule: no-such-rule }",
        budgets,
        "",
      ].join("\n"),
      false,
    );
    const err = await loadCase(dir).then(
      () => new Error("expected loadCase to throw"),
      (e: unknown) => e as Error,
    );
    expect(err.message).toMatch(/rule 'route-needs-test' doesn't apply to src\/db\.ts/);
    expect(err.message).toMatch(/unknown rule 'no-such-rule'/);
    expect(err.message).toMatch(/id 'wrong-id' must match the directory name/);
    expect(err.message).toMatch(/patch\.diff is missing/);
  });

  it("rejects a verdict that disagrees with the expected findings", async () => {
    const pass = await write(
      "pass-with-blocking",
      `id: pass-with-blocking\ndescription: x\nrules: RULES\nexpect:\n  verdict: pass\n  findings:\n    - { rule: route-needs-test, path: src/routes/orders.ts, lines: [1, 9] }\n${budgets}\n`,
    );
    await expect(loadCase(pass)).rejects.toThrow(/verdict 'pass' disagrees/);
    const fail = await write(
      "fail-advisory-only",
      `id: fail-advisory-only\ndescription: x\nrules: RULES\nexpect:\n  verdict: fail\n  findings:\n    - { rule: env-documented, path: src/logger.ts, lines: [1, 9] }\n${budgets}\n`,
    );
    await expect(loadCase(fail)).rejects.toThrow(/verdict 'fail' disagrees/);
  });
});
