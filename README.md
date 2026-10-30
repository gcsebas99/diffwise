# Diffwise

An AI agent that reviews pull requests against rules defined in the target repo
(`.review-rules.yaml`). It posts inline comments, a summary, and a pass/fail verdict computed by code.
Ships as a GitHub Action and a GitHub App from one core engine.

> Work in progress. See `docs/PLAN.md` and `docs/PROGRESS.md`.

## Development

Requires Node 22 and pnpm.

```sh
pnpm install
cp .env.example .env   # only needed for live runs
pnpm test && pnpm lint && pnpm typecheck
pnpm diffwise --help
```
