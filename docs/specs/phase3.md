# Phase 3 — Deterministic checks + evals

**Goal:** split work between deterministic checks and the agent, then **measure** the reviewer:
a set of eval cases with expected findings, graders for precision/recall per rule, multi-trial stats,
record/replay so evals run free in CI, and one ablation.

**Pillars:** EVAL · GUARD · ORCH

## Kickoff prompt

> Read `CLAUDE.md`, `docs/PLAN.md` and `docs/specs/phase3.md`. Phases 1–2 are done.
> Evals must run with no network in replay mode. Plan sub-task 3.1 only.

---

## 3.1 Deterministic checks `[HARNESS:GUARD]` 🟡 PASTE & REVIEW

- `src/checks/`: `Check` = id, `run(diff, source) → Finding[]`. Implement:
  - `secrets`: regexes over **added lines only** (AWS keys, `ghp_`/`github_pat_`, `sk-ant-`, private key
    headers, `password = "..."`) plus "token-looking variable passed to a logger".
  - `env-documented`: new `process.env.X` in added lines without `X=` in `.env.example`.
- Wire into the engine: deterministic rules run **before** the loop; their findings go in the initial
  message as "already reported, don't duplicate"; LLM-check rules are the only ones in the prompt.
- Secret findings **redact** the matched value in the comment.

**Accept:** tests per check incl. a false-positive case (a placeholder like `sk-ant-xxxx` in docs).
**Read closely:** why the redaction matters (the comment itself would re-publish the secret).

## 3.2 Record / replay `[HARNESS:EVAL]` `[HARNESS:ORCH]` 🟡 PASTE & REVIEW

- `RecordingModel` wraps `AnthropicModel`, writes request/response pairs to
  `evals/cassettes/<case>/<trial>.jsonl` keyed by a **stable hash** of (model, system, messages, tools)
  after normalizing volatile fields.
- `ReplayModel` serves from cassettes; a miss **fails loudly** with the hash and a "re-record" hint.

**Accept:** record a run, replay it byte-identically; change one rule's text → replay fails clearly.
**Learn:** replay tests the harness deterministically; live runs test model + prompt. You need both.

## 3.3 Eval cases `[HARNESS:EVAL]` 🟢 YOU BUILD

Design the dataset yourself; this is the judgment-heavy part.

- `evals/cases/<id>/`: `base/` and `head/` (or a `patch.diff` applied to a shared fixture), plus `case.yaml`:

```yaml
id: route-change-no-test
rules: ../../fixtures/rules.yaml
expect:
  findings:
    - { rule: route-needs-test, path: src/routes/users.ts, lines: [10, 30] }
  forbidden:                      # must NOT be reported
    - { rule: env-documented }
  verdict: fail
budgets: { max_steps: 15, max_tokens: 60000, max_cost_usd: 0.10 }
tags: [routes, happy-path]
```

- At least **12 cases**: every rule positive + negative; 2 "subtle" ones (test changed but doesn't
  cover the new branch; migration `down` exists but is a no-op); 2 injection cases (PR body and a code
  comment telling the reviewer to approve); 1 large PR (budget pressure); 2 clean PRs (false-positive traps).
- Suites: `smoke` (4 cases), `full`, `adversarial` (tag filter).

**Accept:** you can say why each case exists in one sentence (put it in `description:`).

## 3.4 Graders `[HARNESS:EVAL]` 🟢 YOU BUILD

`evals/graders/`, each returns `{ name, passed, score, details }`:

1. **Findings match:** an expected finding matches a reported one if rule matches, path matches, line
   falls in range. Produces TP / FP / FN per rule.
2. **Verdict:** exact match.
3. **Forbidden:** none of the `forbidden` findings present (this is where injection cases fail).
4. **Budget:** steps, tokens, cost within budgets.

Case passes if verdict matches, no forbidden findings, recall = 1 on blocking rules, budget OK.

**Accept:** grader unit tests with hand-made results (perfect, missed one, extra one, wrong line).
**Learn:** why precision matters as much as recall for a review bot (noisy bots get muted).

## 3.5 Runner + report `[HARNESS:EVAL]` 🟡 PASTE & REVIEW

- `pnpm eval --suite full --k 3 --mode live|record|replay --concurrency 3`.
- Each trial isolated (fresh temp checkout of the case).
- Report `evals/reports/<timestamp>.md` + JSON: per-case pass, **pass@k** and **pass^k**, precision and
  recall **per rule**, mean/p95 cost and latency, `promptVersion`, model, git sha.
- `pnpm eval compare <a.json> <b.json>`: regressions (pass→fail), fixes, cost delta.

## 3.6 CI gate ⚪ CLAUDE BUILDS

- `ci.yml`: `pnpm eval --suite full --mode replay`; fail if pass rate < threshold or any `adversarial` case fails.
- `eval-live.yml`: `workflow_dispatch` only, uses the API key secret, uploads the report as an artifact.

## 3.7 Ablation 🟢 YOU BUILD (the write-up, not the code)

Run `full` with k=3 for one comparison and write `docs/ablations.md` (table + 3-sentence conclusion):
- deterministic checks on vs off (does moving rules out of the LLM change precision and cost?), **or**
- cheap model vs stronger model (quality vs cost per review).

## Interview questions

1. How do you evaluate a non-deterministic reviewer? (k trials, pass@k vs pass^k)
2. How did you pick eval cases? How do you stop the set going stale? (turn real bad reviews into cases)
3. Precision vs recall for a review bot: which hurts more and why?
4. When does a rule belong in a regex instead of an LLM?
5. How do you run evals in CI for free and without flakiness?
6. A prompt change raised recall 10% but doubled false positives. Ship it?
