# LEARNING.md — my notes, in my own words

One section per concept. 3–5 lines each: what it is, where Diffwise implements it (file), one tradeoff.
If I can't write it without looking, I don't understand it yet.

## Phase 1 — Core engine
### Diff model & commentable lines
### Tools & registry (descriptions, errors back to the model, truncation)
### Prompt assembly (untrusted PR content, progressive disclosure, caching)
### Agent loop & exit conditions
### Verdict by code

## Phase 2 — GitHub Action
### Action runtime & event payload
### Workflow permissions, label gate, pull_request vs pull_request_target
### Publishing a review (line/side, re-runs)

## Phase 3 — Checks & evals
### Deterministic vs LLM rules
### Record / replay
### Eval case design
### Precision / recall per rule, pass@k vs pass^k
### Ablation findings

## Phase 4 — GitHub App
### App JWT → installation token
### Webhook signature & idempotency
### Reading a PR through the API (no code execution)
### Check runs
### Render deploy tradeoffs

## Interview answers I want to nail
-
