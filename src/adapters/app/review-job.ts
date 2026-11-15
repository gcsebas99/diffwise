import type { Config } from "../../config.js";
import { needsModel, reviewChanges } from "../../core/engine.js";
import { publishReview } from "../../core/publish.js";
import { parseRules } from "../../core/rules.js";
import type { ModelClient } from "../../model/types.js";
import type { GitHubClient, PrRef } from "../github/client.js";
import { GitHubApiSource } from "./api-source.js";
import { type InstallationTokens, REVIEW_PERMISSIONS } from "./auth.js";
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

export async function runReviewJob(job: ReviewJob, deps: ReviewJobDeps): Promise<JobResult> {
  const pr: PrRef = { owner: job.owner, repo: job.repo, number: job.number };
  const { token } = await deps.tokens.get(job.installationId, {
    repositories: [job.repo],
    permissions: REVIEW_PERMISSIONS,
  });
  const github = deps.createGitHub(token);

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

  // [HARNESS:GUARD] Rules come from the base commit, never from the PR's head.
  // WHY: the rules file is part of the repo, so a PR can edit it; read at head, a PR could
  //      delete the rule it breaks and pass its own review. At base, a rules change takes
  //      effect only after it's been reviewed and merged.
  const rulesText = await github.getFileContent(pr, current.baseSha, RULES_FILE);
  if (rulesText === undefined) {
    return {
      status: "skipped",
      reason: `no ${RULES_FILE} on the base branch`,
      headSha: current.headSha,
    };
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

  // Same rule as the Action: a checks-only run with nothing to say posts no review.
  let reviewUrl: string | undefined;
  if (!(outcome.modelSkipped && outcome.run.findings.length === 0)) {
    const published = await publishReview(github, pr, {
      ...outcome,
      model: model?.name ?? "none",
      commitId: current.headSha,
    });
    reviewUrl = published.url;
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
}
