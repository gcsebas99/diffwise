import { execFile } from "node:child_process";
import { copyFile, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type EvalCase, FIXTURES_DIR } from "./case.js";

const execFileAsync = promisify(execFile);

export const BASE_REF = "main";
export const HEAD_REF = "pr";

export interface CaseRepo {
  path: string;
  base: typeof BASE_REF;
  head: typeof HEAD_REF;
  cleanup(): Promise<void>;
}

// [HARNESS:EVAL] Every trial gets a fresh repo, built the same way down to the commit SHAs.
// WHY: trials must not share state (one run's files can't leak into the next), and the input
//      must be identical every time, or a replayed cassette and a live run review different PRs.
//      No user git config (hooks, signing, autocrlf) and fixed identity and dates make it so.
// INTERVIEW: "How do you make agent evals reproducible?" → isolated, pinned inputs per trial;
//            record/replay for the model; only then compare runs.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Diffwise Evals",
  GIT_AUTHOR_EMAIL: "evals@diffwise.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Diffwise Evals",
  GIT_COMMITTER_EMAIL: "evals@diffwise.invalid",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, env: GIT_ENV });
}

// Base commit = fixtures/app + the case's rules + .env.example; head commit = base + patch.diff.
export async function materialize(c: EvalCase): Promise<CaseRepo> {
  const path = await mkdtemp(join(tmpdir(), `diffwise-eval-${c.id}-`));
  const cleanup = () => rm(path, { recursive: true, force: true });
  try {
    await cp(join(FIXTURES_DIR, "app"), path, { recursive: true });
    await copyFile(c.rulesPath, join(path, ".review-rules.yaml"));
    await copyFile(join(FIXTURES_DIR, "env.example"), join(path, ".env.example"));
    await git(path, ["init", "--quiet", `--initial-branch=${BASE_REF}`]);
    await git(path, ["add", "--all"]);
    await git(path, ["commit", "--quiet", "--message", "base"]);

    await git(path, ["switch", "--quiet", "--create", HEAD_REF]);
    try {
      await git(path, ["apply", "--index", c.patchPath]);
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr?.trim() ?? String(err);
      throw new Error(`eval case '${c.id}': patch.diff doesn't apply to the fixture:\n${stderr}`);
    }
    await git(path, ["commit", "--quiet", "--message", c.pr?.title ?? c.id]);
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { path, base: BASE_REF, head: HEAD_REF, cleanup };
}
