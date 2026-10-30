# CLAUDE.md — Diffwise

Diffwise is an **AI agent that reviews pull requests** against rules defined in the target repo
(`.review-rules.yaml`). It posts inline review comments, a summary, and a pass/fail verdict.
It ships two ways from one core engine: a **GitHub Action** and a **GitHub App** (deployed on Render).

Its real purpose is **learning + portfolio**: it backs the answer "yes, I've built an AI agent workflow
for code review / software verification." The owner (Sebas) builds the knowledge-heavy parts himself.
He must understand every line, including the ones he didn't type.

## Build modes (read first — every sub-task in `docs/specs/` is tagged with one)

Follow the mode of the current sub-task exactly. If a sub-task has no mode, ask.

### 🟢 YOU BUILD — Sebas writes the implementation
- **Do not write implementation code** for this sub-task, in files or as a full solution in chat.
- Before he starts, you MAY: create stub files with exported types/signatures and bodies of
  `throw new Error("TODO(sebas)")`, and write **failing tests from the acceptance criteria**.
  Ask first: "Tests first from me, or do you want to write them?"
- Concept explanations on request: ≤10 lines, then stop.
- Hints only when asked, escalating. Always say which level you're giving:
  - **L1 — nudge:** a question or direction ("what happens if the model calls the same tool twice?").
  - **L2 — pointer:** the API/doc/pattern to use, no code.
  - **L3 — snippet:** ≤10 lines covering only the hard part.
- When he says "review": correctness bugs first, then edge cases, then style.
  Label each item **must-fix** or **nice-to-have**. End with one "interview check" question.
- If he explicitly says "just write it," comply, and mark that sub-task `🟢→🟡` in `docs/PROGRESS.md`.

### 🟡 PASTE & REVIEW — you write, Sebas pastes and reviews
- **Do not write these files yourself.** Present the code in chat, one file (or one cohesive chunk of
  ≤ ~80 lines) at a time:
  1. 2–4 lines: what this does and why it's shaped this way.
  2. The code, with `[HARNESS:*]` / `[GH:*]` tags where concepts live.
  3. **Read closely:** 1–3 lines pointing at the parts that matter.
- After he pastes and runs it, ask **2 short comprehension questions**. Don't continue until he
  answers or says "skip."

### ⚪ CLAUDE BUILDS — utilities and scaffolding
- Write directly. Summarize changed files in ≤5 lines. No quiz.

### 🔧 MANUAL CONFIG — Sebas clicks through GitHub / Render / Anthropic Console
- Give a numbered checklist; for each setting, one line on what it means and why.
- **Never ask him to paste a secret, key or token into chat.**
- Afterwards, give a command to verify it worked (e.g. `gh api ...`, `curl .../healthz`).

## Working agreement

1. **Start every sub-task in plan mode:** read the spec, state the mode, list files and concepts
   touched, and wait for approval.
2. One sub-task at a time. **Stop at the end of a phase**; don't start the next unprompted.
3. When a design choice has a tradeoff, state it in 1–2 lines and name the alternative not picked.
4. **Ask before adding a dependency** not listed in `docs/PLAN.md`.
5. **Verify APIs against current docs**: Anthropic TS SDK (tool use, retries), Octokit, GitHub REST
   (pull request reviews, check runs, app installation tokens), webhook headers, the supported
   Node runtime for JavaScript actions, Zod's JSON Schema export. Do not rely on memory.
6. Never commit secrets. `.env` is gitignored. **Never log tokens, keys or the webhook secret.**
7. **The App adapter never executes code from the PR under review.** PR content is untrusted.
8. After each sub-task, update `docs/PROGRESS.md`: sub-task, mode, done date, one line on what was learned.

## Learning-comment convention (MANDATORY)

Mark every place where a concept is *actually implemented*:

```ts
// [HARNESS:LOOP] Exit condition #3 — stuck detection.
// WHY: a confused model can repeat the same call forever and burn tokens.
// INTERVIEW: "How do you stop runaway agents?" → step cap, token budget,
//            repeated-call detection, explicit terminal tool.
```

- First line `// [TAG] <what this is>`, then `// WHY:` (required), then optional `// INTERVIEW:`. Max ~6 lines.
- Harness tags: `LOOP`, `TOOLS`, `CONTEXT`, `GUARD`, `EVAL`, `ORCH`, `OBS`.
- GitHub tags: `GH:AUTH`, `GH:WEBHOOK`, `GH:API`, `GH:ACTIONS`.
- Only on concept-bearing code. Ordinary comments explain *why*, never restate the code.
- `scripts/concepts.ts` builds `CONCEPTS.md` from these tags; keep first lines self-explanatory.

## Tech & conventions

- Node 22, TypeScript `strict`, ESM, pnpm. Biome for lint + format. Vitest for tests.
- **Zod for every external input:** rules file, tool args, webhook payload fields, model structured output.
- The model ID is **never hardcoded**: `DIFFWISE_MODEL` env var.
- The **verdict is computed by code**, not by the model: fail if any `blocking` finding exists.
- Layout:
  ```
  src/
    core/        # rules, diff model, prompt assembly, tools, agent loop, review types
    model/       # ModelClient interface, Anthropic, Scripted, Recording, Replay
    checks/      # deterministic checks (secrets, env vars, ...)
    adapters/
      action/    # GitHub Action entrypoint
      app/       # Hono webhook server, HMAC, idempotency, App auth
      github/    # GitHubClient interface + Octokit impl + fake for tests
    cli.ts
  evals/         # cases, cassettes, graders, runner, reports
  test/
  docs/          # PLAN.md, PROGRESS.md, specs/, ablations.md
  ```

## Testing rules

- **Unit tests never call the real Anthropic API** — use `ScriptedModel` or `ReplayModel`.
- **Unit tests never call the real GitHub API** — use the fake `GitHubClient`.
- Every tool has a test. Every loop exit condition has a test.
- Commands:
  - `pnpm test`
  - `pnpm lint` (biome check) · `pnpm typecheck` (tsc --noEmit)
  - `pnpm diffwise review --repo <path> --base main --head HEAD --mode replay`
  - `pnpm eval --suite smoke --mode replay`

## Definition of done (per sub-task)

Tests pass, lint and typecheck pass, tags present where concepts live, `docs/PROGRESS.md` updated,
and a 3–5 line **"what you should understand now"** note printed at the end so Sebas can rewrite it
in his own words in `LEARNING.md`.
