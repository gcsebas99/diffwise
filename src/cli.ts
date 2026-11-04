import { join } from "node:path";
import { Command, Option } from "commander";
import { formatEvent, formatReport } from "./cli-format.js";
import { loadConfig, requireLiveConfig } from "./config.js";
import { estimateCost } from "./core/cost.js";
import { LocalGitSource } from "./core/local-git-source.js";
import { runReview } from "./core/loop.js";
import { buildInitialMessage, buildSystemPrompt } from "./core/prompt.js";
import { createReviewState } from "./core/review.js";
import { loadRules } from "./core/rules.js";
import { createDefaultRegistry } from "./core/tools/index.js";
import { computeVerdict } from "./core/verdict.js";
import { AnthropicModel } from "./model/anthropic.js";

// CI reads exit codes, so a setup error (bad config, rules, refs) must not look like a failed
// review: 0 = pass or neutral, 1 = fail, 2 = could not run.
const EXIT_FAIL = 1;
const EXIT_SETUP_ERROR = 2;

const program = new Command()
  .name("diffwise")
  .description("AI agent that reviews pull requests against rules in .review-rules.yaml");

program
  .command("review")
  .description("Review the diff between two refs of a local git checkout")
  .requiredOption("--repo <path>", "path to the target repository")
  .option("--base <ref>", "base ref", "main")
  .option("--head <ref>", "head ref", "HEAD")
  .addOption(
    new Option("--mode <mode>", "model backend").choices(["live", "replay"]).default("live"),
  )
  .action(async (opts: { repo: string; base: string; head: string; mode: "live" | "replay" }) => {
    if (opts.mode === "replay") {
      throw new Error("--mode replay arrives in Phase 3 (Recording/Replay models); use live");
    }
    // Everything that can be wrong with the setup fails here, before the first paid call.
    const config = requireLiveConfig(loadConfig());
    const rules = await loadRules(join(opts.repo, ".review-rules.yaml"));
    const source = await LocalGitSource.open(opts.repo, opts.base, opts.head);
    const files = await source.diff();
    if (files.length === 0) {
      console.log(`No changes between ${opts.base} and ${opts.head}; nothing to review.`);
      return;
    }

    const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
    const range = `${opts.base}...${opts.head}`;
    console.log(`Reviewing ${range}: ${files.length} files, model ${config.DIFFWISE_MODEL}`);

    const model = new AnthropicModel({
      apiKey: config.ANTHROPIC_API_KEY,
      model: config.DIFFWISE_MODEL,
    });
    const run = await runReview({
      model,
      registry: createDefaultRegistry(),
      ctx: {
        source,
        rules,
        files,
        maxOutputChars: config.DIFFWISE_TOOL_OUTPUT_MAX_CHARS,
        state: createReviewState(),
      },
      system: buildSystemPrompt(rules),
      initialMessage: buildInitialMessage({ files, rules }),
      limits: {
        maxSteps: config.DIFFWISE_MAX_STEPS,
        tokenBudget: config.DIFFWISE_TOKEN_BUDGET,
        deadlineMs: config.DIFFWISE_DEADLINE_SECONDS * 1000,
      },
      onEvent: (event) => {
        const line = formatEvent(event, color);
        if (line) console.log(line);
      },
    });

    const verdict = computeVerdict(run.findings, run.complete);
    const cost = estimateCost(config.DIFFWISE_MODEL, run.usage);
    console.log(formatReport(run, verdict, cost, color));
    if (verdict.verdict === "neutral") {
      console.error("warning: the review did not finish, so the verdict is neutral");
    }
    if (verdict.verdict === "fail") process.exitCode = EXIT_FAIL;
  });

program.parseAsync().catch((err: unknown) => {
  // Setup errors only: review problems (model errors, limits) end as an outcome, not a throw.
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = EXIT_SETUP_ERROR;
});
