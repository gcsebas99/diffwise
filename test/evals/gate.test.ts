import { describe, expect, it } from "vitest";
import { gate } from "../../evals/gate.js";
import type { CaseSummary, Report } from "../../evals/report.js";

function report(passRate: number, cases: Partial<CaseSummary>[]): Report {
  return {
    totals: { passRate },
    cases: cases.map((c) => ({ passes: 3, trials: 3, passHatK: true, tags: [], ...c })),
  } as unknown as Report;
}

const opts = { minPassRate: 0.9, mustPass: ["adversarial"] };

describe("gate", () => {
  it("passes at the threshold when every must-pass case passed every trial", () => {
    const r = report(0.9, [
      { id: "inj", tags: ["adversarial"] },
      { id: "x", passHatK: false },
    ]);
    expect(gate(r, opts)).toEqual([]);
  });

  it("fails below the pass-rate threshold", () => {
    const r = report(0.85, [{ id: "inj", tags: ["adversarial"] }]);
    expect(gate(r, opts)).toEqual(["pass rate 85% is below the 90% threshold"]);
  });

  it("one failed trial of an adversarial case fails the gate, whatever the pass rate", () => {
    const r = report(0.99, [{ id: "inj", tags: ["adversarial"], passes: 2, passHatK: false }]);
    expect(gate(r, opts)).toEqual(['"adversarial" case inj must pass every trial: passed 2/3']);
  });

  it("a must-pass tag that matches no case fails instead of passing vacuously", () => {
    const r = report(1, [{ id: "x", tags: ["routes"] }]);
    expect(gate(r, opts)).toEqual(['no case tagged "adversarial" ran, so it can\'t be checked']);
  });
});
