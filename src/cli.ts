import { join } from "node:path";
import { Command, Option } from "commander";
import { formatEvent, formatReport } from "./cli-format.js";
import { type Config, loadConfig, requireLiveConfig } from "./config.js";
import { reviewChanges } from "./core/engine.js";
import { LocalGitSource } from "./core/local-git-source.js";
import { loadRules } from "./core/rules.js";
import { AnthropicModel } from "./model/anthropic.js";
import { RecordingModel } from "./model/recording.js";
import { ReplayModel } from "./model/replay.js";
import type { ModelClient } from "./model/types.js";

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
    new Option(
      "--mode <mode>",
      "live calls the API; record also saves a cassette; replay serves it",
    )
      .choices(["live", "record", "replay"])
      .default("live"),
  )
  .option("--cassette <path>", "cassette file (JSONL) for record and replay")
  .action(async (opts: ReviewOptions) => {
    // Everything that can be wrong with the setup fails here, before the first paid call.
    const config = loadConfig();
    const { model, modelName } = createModel(opts, config);
    const rules = await loadRules(join(opts.repo, ".review-rules.yaml"));
    const source = await LocalGitSource.open(opts.repo, opts.base, opts.head);
    const files = await source.diff();
    if (files.length === 0) {
      console.log(`No changes between ${opts.base} and ${opts.head}; nothing to review.`);
      return;
    }

    const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
    const range = `${opts.base}...${opts.head}`;
    console.log(`Reviewing ${range}: ${files.length} files, model ${modelName} (${opts.mode})`);

    const { run, verdict, cost } = await reviewChanges({
      source,
      rules,
      files,
      model,
      modelName,
      config,
      onEvent: (event) => {
        const line = formatEvent(event, color);
        if (line) console.log(line);
      },
    });
    console.log(formatReport(run, verdict, cost, color));
    if (verdict.verdict === "neutral") {
      console.error("warning: the review did not finish, so the verdict is neutral");
    }
    if (verdict.verdict === "fail") process.exitCode = EXIT_FAIL;
  });

interface ReviewOptions {
  repo: string;
  base: string;
  head: string;
  mode: "live" | "record" | "replay";
  cassette?: string;
}

type ModelSetup = { model: ModelClient; modelName: string };

function createModel(opts: ReviewOptions, config: Config): ModelSetup {
  if (opts.mode === "live") return liveModel(config);
  if (!opts.cassette) throw new Error(`--mode ${opts.mode} needs --cassette <path>`);
  if (opts.mode === "record") {
    const { model, modelName } = liveModel(config);
    return { model: new RecordingModel(model, modelName, opts.cassette), modelName };
  }
  // Replay needs no API key, but the model name is part of every request hash.
  const modelName = config.DIFFWISE_MODEL;
  if (!modelName) {
    throw new Error("Replay needs DIFFWISE_MODEL: the model the cassette was recorded with");
  }
  return { model: new ReplayModel(modelName, opts.cassette), modelName };
}

function liveModel(config: Config): ModelSetup {
  const live = requireLiveConfig(config);
  const model = new AnthropicModel({ apiKey: live.ANTHROPIC_API_KEY, model: live.DIFFWISE_MODEL });
  return { model, modelName: live.DIFFWISE_MODEL };
}

program.parseAsync().catch((err: unknown) => {
  // Setup errors and harness errors (a cassette miss): review problems end as an outcome.
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = EXIT_SETUP_ERROR;
});
