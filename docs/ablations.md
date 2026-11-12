# Ablations

## Deterministic checks on vs off (3.7, 2026-11-11)

**Question:** `no-secrets-in-diff` and `env-documented` run as code (`src/checks/`). If the LLM
handled them instead, what would change in precision, recall and cost?

**Setup:** `full` suite, k = 3, `claude-haiku-5-5`, both runs on the same commit. The only
change is the rules file:

- **Checks on:** each case uses its own rules, `evals/fixtures/rules.yaml`. These numbers come
  from replaying the cassettes recorded on 2026-11-10, which matched that live run exactly.
- **Checks off:** `--rules evals/fixtures/rules-llm-only.yaml`, run live. It keeps the same rule
  ids, severities and `applies_to`. The two checks become `check: llm`, with instructions that
  describe what the regexes look for.

| | Checks on | Checks off (LLM only) |
|---|---|---|
| Pass rate (pass^3) | 100% (100%) | 67% (67%) |
| Trials where the quality graders passed (findings, verdict, forbidden) | 54/54 | 54/54 |
| Trials where the model ran | 36 | 54 |
| Precision: `no-secrets-in-diff` | 100% (6 TP, 0 FP) | 86% (6 TP, 1 FP) |
| Precision: `env-documented` | 100% (3 TP, 0 FP) | 100% (3 TP, 0 FP) |
| Precision: `route-needs-test` | 100% (15 TP, 0 FP) | 94% (15 TP, 1 FP) |
| Precision: `migration-reversible` | 100% (12 TP, 0 FP) | 92% (12 TP, 1 FP) |
| Recall, every rule | 100% | 100% |
| Total cost | $0.0206 | $0.0314 (+52%) |
| Cost per review: mean, p95 | $0.0006, $0.0009 | $0.0006, $0.0014 |
| Model latency per review: mean, p95 | 3.9s, 5.2s | 3.9s, 6.5s |
| Time per trial when checks-only: mean | 0.3s | n/a (every trial calls the model) |

**Notes on the numbers:**

- **All 18 failed trials failed only the budget grader.** Those 6 cases (the secrets, env and
  docs-only cases) set `max_steps: 0`, meaning "the model must not run". Their findings,
  verdicts and forbidden lists all passed. So the drop to 67% shows that those cases now pay
  for a model call. It doesn't show worse findings.
- **The mean cost per review didn't change; the total did.** The LLM-only run calls the model
  on 54 trials instead of 36. `compare` now prints the total cost and the number of model
  trials, because the mean alone hid this.
- **The sample is small.** Each false positive is a single finding, and the baseline is one
  recording. The false positives on the route and migration rules may come from a longer prompt
  (four rules to keep in mind instead of two) or may be ordinary run-to-run variance. The report
  doesn't keep the findings of each trial, so I can't say which cases they were in.

**Conclusion:** Haiku found every secret and every undocumented env variable, the same as the
regex checks, so moving these rules to code didn't gain recall on this dataset. What code gained
was cost and reliability: 18 fewer model calls (−34% total cost), sub-second checks-only reviews,
and no false positives. Rules that a pattern can express (secrets, a name missing from a file)
belong in code, and the LLM's attention belongs to judgment rules like "does this test exercise
the changed behavior?".

**To do this properly:**

- Keep each trial's findings in the report, so a false positive can be traced to its case.
- Add harder secret cases (an encoded key, a secret split across lines), where a regex should
  miss and the LLM might not.
