# Phase 2 — GitHub Action + demo PRs

**Goal:** the engine runs inside GitHub Actions on the demo repo. Opening a PR produces one PR review with
inline comments and a summary, and the job fails when a blocking finding exists, so branch protection
can block the merge. Live LLM calls only happen when the PR has the `live-review` label.

**Pillars:** GH:ACTIONS · GH:API · GUARD · ORCH

## Kickoff prompt

> Read `CLAUDE.md`, `docs/PLAN.md` and `docs/specs/phase2.md`. Phase 1 is done (see `docs/PROGRESS.md`).
> Verify current docs for: JavaScript action metadata (`runs.using` Node version), workflow
> `permissions`, the "create a review for a pull request" endpoint (comment `line`/`side`), and how
> secrets behave on fork PRs. Then plan sub-task 2.1 only.

---

## 2.1 GitHubClient + Publisher `[GH:API]` 🟡 PASTE & REVIEW

- `src/adapters/github/client.ts`: `GitHubClient` interface with only what we need:
  `getPullRequest`, `createReview(pr, {body, event, comments[]})`, `listReviews` (to find our previous one).
  `OctokitGitHubClient` impl + `FakeGitHubClient` that records calls (for tests).
- `src/core/publish.ts`: `ReviewResult` → one review: `event: "COMMENT"` (never APPROVE; a bot shouldn't
  approve), inline comments with `path`, `line`, `side: "RIGHT"`, summary body with a findings table,
  verdict, model, `promptVersion`, steps and cost.
- **Re-runs:** on `synchronize`, mark the previous Diffwise summary as outdated rather than stacking
  duplicates (find it by a hidden HTML marker `<!-- diffwise -->` in the body).

**Accept:** tests with the fake client: comment shape, summary content, marker handling.
**Read closely:** why the verdict is the job's exit code and not a review `event`.

## 2.2 Action adapter `[GH:ACTIONS]` 🟢 YOU BUILD

- `src/adapters/action/main.ts`: read inputs with `@actions/core` (`anthropic-api-key`, `model`,
  `mode: live|deterministic-only`, `github-token`), read the PR number and SHAs from the event payload,
  build `LocalGitSource` on the checked-out workspace, run the engine, publish, then
  `core.setFailed(...)` when the verdict is `fail`.
- Mask nothing by hand: inputs from secrets are already masked, but **never log them**.
- Handle: missing API key in `live` mode → clear error; PR with zero applicable rules → pass quickly,
  no model call.

**Accept:** a unit test that runs `main` against a fixture event payload, ScriptedModel and the fake client.
**Learn:** where the PR number, base and head SHAs come from in an Actions run.

## 2.3 Package the action ⚪ CLAUDE BUILDS

- `action.yml` at the repo root (inputs, `runs.using` = current supported Node runtime, `main: dist/index.js`).
- `pnpm build:action` bundles with esbuild into `dist/index.js`; CI fails if `dist/` is stale.
- Tag `v0` so the demo repo can reference `<you>/diffwise@v0`.

**Accept:** `node dist/index.js` starts and fails gracefully with no env.

## 2.4 Workflow in the demo repo `[GH:ACTIONS]` `[GUARD]` 🟢 YOU BUILD

Write `.github/workflows/review.yml` in `diffwise-demo` yourself:

- Trigger: `pull_request` (`opened`, `synchronize`, `labeled`). **Not** `pull_request_target`.
- `permissions:` least privilege: `contents: read`, `pull-requests: write`.
- `actions/checkout` with `fetch-depth: 0` (the engine needs `base...head`).
- Mode: `live` only if the PR has the `live-review` label, else `deterministic-only`
  (Phase 3 makes deterministic checks real; for now it just skips the model).
- `concurrency` group per PR with `cancel-in-progress: true` (don't pay for stale pushes).

**Accept:** you can explain every line of the workflow, especially `permissions` and the label gate.
**Learn:** why `pull_request_target` + checking out PR code is a classic exploit.

## 2.5 Repo setup 🔧 MANUAL CONFIG

1. Anthropic Console: create a key for this project, **set a monthly spend limit**.
2. Demo repo → Settings → Secrets → Actions: add `ANTHROPIC_API_KEY`. Variable: `DIFFWISE_MODEL`.
3. Create the `live-review` label.
4. Branch protection (or a ruleset) on `main`: require the Diffwise check to pass.
5. Open the 6 seeded PRs from Phase 1 branches. Add `live-review` to each, one at a time.

**Accept:** every seeded PR shows a review; blocking ones show a failed required check and can't merge
(as non-admin, or with "include administrators" on).

## 2.6 Demo polish ⚪ CLAUDE BUILDS

- Demo repo README: what Diffwise is, link to each seeded PR with "what to look for", how the label gate works.
- Diffwise README: architecture mermaid, concept → file table (from `CONCEPTS.md`), screenshots slot.

## Interview questions

1. Walk me through what happens from "PR opened" to "merge blocked."
2. What permissions does the workflow need and why not more?
3. Why not `pull_request_target`? What happens with PRs from forks?
4. How do you control cost on a public repo?
5. What does the bot do when you push a new commit to the PR? Why not just post another review?
6. Why does the bot never approve?
