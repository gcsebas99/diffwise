import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/core/review.js";
import { computeVerdict } from "../../src/core/verdict.js";

const finding = (severity: Finding["severity"]): Finding => ({
  ruleId: severity === "blocking" ? "route-needs-test" : "migration-reversible",
  severity,
  path: "src/routes/orders.ts",
  line: 8,
  message: "Problem.",
});

describe("computeVerdict", () => {
  it.each([
    { name: "complete, no findings", findings: [], complete: true, verdict: "pass" },
    { name: "complete, advisory only", findings: ["advisory"], complete: true, verdict: "pass" },
    { name: "complete, one blocking", findings: ["blocking"], complete: true, verdict: "fail" },
    { name: "incomplete, no findings", findings: [], complete: false, verdict: "neutral" },
    { name: "incomplete, advisory", findings: ["advisory"], complete: false, verdict: "neutral" },
    { name: "incomplete, blocking", findings: ["blocking"], complete: false, verdict: "fail" },
  ] as const)("$name → $verdict", ({ findings, complete, verdict }) => {
    expect(computeVerdict(findings.map(finding), complete).verdict).toBe(verdict);
  });

  it("counts blocking and advisory findings", () => {
    const findings = ["blocking", "advisory", "advisory"] as const;
    expect(computeVerdict(findings.map(finding), true).counts).toEqual({
      blocking: 1,
      advisory: 2,
    });
  });
});
