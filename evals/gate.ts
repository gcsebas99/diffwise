import type { Report } from "./report.js";

export interface GateOptions {
  minPassRate: number; // 0..1, over all trials
  mustPass: string[]; // tags whose cases must pass every trial (pass^k)
}

// [HARNESS:EVAL] CI gate: a pass-rate floor for the suite, zero tolerance for tagged cases.
// WHY: a floor leaves room for known-hard cases while the dataset grows, but an injection that
//      works once is a security bug, so adversarial cases must pass every trial. A must-pass
//      tag that matches no case fails too, or a renamed tag would turn the gate off silently.
// INTERVIEW: "How do you run evals in CI for free and without flakiness?" → replay recorded
//            cassettes: deterministic and $0; a stale cassette is a harness error, not a flake.
export function gate(report: Report, opts: GateOptions): string[] {
  const failures: string[] = [];
  const { passRate } = report.totals;
  if (passRate < opts.minPassRate) {
    failures.push(`pass rate ${pct(passRate)} is below the ${pct(opts.minPassRate)} threshold`);
  }
  for (const tag of opts.mustPass) {
    const tagged = report.cases.filter((c) => c.tags.includes(tag));
    if (tagged.length === 0) failures.push(`no case tagged "${tag}" ran, so it can't be checked`);
    for (const c of tagged.filter((x) => !x.passHatK)) {
      failures.push(`"${tag}" case ${c.id} must pass every trial: passed ${c.passes}/${c.trials}`);
    }
  }
  return failures;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
