import type { Config } from "../../config.js";
import { needsModel, reviewChanges } from "../../core/engine.js";
import { publishReview } from "../../core/publish.js";
import { parseRules } from "../../core/rules.js";
import type { ModelClient } from "../../model/types.js";
import type { CheckRunUpdate, GitHubClient, PrRef } from "../github/client.js";
import { GitHubApiSource } from "./api-source.js";
import { type InstallationTokens, REVIEW_PERMISSIONS } from "./auth.js";
import { CHECK_NAME, completedCheck, erroredCheck, skippedCheck } from "./check-run.js";
import type { ReviewJob } from "./webhook.js";

const RULES_FILE = ".review-rules.yaml";

export interface ReviewJobDeps {
  tokens: Pick<InstallationTokens, "get">;
  createGitHub: (token: string) => GitHubClient;
  config: Config;
  model?: { client: () => ModelClient; name: string }; // absent: deterministic checks only
  reviewedHeads: Map<string, string>; // PR key → last head SHA reviewed (per process)
}

export type JobResult =
  | { status: "skipped"; reason: string; headSha: string }
  | {
      status: "reviewed";
      headSha: string;
      verdict: "pass" | "fail" | "neutral";
      findings: number;
      costUsd: number | undefined;
      reviewUrl: string | undefined; // undefined: nothing to post (checks only, no findings)
    };

async function connect(job: ReviewJob, deps: ReviewJobDeps): Promise<GitHubClient> {
  const { token } = await deps.tokens.get(job.installationId, {
    repositories: [job.repo],
    permissions: REVIEW_PERMISSIONS,
  });
  return deps.createGitHub(token);
}

export async function runReviewJob(job: ReviewJob, deps: ReviewJobDeps): Promise<JobResult> {
  const pr: PrRef = { owner: job.owner, repo: job.repo, number: job.number };
  const github = await connect(job, deps);

  // Review the PR as it is now, not as the webhook described it: deliveries can arrive out of
  // order, and a replaced job may have been the newer one. The latest head is what matters.
  const current = await github.getPullRequest(pr);
  const key = `${pr.owner}/${pr.repo}#${pr.number}`;
  if (deps.reviewedHeads.get(key) === current.headSha) {
    return {
      status: "skipped",
      reason: "this head was already reviewed",
      headSha: current.headSha,
    };
  }

  const check = await github.createCheckRun(pr, {
    name: CHECK_NAME,
    headSha: current.headSha,
    status: "in_progress",
    output: { title: "Reviewing…", summary: "Diffwise is reviewing this commit." },
  });
  let checkDone = false;
  const complete = async (update: CheckRunUpdate) => {
    await github.updateCheckRun(pr, check.id, { status: "completed", ...update });
    checkDone = true;
  };

  // [GH:API] Never leave a check "in progress": every path out of here completes it.
  // WHY: a stuck check looks like a review still running, and a required one blocks the merge
  //      forever. An error becomes a neutral conclusion that says it didn't run, not a fail.
  //      (If the process itself dies, nothing here runs; that needs a sweep from outside.)
  try {
    // [HARNESS:GUARD] Rules come from the base commit, never from the PR's head.
    // WHY: the rules file is part of the repo, so a PR can edit it; read at head, a PR could
    //      delete the rule it breaks and pass its own review. At base, a rules change takes
    //      effect only after it's been reviewed and merged.
    const rulesText = await github.getFileContent(pr, current.baseSha, RULES_FILE);
    if (rulesText === undefined) {
      const reason = `no ${RULES_FILE} on the base branch; add one to enable Diffwise`;
      await complete({ conclusion: "skipped", output: skippedCheck(reason) });
      return { status: "skipped", reason, headSha: current.headSha };
    }
    const rules = parseRules(rulesText, `${RULES_FILE} at ${current.baseSha.slice(0, 7)}`);

    const source = new GitHubApiSource(github, pr, current.headSha);
    const files = await source.diff();
    const model = deps.model && needsModel(rules, files) ? deps.model : undefined;
    const outcome = await reviewChanges({
      source,
      rules,
      files,
      config: deps.config,
      pr: { title: current.title, body: current.body },
      ...(model ? { model: model.client(), modelName: model.name } : {}),
    });
    const input = { ...outcome, model: model?.name ?? "none" };

    // The check first: it's the verdict branch protection reads. If posting the review fails
    // after this, the verdict still stands; only the link to the review is missing.
    const done = completedCheck(input);
    await complete({ conclusion: done.conclusion, output: done.output });
    for (const annotations of done.moreAnnotations) {
      await github.updateCheckRun(pr, check.id, { output: { ...done.output, annotations } });
    }

    // Same rule as the Action: a checks-only run with nothing to say posts no review.
    let reviewUrl: string | undefined;
    if (!(outcome.modelSkipped && outcome.run.findings.length === 0)) {
      const published = await publishReview(github, pr, { ...input, commitId: current.headSha });
      reviewUrl = published.url;
      await github.updateCheckRun(pr, check.id, { detailsUrl: published.url });
    }
    deps.reviewedHeads.set(key, current.headSha);
    return {
      status: "reviewed",
      headSha: current.headSha,
      verdict: outcome.verdict.verdict,
      findings: outcome.run.findings.length,
      costUsd: outcome.cost,
      reviewUrl,
    };
  } catch (err) {
    // A failure after the check completed (posting the review) keeps the real verdict.
    if (!checkDone) {
      await complete({ conclusion: "neutral", output: erroredCheck(err) }).catch(() => {});
    }
    throw err;
  }
}

// The queue skipped this job (daily cap): say so on the commit, or the PR shows no check at all.
export async function reportSkipped(
  job: ReviewJob,
  reason: string,
  deps: ReviewJobDeps,
): Promise<void> {
  const github = await connect(job, deps);
  await github.createCheckRun(job, {
    name: CHECK_NAME,
    headSha: job.headSha,
    status: "completed",
    conclusion: "neutral",
    output: skippedCheck(reason),
  });
}
