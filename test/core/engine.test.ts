import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { reviewChanges } from "../../src/core/engine.js";
import { parseRules } from "../../src/core/rules.js";
import { response, ScriptedModel, type ScriptStep, toolUse } from "../../src/model/scripted.js";
import { fileDiff } from "../fakes/diff-builder.js";
import { FakeRepoSource } from "../fakes/fake-repo-source.js";
import { RULES_YAML } from "../fakes/tool-context.js";

// A route change (needs the model) whose second line logs a token (the secrets check's job).
const ROUTE_DIFF = fileDiff("src/routes/orders.ts", [
  "router.get('/orders', list);",
  "logger.info({ token });",
]);
const DOCS_DIFF = fileDiff("README.md", ["More docs."]);

async function review(diff: string, script?: ScriptStep[]) {
  const source = new FakeRepoSource({ diff });
  const model = script ? new ScriptedModel(script) : undefined;
  const outcome = await reviewChanges({
    source,
    rules: parseRules(RULES_YAML),
    files: await source.diff(),
    ...(model ? { model, modelName: "claude-haiku-5-5" } : {}),
    config: loadConfig({}),
  });
  return { outcome, model };
}

const submit = toolUse("submit_review", { summary: "Route changed without a test." });

describe("reviewChanges", () => {
  it("runs only the checks when there is no model: complete, 0 steps, $0", async () => {
    const { outcome } = await review(ROUTE_DIFF);
    expect(outcome.modelSkipped).toBe("deterministic-only");
    expect(outcome.run).toMatchObject({ outcome: "completed", complete: true, steps: 0 });
    expect(outcome.run.summary).toBe("Only the automated checks ran; LLM rules were not checked.");
    expect(outcome.run.findings).toEqual([
      expect.objectContaining({ ruleId: "no-secrets-in-diff", line: 2 }),
    ]);
    expect(outcome.verdict.verdict).toBe("fail");
    expect(outcome.cost).toBe(0);
  });

  it("doesn't call the model when no changed file has an LLM rule", async () => {
    const { outcome, model } = await review(DOCS_DIFF, []);
    expect(outcome.modelSkipped).toBe("no-llm-rules");
    expect(model?.requests).toHaveLength(0);
    expect(outcome.verdict.verdict).toBe("pass");
  });

  it("tells the model what the checks found and counts those findings in the verdict", async () => {
    const { outcome, model } = await review(ROUTE_DIFF, [response([submit])]);
    const first = JSON.stringify(model?.requests[0]?.messages[0]);
    expect(first).toContain("Already reported by automated checks");
    expect(first).toContain("no-secrets-in-diff src/routes/orders.ts:2");
    expect(outcome.modelSkipped).toBeUndefined();
    expect(outcome.run.findings.map((f) => f.ruleId)).toEqual(["no-secrets-in-diff"]);
    expect(outcome.verdict.verdict).toBe("fail");
  });

  it("keeps the check findings when the model fails", async () => {
    const { outcome } = await review(ROUTE_DIFF, [new Error("529 Overloaded")]);
    expect(outcome.run.outcome).toBe("model_error");
    expect(outcome.run.findings).toHaveLength(1);
    expect(outcome.verdict.verdict).toBe("fail"); // proven by code, so incomplete can't hide it
  });
});
