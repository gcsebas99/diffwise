import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { runChecks } from "../../src/checks/index.js";
import { parseUnifiedDiff } from "../../src/core/diff.js";
import { parseRules } from "../../src/core/rules.js";
import { fileDiff } from "../fakes/diff-builder.js";
import { FakeRepoSource } from "../fakes/fake-repo-source.js";

const rules = parseRules(
  stringify({
    version: 1,
    rules: [
      {
        id: "no-secrets-in-diff",
        title: "No secrets",
        severity: "blocking",
        applies_to: ["**/*"],
        check: "deterministic:secrets",
      },
      {
        id: "env-documented",
        title: "Env vars documented",
        severity: "advisory",
        applies_to: ["src/**"],
        check: "deterministic:env-documented",
      },
      {
        id: "route-needs-test",
        title: "Routes need tests",
        severity: "blocking",
        applies_to: ["src/routes/**"],
        check: "llm",
        instructions: "Route changes need a test change.",
      },
    ],
  }),
);

const diff = [
  fileDiff("src/routes/orders.ts", ["logger.info({ token });", "process.env.ORDERS_LIMIT;"]),
  fileDiff("test/orders.test.ts", ["process.env.TEST_ONLY_FLAG = '1';"]),
].join("");

describe("runChecks", () => {
  it("runs each deterministic rule on its applies_to files, with the rule's id and severity", async () => {
    const findings = await runChecks(rules, parseUnifiedDiff(diff), new FakeRepoSource());
    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: "no-secrets-in-diff",
        severity: "blocking",
        path: "src/routes/orders.ts",
        line: 1,
      }),
      expect.objectContaining({
        ruleId: "env-documented",
        severity: "advisory",
        path: "src/routes/orders.ts",
        line: 2,
      }),
    ]);
    // test/ is outside env-documented's src/** scope, so TEST_ONLY_FLAG isn't reported.
    expect(JSON.stringify(findings)).not.toContain("TEST_ONLY_FLAG");
  });
});
