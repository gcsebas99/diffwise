import { runChecks } from "../checks/index.js";
import type { Config } from "../config.js";
import type { ModelClient, Usage } from "../model/types.js";
import { estimateCost } from "./cost.js";
import type { FileDiff } from "./diff.js";
import { type LoopEvent, type ReviewRun, runReview } from "./loop.js";
import { buildInitialMessage, buildSystemPrompt } from "./prompt.js";
import type { RepoSource } from "./repo-source.js";
import { createReviewState } from "./review.js";
import { type RuleSet, rulesForFile } from "./rules.js";
import { createDefaultRegistry } from "./tools/index.js";
import { computeVerdict, type VerdictResult } from "./verdict.js";

export interface ReviewChangesOptions {
  source: RepoSource;
  rules: RuleSet;
  files: readonly FileDiff[];
  model?: ModelClient; // absent in deterministic-only mode: only the checks run
  modelName?: string; // for the cost estimate; the client already knows which model it calls
  config: Config;
  pr?: { title?: string; body?: string }; // the Action has a PR; a local CLI run doesn't
  onEvent?: (event: LoopEvent) => void;
}

const NO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export type ModelSkipped = "deterministic-only" | "no-llm-rules";

// Stands in for the model's summary, so every output says what wasn't checked.
const SKIPPED_SUMMARY: Record<ModelSkipped, string> = {
  "deterministic-only": "Only the automated checks ran; LLM rules were not checked.",
  "no-llm-rules":
    "Only the automated checks ran: no changed file has a rule for the model to check.",
};

export interface ReviewOutcome {
  run: ReviewRun;
  verdict: VerdictResult;
  cost: number | undefined;
  modelSkipped?: ModelSkipped; // set when only the deterministic checks ran
}

// True when at least one changed file has a rule the model must check.
// The adapters skip the model (and its cost) when nothing in the PR needs it.
export function needsModel(rules: RuleSet, files: readonly FileDiff[]): boolean {
  return files.some((file) =>
    rulesForFile(rules, file.path).some((rule) => rule.check.kind === "llm"),
  );
}

// [HARNESS:ORCH] One engine, two adapters: the CLI and the Action both call this.
// WHY: prompt, tools, limits and verdict must be identical wherever a review runs, or a PR
//      could pass in CI and fail locally. Adapters only gather inputs and deliver results.
// INTERVIEW: "How is the agent structured?" → a core that knows nothing about GitHub or the
//            terminal, plus thin adapters for each place it runs (CLI, Action, App).
export async function reviewChanges(options: ReviewChangesOptions): Promise<ReviewOutcome> {
  const { source, rules, files, config } = options;
  const checked = await runChecks(rules, files, source);

  // Checks-only run: complete (everything that was asked ran), 0 steps, 0 tokens, $0.
  // "No LLM rules apply" wins over "no model": it's true whatever mode the adapter chose.
  const modelSkipped: ModelSkipped | undefined = !needsModel(rules, files)
    ? "no-llm-rules"
    : !options.model
      ? "deterministic-only"
      : undefined;
  if (modelSkipped || !options.model) {
    const run: ReviewRun = {
      outcome: "completed",
      complete: true,
      findings: checked,
      summary: SKIPPED_SUMMARY[modelSkipped ?? "deterministic-only"],
      steps: 0,
      usage: NO_USAGE,
      promptVersion: "none",
    };
    return { run, verdict: computeVerdict(run.findings, true), cost: 0, modelSkipped };
  }

  // Seeded into the state, so the verdict counts them and no early exit can lose them.
  const state = createReviewState();
  state.findings.push(...checked);
  const run = await runReview({
    model: options.model,
    registry: createDefaultRegistry(),
    ctx: { source, rules, files, maxOutputChars: config.DIFFWISE_TOOL_OUTPUT_MAX_CHARS, state },
    system: buildSystemPrompt(rules),
    initialMessage: buildInitialMessage({ ...options.pr, files, rules, alreadyReported: checked }),
    limits: {
      maxSteps: config.DIFFWISE_MAX_STEPS,
      tokenBudget: config.DIFFWISE_TOKEN_BUDGET,
      deadlineMs: config.DIFFWISE_DEADLINE_SECONDS * 1000,
    },
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });
  return {
    run,
    verdict: computeVerdict(run.findings, run.complete),
    cost: options.modelName ? estimateCost(options.modelName, run.usage) : undefined,
  };
}
