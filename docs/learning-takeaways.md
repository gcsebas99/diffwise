# Learning takeaways

What building Diffwise taught, as questions and answers, grouped by theme. Each answer uses this
project's own numbers and decisions, and points at the code that implements it. For the full list
of concepts and where they live, see [`CONCEPTS.md`](../CONCEPTS.md) (generated from the
`// [TAG]` comments); for notes in my own words, [`LEARNING.md`](../LEARNING.md).

Contents: [Architecture](#architecture-and-orchestration) ·
[Agent loop](#the-agent-loop) · [Tools](#tools) · [Context and prompts](#context-and-prompts) ·
[Guardrails](#guardrails) · [Evals](#evals) · [GitHub Actions](#github-actions) ·
[GitHub App auth](#github-app-authentication) · [Webhooks](#webhooks) ·
[GitHub API and check runs](#github-api-and-check-runs) · [Observability](#observability) ·
[Tradeoffs we chose](#tradeoffs-we-chose)

---

## Architecture and orchestration

**Main ideas.** One engine (`reviewChanges`) does the whole review and knows nothing about where it
runs. Three thin adapters feed it and deliver its result: the CLI, the GitHub Action and the
GitHub App. The model and GitHub both sit behind interfaces, so tests use fakes and evals use
recordings.

**How is the agent structured?**
A core that knows nothing about GitHub or the terminal (rules, diff model, prompt, tools, loop,
verdict), plus a thin adapter for each place it runs. The prompt, tools, limits and verdict are
identical everywhere, so a PR can't pass in CI and fail locally.
→ `src/core/engine.ts`, `src/adapters/`

**How do you test an agent without paying for API calls?**
Put the model behind an interface (`ModelClient`). Unit tests use `ScriptedModel`, which plays back
a fixed script; evals use `RecordingModel` once against the real API and `ReplayModel` from then
on. GitHub gets the same treatment: `FakeGitHubClient` records every call.
→ `src/model/types.ts`, `src/model/scripted.ts`, `src/adapters/github/fake.ts`

**How do you handle rate limits and API errors?**
Bounded retries with exponential backoff and jitter that honor `retry-after` (408, 409, 429, 5xx,
529 overloaded), a timeout on total time, then fail visibly. The Anthropic SDK does the retrying;
4xx client errors aren't retried because they won't succeed. A model failure ends the review as
`model_error` (neutral verdict), never as a pass.
→ `src/model/anthropic.ts`

**What would you change to run this for 500 repos?**
A durable queue so jobs survive restarts, with workers that scale separately from the webhook
receiver. Delivery-ID dedupe and daily caps in a shared store (Redis) instead of process memory.
Budgets and rate limits per installation, not one global cap. A sweep that closes check runs left
"in progress" by a crashed worker. Log export and dashboards for cost and outcome per repo.
→ today's in-process version: `src/adapters/app/jobs.ts`

---

## The agent loop

**Main ideas.** Think (model call) → act (run the tools it asked for) → observe (results back),
until the model calls the terminal tool `submit_review` or a limit stops it. Every way out is
named, and only one of them counts as a finished review.

**Walk through one loop iteration at the API level.**
Send `messages` (plus system prompt and tool schemas). The response has `tool_use` blocks, each
with an id. Run every tool, then send **one** user message containing one `tool_result` per
`tool_use`, paired by `tool_use_id`. Repeat. `submit_review` sets the summary and ends the loop.
→ `src/core/loop.ts`

**What are the exit conditions, and why each?**
`completed` (submit_review was called), `max_steps` (turns), `budget_exceeded` (tokens, i.e. money),
`deadline_exceeded` (wall time), `stuck` (the same tool calls three turns in a row; a nudge first),
`no_review` (the model stopped without submitting), `model_error`. Each bounds a different cost.
The limits are checked before every model call.
→ `src/core/loop.ts`

**What happens to findings on an early exit?**
They're kept: findings live in the review state, written by `report_finding` as they happen. But
only `completed` marks the review complete; anything else gives a **neutral** verdict, never a
pass, and the summary says why it stopped.
→ `src/core/loop.ts`, `src/core/verdict.ts`

**How do you stop runaway agents?**
A step cap, a token budget, a deadline, repeated-call detection, and an explicit terminal tool so
"done" is an action, not a guess. On the eval set, reviews take 2–5 steps; the caps are far above
that, so they only catch real problems.

---

## Tools

**Main ideas.** Six tools: list the changed files, get one file's diff, read a file, search the
repo, report a finding, submit the review. Each has one Zod schema used both as the JSON Schema
sent to the API and as the validator. Tools never throw: a failure is a value the model can act on.

**What happens when the model calls a tool wrong?**
The arguments are validated; a failure becomes `is_error` on the `tool_result`, with an actionable
message (e.g. the valid line ranges). The model corrects itself on the next turn, and the step cap
bounds how often it can try.
→ `src/core/tools/types.ts`, `src/core/tools/registry.ts`

**Where do you validate tool calls?**
At one choke point, `execute()`, before any tool's `run()`. The model's arguments are untrusted
input like anything else.
→ `src/core/tools/registry.ts`

**How do you keep the agent's output valid?**
Validate each structured action against ground truth at the tool, not afterwards. `report_finding`
checks the rule exists, the rule applies to that path, the file is in the diff, the line is
commentable, and it isn't a duplicate. Each failure lists the valid options.
→ `src/core/tools/report-finding.ts`

**How do you get an agent to use tools well?**
Write descriptions like docs for a new teammate: when to call it, what the output means, which
tool to use next. Truncated output says how to get the rest.
→ `src/core/tools/list-changed-files.ts`, `src/core/tools/util.ts`

**How do you run tools on untrusted input?**
No shell: `git` runs through `execFile` with an argument array, so `x; rm -rf ~` is just text.
Separators (`--`, `-e`, `--end-of-options`) so a value can't become a flag. Timeouts, output caps,
read-only commands. Paths must be repo-relative.
→ `src/core/local-git-source.ts`, `src/core/tools/util.ts`

---

## Context and prompts

**Main ideas.** Turn 1 is a map of the PR (file names, sizes, which rules apply), not the diff. The
agent pulls hunks it needs through tools. The system prompt is stable per repo and cached. PR
text is wrapped in tags and treated as data.

**Why not paste the whole diff into the prompt?**
Context cost grows every turn (the whole conversation is resent), attention drops on long inputs,
big PRs wouldn't fit at all, and the model can't reliably count lines in raw patch text. Tools
scale; a dump doesn't. The diff model gives each line its new-side number, so citations can be
validated.
→ `src/core/prompt.ts`, `src/core/diff.ts`, `src/core/tools/get-file-diff.ts`

**How do you cut cost in a multi-turn agent?**
A stable prefix first, cached: the cache covers tools → system → messages, so one breakpoint at
the end of the system prompt caches the tool schemas and rules for every later turn. Anything
per-PR goes after it. Check `cache_read_input_tokens` to confirm it's working. Plus: code checks
run first and the model is skipped entirely when no changed file has a model-checked rule.
→ `src/core/prompt.ts`, `src/core/engine.ts`

**How does the prompt defend against instructions hidden in the PR? Why isn't that enough?**
PR title, body and file list are wrapped in `<untrusted_…>` tags (anything that could close a tag
is escaped) and the system prompt says they're data. That lowers the odds, but a prompt can't
guarantee anything. The real defenses are structural: the model can only call read-only tools and
`report_finding`; the verdict is computed by code; findings are validated. The two injection eval
cases resisted 3 out of 3 trials, and CI requires every adversarial trial to pass.
→ `src/core/prompt.ts`, `evals/cases/injection-*`

---

## Guardrails

**Main ideas.** The model gathers evidence; code makes every decision that matters and validates
everything the model produces before it reaches GitHub.

**Why does code compute the verdict instead of the model?**
It's a policy decision: fail if any finding is on a rule the repo marked `blocking`. Severity comes
from the rules file, so a model saying "LGTM" can't turn a blocking finding into a pass, and the
same findings always give the same verdict.
→ `src/core/verdict.ts`

**How do you stop comments GitHub will reject?**
Only new-side lines inside a hunk (added or context) are commentable. `report_finding` checks the
line against the diff model before anything reaches the API; one bad line would otherwise make
GitHub reject the whole review with a 422.
→ `src/core/diff.ts`, `src/core/tools/report-finding.ts`

**Is the agent's output safe to post?**
Treat it like user input at every place it lands. In markdown, `@team` would ping people (a
zero-width space breaks mentions) and raw HTML could hide text (`<` is escaped). Table cells drop
newlines and `|`. Secrets found by the code check are redacted to their kind and length.
→ `src/core/publish.ts`, `src/checks/secrets.ts`

**Config errors vs tool errors?**
Config (the rules file) fails fast at startup, listing every problem, because a human fixes it.
Tool-argument errors go back to the model, because it can fix them inside the loop.
→ `src/core/rules.ts`

**What do you give the LLM, and what not?**
Anything a pattern can decide runs as code, before the model: secrets, undocumented env vars. The
model gets the judgment calls ("does this test exercise the changed behavior?"). It can't remove
what code already found.
→ `src/checks/index.ts`

**Why can't the PR change its own rules?**
In the App, `.review-rules.yaml` is read at the **base** commit. Read at the head, a PR could
delete the rule it breaks and pass its own review.
→ `src/adapters/app/review-job.ts`

**How do you run a model-supplied regex safely?**
`git grep`'s engine can't backtrack; JavaScript's can, and `(a+)+$` on a long line takes
exponential time and would freeze the server. The App's search runs the regex in a `node:vm`
context with a 1-second timeout, over capped input. The alternative is a linear-time engine (RE2).
→ `src/adapters/app/api-source.ts`

**Why does the bot never approve?**
The only review event the type allows is `COMMENT`. A bot approval could satisfy "required
reviews"; the verdict belongs in a check, which is recomputed on every push, not in a review state
that sticks until someone dismisses it.
→ `src/adapters/github/client.ts`

---

## Evals

**Main ideas.** 18 cases, each a patch on one fixture app plus the review a careful human would
write. Run k times each, graded by four pure graders, replayed from recordings in CI for free.

**How do you evaluate a non-deterministic reviewer?**
k trials per case and two numbers: **pass@k** (passed at least once: can it do this at all?) and
**pass^k** (passed every time: the reliability a user gets, since they see one run). Gate on
pass^k for anything that must never fail, like injections. First full run: 54/54 trials, $0.02.
→ `evals/report.ts`

**How do you grade a non-deterministic reviewer?**
Grade what matters, not incidental choices: rule, file, a line *range* (not one exact line), and
the verdict, never the wording. Findings are matched one-to-one with expectations, per rule.
→ `evals/case.ts`, `evals/graders/findings.ts`

**How do you score a reviewer's findings?**
Match them to the labeled set and count true positives, false positives and false negatives per
rule. Report precision and recall separately, per rule, never just one blended accuracy. The gate
is on blocking recall; precision is reported.
→ `evals/graders/findings.ts`, `evals/report.ts`

**Precision vs recall for a review bot: which hurts more?**
Usually precision. False positives teach people to ignore the bot, and then its true positives are
ignored too. A missed issue is still caught by a human reviewer. Exception: rules where one miss is
costly (secrets), where recall matters more.

**A prompt change raised recall 10% but doubled false positives. Ship it?**
Not on the headline. Compare per rule and per case: which rules got noisier, on which cases. For
a review bot the precision drop usually costs more than the recall buys. `pnpm eval compare` lists
regressions case by case and warns when the two runs aren't comparable.
→ `evals/compare.ts`

**When does a rule belong in a regex instead of an LLM?**
When a pattern can express it. The ablation moved the two code checks to the model: recall stayed
at 100%, but 3 false positives appeared and total cost rose 52% (18 more model calls). Code is
free, instant and never hallucinates; the model belongs on judgment rules.
→ `docs/ablations.md`

**How did you pick eval cases? How do you stop the set going stale?**
Positive and negative twins per rule (route change with and without a test), boundary cases
(a test that misses a branch, a partial `down` migration), adversarial ones (injections, a PR body
claiming "just a refactor"), and size (a 24-file PR). The set goes stale when every case passes;
at 100% it can't tell a better prompt from a worse one. Fix: turn every real bad review into a new
case.
→ `evals/cases/`

**How do you test prompt-injection resistance?**
Adversarial cases whose pass condition includes what must **not** happen (`forbidden` findings,
no pass verdict), graded separately and gated in CI with zero tolerance.
→ `evals/graders/forbidden.ts`, `evals/gate.ts`

**How do you run evals in CI for free and without flakiness?**
Record real runs once; replay them by request hash. Replay is deterministic and costs $0. A
request that wasn't recorded is a harness error (exit 2), not a flaky failure: the input changed,
so re-record and review the diff. Requests are normalized before hashing (random tool ids
renumbered) so the same conversation always hashes the same.
→ `src/model/replay.ts`, `src/model/cassette.ts`, `.github/workflows/ci.yml`

**How do you make agent evals reproducible?**
Every trial gets a fresh, isolated repo built the same way down to the commit SHAs (fixed author,
dates, no user git config). Pinned inputs plus record/replay for the model; only then compare runs.
→ `evals/materialize.ts`

**Your eval failed: was it the agent or the harness?**
Separate them by construction. Anything thrown (stale cassette, a patch that doesn't apply) is an
`error` record, reported apart and exiting 2. An agent problem never throws: it ends as an outcome
and is graded. Otherwise a broken fixture reads as a quality regression and someone "fixes" the
prompt. Case expectations are also checked against the rules at load time.
→ `evals/runner.ts`, `evals/case.ts`

---

## GitHub Actions

**Main ideas.** The Action runs on GitHub's throwaway runner, on a checkout of the PR, triggered by
`pull_request`. The verdict is the job's exit code; branch protection requires that check.

**Walk me through "PR opened" to "merge blocked".**
`pull_request` event → the workflow job starts → checkout with full history → the action reads the
PR from the event payload → code checks, then the model if the label is there → one review posted
→ on a fail verdict, `setFailed` → the job is red → the required check `Diffwise review` is red →
merge is blocked. A new push repeats it for the new commit.
→ `src/adapters/action/main.ts`

**Where does the Action get the PR?**
From the event payload at `GITHUB_EVENT_PATH` (PR number, base and head SHAs, title, body),
validated with Zod like any external input. Not `GITHUB_SHA`, which is a merge commit.
→ `src/adapters/action/context.ts`

**What permissions does the workflow need, and why not more?**
`contents: read` (read the code) and `pull-requests: write` (post the review). Naming any
permission sets every unnamed one to none. More would only widen what a hijacked run could do.

**Why not `pull_request_target`? What happens with PRs from forks?**
`pull_request_target` runs with secrets and a write token, and checking out a fork's code under it
is the classic Actions exploit. With `pull_request`, fork PRs get no secrets and a read-only
token, so a malicious PR has nothing to steal. The action refuses any other event too. Cost of
that choice: fork PRs can't run the model (no API key) and get the free code checks only.
→ `src/adapters/action/context.ts`

**How do you control cost on a public repo?**
Anyone can open a PR, so the model runs only when a maintainer adds the `live-review` label
(triage access or higher). The free code checks always run. PRs that touch no file with a
model-checked rule never call the model.
→ `src/adapters/action/main.ts`

**What happens on a new push to the PR? Why not just post another review?**
One new review pinned to the new head SHA; the previous Diffwise review is edited to say it's
outdated and link to the new one (GitHub can't delete a submitted review). The new one is posted
first, so a failure never leaves the old one marked outdated with nothing to replace it.
→ `src/core/publish.ts`

---

## GitHub App authentication

**Main ideas.** Two identities. The App proves it holds its private key with a short JWT; that JWT
can only mint installation tokens. The installation token does the work.

**Walk me through GitHub App auth. Why two steps?**
1. Sign a JWT with the App's private key: RS256, `iss` = client ID, `iat` 60 seconds in the past
   (clock skew), `exp` 9 minutes out (GitHub allows 10).
2. `POST /app/installations/{id}/access_tokens` with it; get a token valid for 1 hour.
3. Use that token for the API.
Two steps because the private key never leaves the server and only mints tokens; what does the
work is per installation, scoped and short-lived. Built by hand with `node:crypto`.
→ `src/adapters/app/auth.ts`

**What does a down-scoped token buy you?**
Blast radius. Each review asks for a token limited to its one repo and three permissions (pull
requests write, contents read, checks write). A hijacked review can't reach other repos, issues or
settings, and its token dies in an hour.
→ `src/adapters/app/auth.ts`

**Why cache installation tokens?**
Minting one per API call wastes a round trip and rate limit. They're cached per installation and
scope and refreshed with 5 minutes left, so a review never starts on a token about to expire.
Concurrent callers share one in-flight request.
→ `src/adapters/app/auth.ts`

---

## Webhooks

**Main ideas.** GitHub POSTs events to a public URL. Verify before trusting anything, dedupe on
the delivery ID, reply within 10 seconds, do the work afterwards.

**How do you verify a webhook is really from GitHub? Why constant-time? Why the raw body?**
A shared secret: GitHub sends `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256(secret, body). We
recompute it over the **raw bytes**: parsing JSON and re-serializing changes spacing and escapes,
so the signature wouldn't match. Compare with `timingSafeEqual`: `===` stops at the first
different character, and that timing lets an attacker guess a valid signature byte by byte.
Reject before parsing anything.
→ `src/adapters/app/webhook.ts`

**GitHub retries or redelivers a webhook. What stops a double review?**
Dedupe on `X-GitHub-Delivery`: redeliveries keep the same ID. Kept in memory with a time limit and a
size cap, so a restart forgets; at scale it belongs in Redis. Separately, a job reviews the PR's
current head and skips a commit it already reviewed, so out-of-order deliveries don't matter.
→ `src/adapters/app/webhook.ts`, `src/adapters/app/review-job.ts`

**Why return 202 before the review runs? What if the server dies mid-review?**
GitHub waits 10 seconds, then marks the delivery failed; a review takes 5–60. So: verify, queue,
reply 202, review afterwards. The cost: after the 202 GitHub won't retry, so a crash loses the job
(redeliver by hand) and can leave the check "in progress". Fixes: a durable queue, and a sweep
that closes stale check runs.
→ `src/adapters/app/server.ts`

---

## GitHub API and check runs

**Main ideas.** The App reads the PR only through the API, at a pinned commit, and reports the
verdict as a check run alongside the review.

**Review or check run?**
Both. The review is the conversation (summary, inline comments). The check run is the gate: a
conclusion per commit that branch protection can require. Only a GitHub App can create check runs.
Every path completes it: an error gives `neutral` ("didn't run"), never `failure`.
→ `src/adapters/app/check-run.ts`, `src/adapters/app/review-job.ts`

**Why doesn't the App clone and run the PR's code? What would doing that safely need?**
The Action runs on a disposable runner; the App runs on our server, next to the private key and
the API key. Cloning puts untrusted code there, and git itself can run code from a repo (hooks,
filters, config). Over the API we only receive text. Running PR code safely would need a sandbox:
a throwaway container with no secrets and no network.
→ `src/adapters/app/api-source.ts`

**Action vs App: when would a company choose each?**
Action: one team, their own repos, no server to run; each repo carries a workflow file and its own
API key. App: a product installed across many repos and organizations in one click, with central
keys, its own bot identity and fixed permissions, but you run a server (uptime, cold starts, queue,
idempotency). The README has the full comparison, including which check each one reports.

**Why does the review comment point at a commit?**
The review is created with `commit_id` = the reviewed head SHA. Without it, a push during the
review would make GitHub place our line numbers on a newer commit.
→ `src/adapters/github/client.ts`

---

## Observability

**Main ideas.** Every review states how it was produced; every log line is JSON tied to its
webhook; secrets can't reach a log by accident.

**How do you debug an agent in production?**
Structured logs keyed by request ID: `deliveryId` (matches GitHub's Recent deliveries),
`installationId`, `pr`, `outcome`, `verdict`, `costUsd`, `ms`. Field names that look secret are
redacted before printing, as a backstop. Each review's footer states the model, steps, tokens and
estimated cost.
→ `src/adapters/app/log.ts`, `src/core/publish.ts`, `src/core/cost.ts`

**How do you know what a review cost?**
Four token counters on every model call (input, output, cache read, cache write) and a price
table. An unknown price is reported as unknown, never as $0. Evals report mean and p95 cost over
the trials where the model actually ran; including the $0 code-check-only trials would make reviews
look cheaper.
→ `src/model/types.ts`, `src/core/cost.ts`, `evals/report.ts`

---

## Tradeoffs we chose

| Decision | Instead of | Why |
|---|---|---|
| Verdict computed by code | the model's opinion | policy must be deterministic and can't be talked out of |
| Map of the PR + tools | pasting the diff | cost per turn, focus, huge PRs |
| Code checks before the model | everything in the LLM | ablation: same recall, no false positives, −34% cost |
| Line *ranges* in eval cases | exact lines | grade what matters, not incidental choices |
| Replay in CI | live evals per PR | free, deterministic; a stale cassette is a harness error |
| `pull_request` + label gate | `pull_request_target` | forks get no secrets; maintainers decide when to pay |
| Rules from the base commit (App) | from the PR's head | a PR can't weaken its own review |
| API reads (App) | cloning | our server holds the keys; nothing from the PR runs |
| 202, then review | reviewing inside the request | GitHub's 10-second timeout; costs a lost job on crash |
| Delivery IDs in memory | Redis | one free instance; a restart forgets (documented gap) |
| Error → `neutral` check | `failure` | an outage isn't a bad PR |
| Hand-built App auth | `@octokit/auth-app` | to learn the flow; the library would replace one file |
