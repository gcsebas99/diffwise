import { describe, expect, it } from "vitest";
import { type EvalCase, loadCases } from "../../evals/case.js";
import { type RunOptions, runSuite, runTrial } from "../../evals/runner.js";
import { loadConfig } from "../../src/config.js";
import { response, ScriptedModel, toolUse } from "../../src/model/scripted.js";
import { HarnessError } from "../../src/model/types.js";

const all = await loadCases();
const byId = (id: string): EvalCase => {
  const c = all.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
};

// A correct review of route-no-test: one finding inside the expected range, then submit.
const correctReview = () =>
  new ScriptedModel([
    response(
      [
        toolUse("report_finding", {
          rule_id: "route-needs-test",
          path: "src/routes/orders.ts",
          line: 9,
          message: "The new status filter and its 400 have no test.",
        }),
      ],
      { inputTokens: 3000, outputTokens: 150 },
    ),
    {
      ...response([toolUse("submit_review", { summary: "Untested route change." })]),
      latencyMs: 700,
    },
  ]);

function options(createModel: RunOptions["createModel"]): RunOptions {
  return { config: loadConfig({}), modelName: "claude-haiku-5-5", createModel };
}

describe("runTrial", () => {
  it("grades a scripted review on a real case repo", async () => {
    const t = await runTrial(
      byId("route-no-test"),
      1,
      options(() => correctReview()),
    );
    if (t.status !== "graded") throw new Error(t.error);
    expect(t.grade.passed).toBe(true);
    expect(t).toMatchObject({
      caseId: "route-no-test",
      trial: 1,
      outcome: "completed",
      modelUsed: true,
    });
    expect(t.result.steps).toBe(2);
    expect(t.latencyMs).toBe(700); // summed from the responses, not wall time
    expect(t.result.cost).toBeGreaterThan(0);
  });

  it("never builds a model for a case with no LLM rule", async () => {
    const t = await runTrial(
      byId("docs-only"),
      1,
      options(() => {
        throw new Error("createModel must not be called");
      }),
    );
    expect(t).toMatchObject({ status: "graded", modelUsed: false, promptVersion: "none" });
  });

  it("a harness error is an error record, not a failed grade", async () => {
    const stale = new ScriptedModel([new HarnessError("cassette miss at messages[0]")]);
    const t = await runTrial(
      byId("route-no-test"),
      2,
      options(() => stale),
    );
    expect(t).toMatchObject({ status: "error", trial: 2, error: "cassette miss at messages[0]" });
  });

  it("an API failure is the agent's outcome: graded, and it fails", async () => {
    const down = new ScriptedModel([new Error("529 overloaded")]);
    const t = await runTrial(
      byId("route-no-test"),
      1,
      options(() => down),
    );
    if (t.status !== "graded") throw new Error(t.error);
    expect(t.outcome).toBe("model_error");
    expect(t.grade.passed).toBe(false);
  });
});

describe("runSuite", () => {
  it("runs k trials per case and keeps case/trial order under concurrency", async () => {
    const cases = [byId("route-no-test"), byId("docs-only")];
    const calls: string[] = [];
    const records = await runSuite(cases, {
      ...options((c, trial) => {
        calls.push(`${c.id}#${trial}`);
        return correctReview();
      }),
      k: 3,
      concurrency: 4,
    });
    expect(records.map((r) => `${r.caseId}#${r.trial}`)).toEqual([
      "route-no-test#1",
      "route-no-test#2",
      "route-no-test#3",
      "docs-only#1",
      "docs-only#2",
      "docs-only#3",
    ]);
    expect(calls.sort()).toEqual(["route-no-test#1", "route-no-test#2", "route-no-test#3"]);
    expect(records.every((r) => r.status === "graded" && r.grade.passed)).toBe(true);
  });
});
