import { describe, expect, it } from "vitest";
import { completedCheck, erroredCheck, skippedCheck } from "../../../src/adapters/app/check-run.js";
import type { PublishInput } from "../../../src/core/publish.js";
import type { Finding } from "../../../src/core/review.js";

const finding = (i: number, severity: Finding["severity"] = "blocking"): Finding => ({
  ruleId: "route-needs-test",
  severity,
  path: "src/routes/orders.ts",
  line: i + 1,
  message: `finding ${i}`,
});

function input(findings: Finding[], verdict: "pass" | "fail" | "neutral"): PublishInput {
  const blocking = findings.filter((f) => f.severity === "blocking").length;
  return {
    run: {
      findings,
      summary: "Reviewed.",
      complete: verdict !== "neutral",
      outcome: verdict === "neutral" ? "max_steps" : "completed",
      steps: 2,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      promptVersion: "v",
    },
    verdict: { verdict, counts: { blocking, advisory: findings.length - blocking } },
    model: "claude-haiku-5-5",
    cost: 0.001,
  };
}

describe("completedCheck", () => {
  it("maps the verdict to a conclusion and titles it by blocking count", () => {
    expect(completedCheck(input([finding(0), finding(1)], "fail"))).toMatchObject({
      conclusion: "failure",
      output: { title: "2 blocking findings" },
    });
    expect(completedCheck(input([finding(0, "advisory")], "pass"))).toMatchObject({
      conclusion: "success",
      output: { title: "No blocking findings (1 advisory)" },
    });
    expect(completedCheck(input([], "neutral"))).toMatchObject({
      conclusion: "neutral",
      output: { title: "Review incomplete" },
    });
  });

  it("one annotation per finding on its line, failure for blocking, warning for advisory", () => {
    const { output } = completedCheck(input([finding(4), finding(9, "advisory")], "fail"));
    expect(output.annotations).toEqual([
      {
        path: "src/routes/orders.ts",
        startLine: 5,
        endLine: 5,
        level: "failure",
        title: "blocking · route-needs-test",
        message: "finding 4",
      },
      expect.objectContaining({ startLine: 10, level: "warning" }),
    ]);
  });

  it("sends annotations 50 per request: 120 findings are 50 now, then 50 and 20", () => {
    const many = Array.from({ length: 120 }, (_, i) => finding(i));
    const check = completedCheck(input(many, "fail"));
    expect(check.output.annotations).toHaveLength(50);
    expect(check.moreAnnotations.map((b) => b.length)).toEqual([50, 20]);
    expect(check.moreAnnotations[1]?.[19]?.startLine).toBe(120);
  });

  it("keeps the summary under GitHub's 65,535 characters and drops the review marker", () => {
    const long = [{ ...finding(0), message: "x".repeat(70_000) }];
    const { summary } = completedCheck(input(long, "fail")).output;
    expect(summary.length).toBeLessThanOrEqual(65_535);
    expect(summary).toContain("truncated");
    expect(completedCheck(input([], "pass")).output.summary).not.toContain("<!-- diffwise -->");
  });
});

describe("skippedCheck and erroredCheck", () => {
  it("say the commit wasn't reviewed, and why", () => {
    expect(skippedCheck("daily review cap (50) reached")).toEqual({
      title: "Not reviewed",
      summary: "Diffwise didn't review this commit: daily review cap (50) reached.",
    });
    const errored = erroredCheck(new Error("GitHub 502 <html>"));
    expect(errored.title).toBe("Review failed to run");
    expect(errored.summary).toContain("GitHub 502 &lt;html>"); // sanitized for markdown
    expect(errored.summary).toContain("This is not a review result");
  });
});
