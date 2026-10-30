import { Command, Option } from "commander";
import { loadConfig, requireLiveConfig } from "./config.js";

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
  .action((opts: { repo: string; base: string; head: string; mode: "live" | "replay" }) => {
    const config = loadConfig();
    if (opts.mode === "live") requireLiveConfig(config);
    // Wired up in 1.9 once rules, diff, tools, loop and verdict exist.
    console.error(
      `review ${opts.repo} ${opts.base}...${opts.head} (${opts.mode}): not implemented yet`,
    );
    process.exitCode = 1;
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
