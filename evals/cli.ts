import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command, Option } from "commander";
import { type Config, loadConfig, requireLiveConfig } from "../src/config.js";
import { AnthropicModel } from "../src/model/anthropic.js";
import { RecordingModel } from "../src/model/recording.js";
import { ReplayModel } from "../src/model/replay.js";
import { EVALS_DIR, FULL_SUITE, loadCases } from "./case.js";
import { compareReports, comparisonToMarkdown } from "./compare.js";
import { type Report, summarize, toMarkdown } from "./report.js";
import {
  cassettePath,
  type EvalMode,
  type ModelFactory,
  runSuite,
  type TrialRecord,
} from "./runner.js";

// Same convention as the CLI: 0 = ran, 2 = could not run (setup or harness error).
// Pass/fail thresholds are the CI gate's job (3.6), not this command's.
const EXIT_HARNESS_ERROR = 2;
const REPORTS_DIR = join(EVALS_DIR, "reports");

interface RunOpts {
  suite: string;
  k: number;
  mode: EvalMode;
  concurrency: number;
}

function models(mode: EvalMode, config: Config): { modelName: string; factory: ModelFactory } {
  if (mode === "replay") {
    // No key needed, but the model name is part of every request hash.
    const modelName = config.DIFFWISE_MODEL;
    if (!modelName) throw new Error("Replay needs DIFFWISE_MODEL: the model the cassettes used");
    return { modelName, factory: (c, t) => new ReplayModel(modelName, cassettePath(c.id, t)) };
  }
  const live = requireLiveConfig(config);
  const modelName = live.DIFFWISE_MODEL;
  const anthropic = () => new AnthropicModel({ apiKey: live.ANTHROPIC_API_KEY, model: modelName });
  if (mode === "live") return { modelName, factory: () => anthropic() };
  return {
    modelName,
    factory: (c, t) => new RecordingModel(anthropic(), modelName, cassettePath(c.id, t)),
  };
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: EVALS_DIR, encoding: "utf8" }).trim();
}

function progress(t: TrialRecord): string {
  const id = `${t.caseId} #${t.trial}`;
  if (t.status === "error") return `  ! ${id}  error: ${t.error.split("\n")[0]}`;
  const failed = t.grade.grades.filter((g) => !g.passed).map((g) => g.name);
  const cost = t.result.cost === undefined ? "$?" : `$${t.result.cost.toFixed(4)}`;
  const mark = t.grade.passed ? "✓" : "✗";
  const why = failed.length ? `  (${failed.join(", ")})` : "";
  return `  ${mark} ${id}  ${t.result.steps} steps, ${cost}${why}`;
}

const program = new Command()
  .name("eval")
  .description("Run Diffwise's eval cases and compare runs");

program
  .command("run", { isDefault: true })
  .description("Run a suite k times per case and write a report")
  .option("--suite <name>", `"${FULL_SUITE}" or any case tag (smoke, adversarial, ...)`, FULL_SUITE)
  .option("--k <n>", "trials per case", (v) => Number.parseInt(v, 10), 1)
  .addOption(
    new Option(
      "--mode <mode>",
      "live calls the API; record also saves cassettes; replay serves them",
    )
      .choices(["live", "record", "replay"])
      .default("replay"),
  )
  .option("--concurrency <n>", "trials in parallel", (v) => Number.parseInt(v, 10), 3)
  .action(async (opts: RunOpts) => {
    if (!(opts.k >= 1) || !(opts.concurrency >= 1))
      throw new Error("--k and --concurrency must be >= 1");
    const config = loadConfig();
    const { modelName, factory } = models(opts.mode, config);
    const cases = await loadCases(opts.suite);
    const startedAt = new Date();
    console.log(
      `Eval ${opts.suite}: ${cases.length} cases × k=${opts.k}, ${opts.mode}, ${modelName}`,
    );

    const records = await runSuite(cases, {
      config,
      modelName,
      createModel: factory,
      k: opts.k,
      concurrency: opts.concurrency,
      onTrial: (t) => console.log(progress(t)),
    });
    const report = summarize(records, new Map(cases.map((c) => [c.id, c.tags])), {
      suite: opts.suite,
      mode: opts.mode,
      k: opts.k,
      model: modelName,
      gitSha: git(["rev-parse", "HEAD"]),
      gitDirty: git(["status", "--porcelain"]) !== "",
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
    });

    await mkdir(REPORTS_DIR, { recursive: true });
    const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
    const base = join(REPORTS_DIR, `${stamp}-${opts.suite}-${opts.mode}`);
    await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(`${base}.md`, toMarkdown(report));

    const t = report.totals;
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    console.log(
      `\npass rate ${pct(t.passRate)} · pass@${opts.k} ${pct(t.passAtK)} · pass^${opts.k} ${pct(t.passHatK)} · ` +
        `$${report.cost.total.toFixed(4)} total · ${t.errors} errors`,
    );
    console.log(`report: ${base}.md`);
    if (t.errors > 0) {
      console.error(
        "harness errors (not agent failures): see the report; re-record stale cassettes",
      );
      process.exitCode = EXIT_HARNESS_ERROR;
    }
  });

program
  .command("compare <before> <after>")
  .description("Compare two report JSON files: regressions, fixes, cost and per-rule changes")
  .action(async (before: string, after: string) => {
    const read = async (path: string) => JSON.parse(await readFile(path, "utf8")) as Report;
    console.log(comparisonToMarkdown(compareReports(await read(before), await read(after))));
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = EXIT_HARNESS_ERROR;
});
