import type { Config } from "../config.js";
import type { ModelClient } from "../model/types.js";
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
  model: ModelClient;
  modelName: string; // for the cost estimate; the client already knows which model it calls
  config: Config;
  pr?: { title?: string; body?: string }; // the Action has a PR; a local CLI run doesn't
  onEvent?: (event: LoopEvent) => void;
}

export interface ReviewOutcome {
  run: ReviewRun;
  verdict: VerdictResult;
  cost: number | undefined;
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
  const run = await runReview({
    model: options.model,
    registry: createDefaultRegistry(),
    ctx: {
      source,
      rules,
      files,
      maxOutputChars: config.DIFFWISE_TOOL_OUTPUT_MAX_CHARS,
      state: createReviewState(),
    },
    system: buildSystemPrompt(rules),
    initialMessage: buildInitialMessage({ ...options.pr, files, rules }),
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
    cost: estimateCost(options.modelName, run.usage),
  };
}
