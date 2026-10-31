import { describe, expect, it } from "vitest";
import { parseRules } from "../../../src/core/rules.js";
import { createDefaultRegistry } from "../../../src/core/tools/index.js";
import { makeContext, RULES_YAML } from "../../fakes/tool-context.js";

const registry = createDefaultRegistry();
const valid = {
  rule_id: "route-needs-test",
  path: "src/routes/orders.ts",
  line: 4,
  message: "New DELETE /orders/:id route has no test.",
};

describe("report_finding", () => {
  it("records a valid finding with the rule's severity, ignoring a model-supplied one", async () => {
    const ctx = await makeContext();
    const result = await registry.execute(
      "report_finding",
      { ...valid, severity: "advisory" },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      content: "Recorded finding #1: route-needs-test (blocking) at src/routes/orders.ts:4.",
    });
    expect(ctx.state.findings).toEqual([
      {
        ruleId: "route-needs-test",
        severity: "blocking",
        path: "src/routes/orders.ts",
        line: 4,
        message: valid.message,
      },
    ]);
  });

  it.each([
    [
      { rule_id: "made-up" },
      "Unknown rule_id 'made-up'. Valid rule ids: route-needs-test, migration-reversible.",
    ],
    [{ rule_id: "no-secrets-in-diff" }, "checked automatically by code"],
    [{ path: "../etc/passwd" }, "contains '..'"],
    [{ path: "src/app.ts" }, "'src/app.ts' is not changed in this PR"],
    [
      { rule_id: "migration-reversible" },
      "doesn't apply to src/routes/orders.ts (it covers migrations/**)",
    ],
    [{ line: 30 }, "Line 30 of src/routes/orders.ts is not in the diff. Commentable lines: 1-9."],
    [{ path: "src/legacy.ts", rule_id: "route-needs-test" }, "doesn't apply to src/legacy.ts"],
  ])("rejects %j", async (override, expected) => {
    const ctx = await makeContext();
    const result = await registry.execute("report_finding", { ...valid, ...override }, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain(expected);
    expect(ctx.state.findings).toEqual([]);
  });

  it("sends problems in a file with no commentable lines to the summary", async () => {
    // Widen the route rule to all of src/, so the deleted file passes the "rule applies" check.
    const rules = parseRules(RULES_YAML.replace("src/routes/**", "src/**"));
    const ctx = await makeContext({ rules });
    const result = await registry.execute(
      "report_finding",
      { ...valid, path: "src/legacy.ts", line: 1 },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toBe(
      "src/legacy.ts has no commentable lines (deleted). Mention this problem in submit_review's summary instead.",
    );
  });

  it("rejects a duplicate rule/path/line", async () => {
    const ctx = await makeContext();
    await registry.execute("report_finding", valid, ctx);
    const again = await registry.execute("report_finding", valid, ctx);
    expect(again.ok).toBe(false);
    expect(again.content).toContain("Already reported route-needs-test at src/routes/orders.ts:4");
    expect(ctx.state.findings).toHaveLength(1);
  });
});

describe("submit_review", () => {
  it("stores the summary and reports the finding count", async () => {
    const ctx = await makeContext();
    await registry.execute("report_finding", valid, ctx);
    const result = await registry.execute(
      "submit_review",
      { summary: "Adds two routes, no tests." },
      ctx,
    );
    expect(result).toMatchObject({ ok: true, content: "Review submitted with 1 finding." });
    expect(ctx.state.summary).toBe("Adds two routes, no tests.");
  });

  it("rejects an empty summary", async () => {
    const ctx = await makeContext();
    const result = await registry.execute("submit_review", { summary: "" }, ctx);
    expect(result.ok).toBe(false);
    expect(ctx.state.summary).toBeUndefined();
  });
});
