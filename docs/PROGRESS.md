# PROGRESS.md

| Sub-task | Mode | Done | What I learned (one line) |
|---|---|---|---|
| 1.1 Scaffold | ⚪ | 2026-10-29 | Env config is parsed with Zod at startup and fails loudly, naming the variable but never echoing its value. |
| 1.2 Demo repo + rules | 🔧⚪ | 2026-10-29 | Each seeded branch is a labeled eval case; a clean branch measures false positives and the injection branch pairs with a real violation so "pass" can't hide it. |
| 1.3 Rules loader | 🟡 | 2026-10-30 | Config fails loudly at load with every problem named by rule id; globs need dot:true or dotfiles are silently skipped. |
| 1.4 Diff model | 🟡 | 2026-10-30 | Only new-side lines inside a hunk are commentable; git is called with arg arrays plus -e/--/--end-of-options, pinned to SHAs. |
| 1.5 Tools & registry | 🟡 | 2026-10-31 | One Zod schema is both the tool's JSON Schema and its validator; tools return errors as values with the fix, and report_finding checks findings against the rules and diff before they can reach GitHub. |
| 1.6 Prompt assembly | 🟡 | 2026-10-31 | Stable system prompt first with one cache breakpoint, per-PR data after it; PR text is wrapped and its closing tag escaped, and promptVersion hashes system + tools. |
| 1.7 Model client | 🟡 | 2026-11-03 | The loop talks to a ModelClient interface (Anthropic or Scripted); the SDK retries 408/409/429/5xx with backoff and fails fast on 4xx; total input = uncached + cache read + cache write. |
| 1.8 Agent loop | 🟡 | 2026-11-03 | think → act → observe with 7 explicit exits; every tool_use gets a paired tool_result (results first, nudges after); findings survive early exits, and only `completed` is complete. |
| 1.9 Verdict + CLI | 🟡 | 2026-11-04 | Code turns findings into the verdict (blocking → fail, incomplete → neutral, never pass); exit 0/1/2 separates pass, fail and "could not run"; six live runs matched expectations for ~$0.003. |
| 2.1 GitHubClient + publisher | 🟡 | 2026-11-07 | Review logic talks to a 4-method GitHubClient (Octokit or fake); each run posts one COMMENT review pinned to the head SHA, then marks the previous bot review outdated; model text is escaped for markdown where it lands. |
| 2.2 Action adapter | 🟢→🟡 | 2026-11-07 | One engine shared by CLI and Action; PR number and SHAs come from the validated event payload (not GITHUB_SHA); the model runs only when opted in and needed; findings land in annotations + job summary before the review is posted, and setFailed on fail is the check. |
| 2.3 Package action | ⚪ | 2026-11-07 | A JavaScript action runs dist/index.js straight from the tagged repo with no install, so everything is bundled (esbuild, ESM + createRequire banner) and CI fails when dist/ is stale. |
| 2.4 Demo workflow | 🟢→🟡 | 2026-11-07 | pull_request (never _target) + least-privilege permissions; the label gate decides cost, and no job-level if: because a skipped job counts as a passing required check. |
| 2.5 Repo setup | 🔧 | 2026-11-08 | Secrets for keys, variables for config; a ruleset with an empty bypass list makes the check binding even for admins; gh and git can be logged in as different accounts. |
| 2.6 Demo polish | ⚪ | 2026-11-08 | A portfolio README leads with the live demo, the safety model and a concept → file map; the demo repo explains what to look for on each seeded PR. |
| 3.1 Deterministic checks | 🟡 | 2026-11-08 | Pattern rules run as code before the model, on every PR and for free; secrets are redacted where the message is created; the engine decides when the model is needed, and a checks-only summary says what was not checked. |
| 3.2 Record / replay | 🟡 | 2026-11-09 | Cassettes keyed by a hash of the normalized request (tool ids renumbered, everything the model reads kept); replay serves exact matches only and a miss is a HarnessError the loop re-throws, never a quiet model_error. |
| 3.3 Eval cases | 🟢→🟡 | 2026-11-09 | 18 cases as patches on one fixture, each with a one-line reason; expectations use line ranges and are checked against the rules at load time, and the dataset itself is tested (patches apply, ranges commentable, no-model cases already grade) so a broken case never looks like an agent failure. Writing them exposed an ambiguous rule. |
| 3.4 Graders | 🟢→🟡 | 2026-11-09 | Four pure graders (verdict, findings, forbidden, budget); findings match one-to-one by rule + path + range with optimal greedy order, gate on blocking recall and report precision per rule; a no-model run is the baseline (8/18), so negatives only mean something next to their positive twins. |
| 3.5 Runner + report | 🟡 | 2026-11-10 | k trials per case through a pool, one cassette per trial so replay keeps the variance; harness errors are reported apart from agent failures; pass@k vs pass^k and precision/recall per rule; first full run: 54/54 trials, $0.02, and replay identical. |
| 3.6 CI gate | ⚪ | | |
| 3.7 Ablation | 🟢→🟡 | | |
| 4.1 Register App | 🔧 | | |
| 4.2 App auth | 🟢→🟡 | | |
| 4.3 Webhook endpoint | 🟢→🟡 | | |
| 4.4 API source + job runner | 🟡 | | |
| 4.5 Check runs | 🟡 | | |
| 4.6 Deploy to Render | 🔧⚪ | | |
| 4.7 README + concepts | ⚪ | | |
