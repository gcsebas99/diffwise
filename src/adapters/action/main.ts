import { join } from "node:path";
import { formatEvent } from "../../cli-format.js";
import { loadConfig } from "../../config.js";
import { needsModel, reviewChanges } from "../../core/engine.js";
import { LocalGitSource } from "../../core/local-git-source.js";
import { formatSummary, publishReview } from "../../core/publish.js";
import { loadRules } from "../../core/rules.js";
import type { ModelClient } from "../../model/types.js";
import type { GitHubClient } from "../github/client.js";
import type { ActionContext } from "./context.js";

export interface Annotation {
  title?: string;
  file?: string;
  startLine?: number;
}

// The slice of @actions/core the action uses; index.ts passes the real one, tests a fake.
export interface ActionIO {
  getInput(name: string): string;
  info(message: string): void;
  warning(message: string, annotation?: Annotation): void;
  error(message: string, annotation?: Annotation): void;
  setSecret(value: string): void;
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
  writeSummary(markdown: string): Promise<void>;
}

export interface ActionDeps {
  readContext(): Promise<ActionContext>;
  createModel(apiKey: string, model: string): ModelClient;
  createGitHub(token: string): GitHubClient;
  env: NodeJS.ProcessEnv; // DIFFWISE_* limits, same variables as the CLI
}

const MODES = ["live", "deterministic-only"] as const;

// [GH:ACTIONS] The job's result is the verdict: setFailed on fail is what branch protection reads.
// WHY: the review is always a COMMENT; a required check that goes red is what blocks the merge,
//      and it's recomputed on every push. Setup problems also fail the job, with a message
//      that says "could not run" so nobody mistakes them for a review result.
export async function run(io: ActionIO, deps: ActionDeps): Promise<void> {
  try {
    await review(io, deps);
  } catch (err) {
    io.setFailed(`Diffwise could not run: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function review(io: ActionIO, deps: ActionDeps): Promise<void> {
  const mode = io.getInput("mode") || "deterministic-only";
  if (!MODES.includes(mode as (typeof MODES)[number])) {
    throw new Error(`input 'mode' must be one of ${MODES.join(", ")}; got '${mode}'`);
  }
  const ctx = await deps.readContext();
  const config = loadConfig(deps.env);
  const rules = await loadRules(join(ctx.workspace, ".review-rules.yaml"));
  const source = await LocalGitSource.open(ctx.workspace, ctx.baseSha, ctx.headSha);
  const files = await source.diff();

  // [HARNESS:GUARD] Cost gate: no model call unless the PR opted in and something needs it.
  // WHY: on a public repo anyone can open PRs; a maintainer-added label decides when to pay,
  //      and PRs that touch no LLM-checked file never pay at all.
  const skipReason =
    mode === "deterministic-only"
      ? "LLM rules were skipped: add the `live-review` label to run them."
      : !needsModel(rules, files)
        ? "No changed file has a rule for the model to check."
        : undefined;
  if (skipReason) {
    io.info(skipReason);
    io.setOutput("verdict", "pass");
    await io.writeSummary(`## Diffwise: ✅ PASS\n\n${skipReason}`);
    return;
  }

  const apiKey = io.getInput("anthropic-api-key");
  if (!apiKey) {
    throw new Error(
      ctx.fromFork
        ? "anthropic-api-key is empty: PRs from forks don't receive secrets, so live mode can't run."
        : "anthropic-api-key is empty: add an ANTHROPIC_API_KEY secret and pass it to the action.",
    );
  }
  io.setSecret(apiKey); // already masked when it comes from a secret; this costs nothing
  const model = io.getInput("model") || config.DIFFWISE_MODEL;
  if (!model) throw new Error("input 'model' is empty (set the DIFFWISE_MODEL variable)");
  const token = io.getInput("github-token");
  if (!token) throw new Error("input 'github-token' is empty");

  io.info(`Reviewing ${files.length} files at ${ctx.headSha.slice(0, 7)} with ${model}`);
  const outcome = await reviewChanges({
    source,
    rules,
    files,
    model: deps.createModel(apiKey, model),
    modelName: model,
    config,
    pr: { title: ctx.title, body: ctx.body },
    onEvent: (event) => {
      const line = formatEvent(event, false);
      if (line) io.info(line);
    },
  });
  const { run: result, verdict } = outcome;

  // Results first, publish last: if posting the review fails, the job log, annotations and
  // summary still show what the review found.
  for (const f of result.findings) {
    const annotate = f.severity === "blocking" ? io.error : io.warning;
    annotate.call(io, f.message, { title: f.ruleId, file: f.path, startLine: f.line });
  }
  const summary = formatSummary({ ...outcome, model });
  await io.writeSummary(summary);
  io.setOutput("verdict", verdict.verdict);

  const pr = { owner: ctx.owner, repo: ctx.repo, number: ctx.number };
  const github = deps.createGitHub(token);
  const published = await publishReview(github, pr, { ...outcome, model, commitId: ctx.headSha });
  for (const warning of published.warnings) io.warning(warning);
  io.setOutput("review-url", published.url);

  if (verdict.verdict === "neutral") {
    io.warning(`The review did not finish (${result.outcome}), so the verdict is neutral.`);
  }
  if (verdict.verdict === "fail") {
    io.setFailed(
      `${verdict.counts.blocking} blocking finding(s). See the review: ${published.url}`,
    );
  }
}
