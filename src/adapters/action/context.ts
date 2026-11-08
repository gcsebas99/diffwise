import { readFile } from "node:fs/promises";
import { z } from "zod";

// 40 hex for SHA-1 repos, 64 for SHA-256 ones. Also rules out anything git could read as a flag.
const Sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "expected a commit SHA");

// Only the fields we use. Zod drops the rest of the (very large) payload.
const PullRequestEvent = z.object({
  pull_request: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable(),
    base: z.object({ sha: Sha }),
    // repo is null when the fork the PR came from has been deleted.
    head: z.object({ sha: Sha, repo: z.object({ full_name: z.string() }).nullable() }),
  }),
});

const ActionEnv = z.object({
  GITHUB_EVENT_NAME: z.string(),
  GITHUB_EVENT_PATH: z.string().min(1),
  GITHUB_REPOSITORY: z.string().regex(/^[^/]+\/[^/]+$/, "expected owner/repo"),
  GITHUB_WORKSPACE: z.string().min(1),
});

export interface ActionContext {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  baseSha: string;
  headSha: string;
  workspace: string; // where actions/checkout put the repository
  fromFork: boolean; // fork PRs get no secrets and a read-only GITHUB_TOKEN
}

// [GH:ACTIONS] The PR number and both SHAs come from the event payload, not GITHUB_SHA.
// WHY: on pull_request, GITHUB_SHA is a temporary merge commit GitHub builds; review comments
//      must target pull_request.head.sha, the commit the author pushed, and the diff starts
//      at pull_request.base.sha.
// INTERVIEW: "Where does an Action get the PR?" → GITHUB_EVENT_PATH holds the webhook payload
//            as JSON; validate it like any external input before using a field.
export async function readActionContext(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ActionContext> {
  const envResult = ActionEnv.safeParse(env);
  if (!envResult.success) {
    const names = envResult.error.issues.map((i) => i.path.join("."));
    throw new Error(`Not a GitHub Actions run? Missing or invalid: ${names.join(", ")}`);
  }
  const vars = envResult.data;
  // [HARNESS:GUARD] Refuse pull_request_target: it runs with secrets on code from forks.
  // WHY: checking out and reviewing a fork's head with a write token and the API key is the
  //      classic Actions exploit. The workflow should never do it; the action refuses too.
  if (vars.GITHUB_EVENT_NAME !== "pull_request") {
    throw new Error(
      `Diffwise runs on pull_request events only; got '${vars.GITHUB_EVENT_NAME}'.` +
        " Never use pull_request_target with it.",
    );
  }
  const payload: unknown = JSON.parse(await readFile(vars.GITHUB_EVENT_PATH, "utf8"));
  const parsed = PullRequestEvent.safeParse(payload);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Unexpected pull_request payload: ${problems.join("; ")}`);
  }
  const pr = parsed.data.pull_request;
  const [owner = "", repo = ""] = vars.GITHUB_REPOSITORY.split("/");
  return {
    owner,
    repo,
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    workspace: vars.GITHUB_WORKSPACE,
    fromFork: pr.head.repo?.full_name !== vars.GITHUB_REPOSITORY,
  };
}
