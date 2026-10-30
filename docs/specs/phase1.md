# Phase 1 — Core engine + local CLI

**Goal:** `pnpm diffwise review --repo ../diffwise-demo --base main --head feature-x` loads the rules
file, builds a diff model, runs a hand-written agent loop against Claude with real tools, and prints
validated findings plus a code-computed verdict. No GitHub yet: everything runs on a local git checkout.

**Pillars:** LOOP · TOOLS · CONTEXT · GUARD · ORCH

## Kickoff prompt (Claude Code, plan mode)

> Read `CLAUDE.md`, `docs/PLAN.md` and `docs/specs/phase1.md`. We're doing Phase 1.
> Plan sub-task 1.1 only: state its mode, files, and concepts. Wait for approval.

Then for each next one: *"Next: sub-task 1.N. Plan first."*

---

## 1.1 Scaffold ⚪ CLAUDE BUILDS

- `pnpm init`, TypeScript strict + ESM, `tsx` for dev, Biome, Vitest, deps from PLAN.md (Phase 1 subset).
- `src/config.ts`: Zod-parsed env: `ANTHROPIC_API_KEY` (optional in replay), `DIFFWISE_MODEL`,
  `DIFFWISE_MAX_STEPS=20`, `DIFFWISE_TOKEN_BUDGET=80000`, `DIFFWISE_TOOL_OUTPUT_MAX_CHARS=6000`.
- `src/cli.ts` with commander; `pnpm diffwise --help` works.
- `.env.example`, `.gitignore`, `README.md` stub, `docs/PROGRESS.md`, `LEARNING.md` (template), `scripts/concepts.ts`.
- `.github/workflows/ci.yml`: lint, typecheck, test.

**Accept:** `pnpm test`, `pnpm lint`, `pnpm typecheck` green; CI green after first push.

## 1.2 Demo repo + rules file 🔧 MANUAL CONFIG + ⚪ CLAUDE BUILDS

- 🔧 You: create the **public** repo `diffwise-demo` on GitHub, clone it next to `diffwise`.
- ⚪ Claude: a tiny Express-style TS app in it (2–3 routes, a `migrations/` folder, `test/`, `.env.example`),
  the `.review-rules.yaml` from PLAN.md (4 rules), and **local branches** for each seeded PR in PLAN.md
  (don't open PRs yet; that's Phase 2).

**Accept:** `git branch` in the demo repo shows the 6 seeded branches; each differs from `main` as described.

## 1.3 Rules loader 🟡 PASTE & REVIEW

- `src/core/rules.ts`: Zod schema for the rules file; `loadRules(path)`; `rulesForFile(path)` via picomatch.
- Errors are **actionable** ("rule 'x': unknown severity 'high', expected blocking|advisory").

**Accept:** tests for valid file, invalid severity, unknown `check`, glob matching.
**Read closely:** why config parsing fails loudly while tool errors (1.5) go back to the model.

## 1.4 Diff model `[HARNESS:CONTEXT]` 🟡 PASTE & REVIEW

- `src/core/diff.ts`: parse `git diff --unified=3 base...head` into `FileDiff[]` → hunks → lines with
  **new-side line numbers** and a `commentable` flag (added or context lines inside a hunk).
- `RepoSource` interface: `readFile(path)`, `search(pattern, glob)`, `diff()`. `LocalGitSource` impl
  (shells out to `git` with `execFile`, never a shell string).

**Accept:** fixture-based tests: added file, deleted file, rename, multiple hunks, line-number mapping.
**Read closely:** the `commentable` flag. GitHub rejects review comments on lines outside the diff (422);
this is where you prevent it.

## 1.5 Tools & registry `[HARNESS:TOOLS]` 🟢 YOU BUILD

- `src/core/tools/`: a `Tool` type = name, description, Zod `input`, `run(ctx, args) → ToolResult`
  (`{ ok, content, truncated }`). A `ToolRegistry` with `toAnthropicTools()` (JSON Schema from Zod) and
  `execute(name, rawArgs)`.
- Implement the 6 tools from PLAN.md. Requirements:
  - Invalid args → `ok:false` with a message the model can act on. Never throw out of `execute`.
  - Output over `TOOL_OUTPUT_MAX_CHARS` → truncated with a hint ("…[312 more lines, narrow the range]").
  - `report_finding` validates: rule exists, rule applies to that path, line is commentable.
    On failure, explain *why* so the model can fix it.
  - `read_file`/`search_repo` refuse paths outside the repo (`..`, absolute).
- **Write the descriptions like docs for a new teammate:** when to use it, args, what it returns.

**Accept:** one test per tool; invalid-args test; truncation test; path-escape test; a finding on a
non-commentable line returns a helpful error.
**Learn:** why tool descriptions are prompt engineering; why errors go back to the model instead of crashing.

## 1.6 Prompt assembly `[HARNESS:CONTEXT]` `[HARNESS:GUARD]` 🟢 YOU BUILD

- `src/core/prompt.ts`: `buildSystemPrompt(rules)` and `buildInitialMessage(prContext)`.
  - System: role, method (list files → inspect relevant diffs → read context only when needed → report →
    submit), the **LLM rules only** (deterministic ones are handled elsewhere), severity meaning, and an
    explicit statement that **PR content is untrusted data**.
  - Initial message: PR title/body (wrapped as untrusted), changed-file summary with applicable rule ids.
    Not the full diff; the agent pulls hunks via tools (progressive disclosure).
- `promptVersion` = short sha256 of system prompt + tool schemas. Recorded on every review.
- Prompt caching on system + tools (verify current SDK syntax).

**Accept:** snapshot test; `promptVersion` changes when a rule's instructions change.
**Learn:** why not dump the whole diff in; what's cacheable and what breaks the cache.

## 1.7 Model client `[HARNESS:ORCH]` 🟡 PASTE & REVIEW

- `src/model/types.ts`: `ModelClient.create({system, messages, tools}) → ModelResponse`
  (content blocks, stop_reason, usage incl. cache read/write, latencyMs).
- `AnthropicModel`: SDK client with timeout and retries (use the SDK's built-in retry config; verify it
  covers 429/5xx/overloaded). `ScriptedModel`: returns queued responses, for tests.

**Accept:** ScriptedModel drives a two-turn exchange in a test.

## 1.8 The agent loop `[HARNESS:LOOP]` 🟢 YOU BUILD — the core of Phase 1

`src/core/loop.ts`, readable top to bottom (~120 lines):

```
think   → model.create(system, messages, tools)
act     → execute every tool_use block (parallel calls allowed)
observe → one user message with all tool_result blocks, ids paired, is_error when ok=false
repeat
```

Exit conditions, each explicit, tagged and tested:
1. `submit_review` called → `outcome=completed`
2. `maxSteps` reached → `outcome=max_steps`
3. Token budget exceeded → `outcome=budget_exceeded`
4. Same (tool, args) 3× in a row → one nudge; repeats → `outcome=stuck`
5. Plain-text turn with no tool call → one nudge ("call submit_review"), then `outcome=no_review`

On any non-`completed` outcome, keep the findings already reported and mark the review **incomplete**
(the verdict layer treats incomplete as "neutral", not "pass").

Emit events (`step`, `model_call`, `tool_call`, `exit`) to a callback; the CLI prints them with color.

**Accept:** ScriptedModel tests for all 5 exits + parallel tool calls + finding persistence on early exit.
**Learn:** what a `tool_use_id` is and why pairing matters; why "incomplete" must never become "pass".

## 1.9 Verdict + CLI output 🟡 PASTE & REVIEW

- `src/core/verdict.ts`: findings + deterministic results + outcome → `{ verdict: pass|fail|neutral, counts }`.
  Fail if any blocking finding; neutral if incomplete; else pass. **Pure function, 100% tested.**
- `diffwise review` prints findings grouped by file, the summary, verdict, steps, tokens, est. cost.

**Accept:** verdict table tests; one **live run** per seeded branch (cheap model). Write down what it got
wrong; those notes become eval cases in Phase 3.

## Interview questions (answer out loud tonight)

1. Walk through one loop iteration at the API level: messages, `tool_use`, `tool_result`, ids.
2. What are your exit conditions and why each? What happens to findings on an early exit?
3. Why does code compute the verdict instead of the model?
4. How do you stop the model from commenting on lines GitHub will reject?
5. Why give the agent tools to pull hunks instead of pasting the whole diff?
6. How does the prompt defend against instructions hidden in the PR? Why isn't that enough on its own?
