import { describe, expect, it } from "vitest";
import { formatEvent, formatReport } from "../src/cli-format.js";
import type { ReviewRun } from "../src/core/loop.js";
import { computeVerdict } from "../src/core/verdict.js";

const usage = { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 2549, cacheWriteTokens: 0 };

const RUN: ReviewRun = {
  outcome: "completed",
  complete: true,
  findings: [
    {
      ruleId: "migration-reversible",
      severity: "advisory",
      path: "migrations/002_add_status.sql",
      line: 1,
      message: "No down migration.",
    },
    {
      ruleId: "route-needs-test",
      severity: "blocking",
      path: "src/routes/orders.ts",
      line: 9,
      message: "Second problem.",
    },
    {
      ruleId: "route-needs-test",
      severity: "blocking",
      path: "src/routes/orders.ts",
      line: 3,
      message: "New filter has no test.",
      suggestion: "Add a test in test/routes/orders.test.ts.",
    },
  ],
  summary: "Adds a status filter without tests.",
  steps: 3,
  usage,
  promptVersion: "1c7d2e8afc90",
};

describe("formatEvent", () => {
  it("formats model calls, tool calls and nudges", () => {
    const lines = [
      formatEvent(
        { type: "model_call", step: 2, usage, latencyMs: 2900, stopReason: "tool_use" },
        false,
      ),
      formatEvent(
        { type: "tool_call", step: 2, name: "read_file", ok: true, truncated: true },
        false,
      ),
      formatEvent(
        { type: "tool_call", step: 2, name: "get_file_diff", ok: false, truncated: false },
        false,
      ),
      formatEvent({ type: "nudge", step: 3, reason: "no_tool_call" }, false),
    ];
    expect(lines).toEqual([
      "step 2  2.9s  in 3,749 (2,549 cached)  out 300",
      "  ✓ read_file (truncated)",
      "  ✗ get_file_diff",
      "  ↻ nudge: no tool call",
    ]);
  });

  it("prints nothing for step and exit events", () => {
    expect(formatEvent({ type: "step", step: 1 }, false)).toBeUndefined();
    expect(formatEvent({ type: "exit", step: 1, outcome: "completed" }, false)).toBeUndefined();
  });
});

describe("formatReport", () => {
  it("groups findings by file, sorted by line, then verdict and stats", () => {
    const report = formatReport(RUN, computeVerdict(RUN.findings, true), 0.00063, false);
    expect(report).toMatchSnapshot();
  });

  it("marks an incomplete run and its error", () => {
    const run: ReviewRun = {
      ...RUN,
      outcome: "model_error",
      complete: false,
      findings: [],
      summary: undefined,
      error: "Overloaded",
    };
    const report = formatReport(run, computeVerdict([], false), undefined, false);
    expect(report).toContain("(no summary: the review did not finish)");
    expect(report).toContain("Verdict: NEUTRAL  (0 blocking, 0 advisory)");
    expect(report).toContain("Outcome: model_error (incomplete): Overloaded");
    expect(report).toContain("cost unknown");
  });

  it("adds ANSI color codes only when asked", () => {
    const verdict = computeVerdict(RUN.findings, true);
    expect(formatReport(RUN, verdict, 0.00063, true)).toContain("\u001b[");
    expect(formatReport(RUN, verdict, 0.00063, false)).not.toContain("\u001b[");
  });
});
