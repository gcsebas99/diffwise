# Phase 4 — GitHub App on Render

**Goal:** the same engine, delivered as a **GitHub App**: GitHub sends a webhook to a Hono server on
Render, the server verifies it, authenticates as the App installation, reads the PR through the API
(never executing PR code), reviews it, and reports the verdict as a **check run**.

**Pillars:** GH:WEBHOOK · GH:AUTH · GH:API · GUARD · OBS

## Kickoff prompt

> Read `CLAUDE.md`, `docs/PLAN.md` and `docs/specs/phase4.md`. Phases 1–3 are done.
> Verify current GitHub docs for: webhook headers and signature verification, the App JWT claims
> (iss = client ID or app ID, iat/exp limits), the installation access token endpoint, check runs,
> and the webhook delivery timeout. Plan sub-task 4.1 only.

---

## 4.1 Register the App 🔧 MANUAL CONFIG

1. GitHub → Settings → Developer settings → GitHub Apps → New.
2. Webhook URL: a placeholder for now (or a smee.io channel for local dev). Generate a **webhook secret**.
3. Repository permissions (least privilege): Pull requests **read & write**, Contents **read**,
   Checks **read & write**, Metadata **read**. Nothing else.
4. Subscribe to events: **Pull request**.
5. "Where can this app be installed": **Only on this account**.
6. Generate a **private key** (.pem). Store it outside the repo. Note the App ID / client ID.
7. Install the App on `diffwise-demo` only. Note the installation ID from the URL.
8. Disable the Phase 2 workflow in the demo repo (or keep it on a different label) to avoid double reviews.

**Verify:** `gh api /repos/<you>/diffwise-demo/installation` (as you) shows the installation.

## 4.2 App authentication `[GH:AUTH]` 🟢 YOU BUILD — the core of Phase 4

`src/adapters/app/auth.ts`, using **only `node:crypto`** (no auth library: you're learning the flow):

1. `createAppJwt()`: RS256 JWT signed with the private key; claims `iss`, `iat` (backdated ~60s for
   clock skew), `exp` (≤10 min).
2. `getInstallationToken(installationId)`: `POST /app/installations/{id}/access_tokens` with the JWT.
   Returns a token valid ~1 hour.
3. Cache tokens per installation; refresh when < 5 min left.
4. Optional: request a **down-scoped** token (only the one repo, only the permissions this review needs).

**Accept:** unit test that decodes your JWT and checks header/claims; token cache test with a fake clock.
**Learn:** the two identities (App vs installation); why the JWT is short-lived; what a down-scoped token buys.
**Then (optional):** compare with `@octokit/auth-app` and note in LEARNING.md what it does for you.

## 4.3 Webhook endpoint `[GH:WEBHOOK]` 🟢 YOU BUILD

`src/adapters/app/server.ts` (Hono):

- `POST /webhooks/github`:
  1. Read the **raw body** (verify before parsing JSON).
  2. Verify `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256(secret, rawBody), with a **constant-time compare**.
     Bad signature → 401, logged without the secret.
  3. Parse with Zod; handle only `pull_request` with actions `opened`, `synchronize`, `reopened`. Others → 204.
  4. **Idempotency** on `X-GitHub-Delivery`: seen → 200 and stop. In-memory TTL map.
  5. Enqueue the job and return **202 immediately** (GitHub's delivery timeout is short; reviews take longer).
- `GET /healthz`.

**Accept:** tests: valid signature, tampered body, missing header, duplicate delivery, ignored event.
**Learn:** why raw bytes matter for HMAC; why constant-time compare; what you lose with an in-memory store.

## 4.4 GitHubApiSource + job runner `[GH:API]` `[HARNESS:ORCH]` 🟡 PASTE & REVIEW

- `GitHubApiSource implements RepoSource`: diff from `GET /pulls/{n}/files` (patch per file), file reads
  from the contents API at the head SHA, `search` limited to changed files + a capped tree listing.
  **No clone, no checkout, no PR code executed.**
- Job runner: an in-process queue with concurrency 1–2, per-PR dedupe (a newer `synchronize` cancels
  an older queued job), daily review cap, installation allowlist.

**Read closely:** why the Action can use `git` on a checkout while the App deliberately can't.

## 4.5 Check runs `[GH:API]` 🟡 PASTE & REVIEW

- On job start: create a check run `Diffwise` with `status: in_progress` on the head SHA.
- On finish: `completed` with `conclusion` from the verdict (`failure`/`success`/`neutral`), a summary,
  and annotations for findings (still post the PR review with inline comments).
- On crash: `conclusion: neutral` with an error summary. Never leave a check stuck "in progress".

## 4.6 Deploy to Render 🔧 MANUAL CONFIG + ⚪ CLAUDE BUILDS

- ⚪ Claude: `Dockerfile` (multi-stage, pnpm, non-root user), `render.yaml`, structured JSON logs with
  `deliveryId`, `pr`, `installationId`, `outcome`, `costUsd` `[HARNESS:OBS]`.
- 🔧 You: Render → New Web Service from repo (free plan). Env vars: `GITHUB_APP_ID` (or client ID),
  `GITHUB_PRIVATE_KEY` (paste the PEM into Render's secret field, not chat), `GITHUB_WEBHOOK_SECRET`,
  `ANTHROPIC_API_KEY`, `DIFFWISE_MODEL`, `DAILY_REVIEW_CAP`, `ALLOWED_INSTALLATIONS`.
- 🔧 You: set the App's webhook URL to `https://<service>.onrender.com/webhooks/github`.

**Known tradeoff to write in the README:** free tier sleeps; the first webhook after idle may time out
while it wakes. GitHub shows a failed delivery you can **redeliver** from the App settings. Real fix: a
paid instance, or a queue in front (e.g. GitHub → small always-on receiver → queue → worker).

**Verify:** `curl https://<service>.onrender.com/healthz`; push to a demo PR; App settings → Advanced →
Recent deliveries shows 202; the PR gets a check run and review.

## 4.7 README + concept index ⚪ CLAUDE BUILDS

- Architecture diagram, "one engine, two adapters" section, Action vs App comparison table,
  eval results + ablation, security notes (permissions, no PR code execution, injection handling),
  cost controls, "what I'd do next" (Redis for idempotency, queue, multi-tenant, SARIF output).
- `pnpm concepts` regenerates `CONCEPTS.md`; CI fails if stale.

## Interview questions

1. Walk me through GitHub App auth: JWT, installation token, why two steps.
2. How do you verify a webhook is really from GitHub? Why constant-time compare? Why the raw body?
3. GitHub retries or redelivers a webhook. What stops a double review?
4. Why return 202 before the review runs? What happens if the server dies mid-review?
5. Action vs App: when would a company choose each?
6. Why doesn't your App clone and run the PR's code? What would you need to do that safely?
7. What would you change to run this for 500 repos? (queue, persistent idempotency, per-installation
   rate limits and budgets, observability export)
