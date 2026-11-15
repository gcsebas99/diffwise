import { describe, expect, it } from "vitest";
import {
  type ReviewJobDeps,
  reportSkipped,
  runReviewJob,
} from "../../../src/adapters/app/review-job.js";
import type { ReviewJob } from "../../../src/adapters/app/webhook.js";
import { FakeGitHubClient } from "../../../src/adapters/github/fake.js";
import { loadConfig } from "../../../src/config.js";

const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const OLD_HEAD = "a".repeat(40);

const RULES = `version: 1
rules:
  - id: no-secrets-in-diff
    title: No secrets in code
    severity: blocking
    applies_to: ["**/*"]
    check: deterministic:secrets
`;

const job: ReviewJob = {
  deliveryId: "d1",
  installationId: 1,
  owner: "o",
  repo: "r",
  number: 7,
  headSha: OLD_HEAD, // the webhook's head; the PR has moved on since
  baseSha: BASE,
  title: "from the webhook",
  body: "",
};

function setup() {
  const github = new FakeGitHubClient({
    number: 7,
    title: "Add config",
    body: "",
    baseSha: BASE,
    headSha: HEAD,
  });
  github.setFile(BASE, ".review-rules.yaml", RULES);
  github.files = [
    {
      filename: "src/config.ts",
      status: "added",
      additions: 1,
      deletions: 0,
      patch: '@@ -0,0 +1 @@\n+const password = "hunter2hunter2";',
    },
  ];
  const tokens: string[] = [];
  const scopes: unknown[] = [];
  const deps: ReviewJobDeps = {
    tokens: {
      get: async (id, scope) => {
        scopes.push({ id, ...scope });
        return {
          token: "ghs_fake",
          expiresAt: new Date(),
          permissions: {},
          repositories: undefined,
        };
      },
    },
    createGitHub: (token) => {
      tokens.push(token);
      return github;
    },
    config: loadConfig({}),
    reviewedHeads: new Map(),
  };
  return { github, deps, tokens, scopes };
}

describe("runReviewJob", () => {
  it("reviews the PR's current head with a down-scoped token and posts the review", async () => {
    const { github, deps, tokens, scopes } = setup();
    const result = await runReviewJob(job, deps);
    expect(result).toMatchObject({
      status: "reviewed",
      headSha: HEAD,
      verdict: "fail",
      findings: 1,
    });
    expect(tokens).toEqual(["ghs_fake"]);
    expect(scopes).toEqual([
      {
        id: 1,
        repositories: ["r"],
        permissions: { pull_requests: "write", contents: "read", checks: "write" },
      },
    ]);
    expect(github.reviews).toHaveLength(1);
    expect(github.reviews[0]?.commitId).toBe(HEAD);
    expect(github.reviews[0]?.comments.map((c) => `${c.path}:${c.line}`)).toEqual([
      "src/config.ts:1",
    ]);
  });

  it("reads the rules at the base commit, so a PR can't delete the rule it breaks", async () => {
    const { github, deps } = setup();
    github.setFile(HEAD, ".review-rules.yaml", "version: 1\nrules: []\n");
    const result = await runReviewJob(job, deps);
    expect(result).toMatchObject({ status: "reviewed", verdict: "fail" });
    const rulesReads = github.calls.filter(
      (c) => c.method === "getFileContent" && c.args[2] === ".review-rules.yaml",
    );
    expect(rulesReads.map((c) => c.args[1])).toEqual([BASE]);
  });

  it("skips a head it already reviewed (a redelivery after a replaced job)", async () => {
    const { github, deps } = setup();
    await runReviewJob(job, deps);
    const again = await runReviewJob({ ...job, deliveryId: "d2" }, deps);
    expect(again).toEqual({
      status: "skipped",
      reason: "this head was already reviewed",
      headSha: HEAD,
    });
    expect(github.reviews).toHaveLength(1);
  });

  it("skips a repo with no rules file on the base branch", async () => {
    const { github, deps } = setup();
    github.contents.clear();
    expect(await runReviewJob(job, deps)).toMatchObject({
      status: "skipped",
      reason: "no .review-rules.yaml on the base branch; add one to enable Diffwise",
    });
    expect(github.reviews).toHaveLength(0);
  });

  it("a checks-only run with no findings posts nothing", async () => {
    const { github, deps } = setup();
    github.files = [
      {
        filename: "README.md",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1 +1,2 @@\n hi\n+there",
      },
    ];
    expect(await runReviewJob(job, deps)).toMatchObject({
      status: "reviewed",
      verdict: "pass",
      reviewUrl: undefined,
    });
    expect(github.reviews).toHaveLength(0);
  });

  it("completes a failure check run before posting the review, then links it", async () => {
    const { github, deps } = setup();
    await runReviewJob(job, deps);
    expect(github.checkRuns).toHaveLength(1);
    expect(github.checkRuns[0]).toMatchObject({
      name: "Diffwise",
      headSha: HEAD,
      status: "completed",
      conclusion: "failure",
      title: "1 blocking finding",
      detailsUrl: github.reviews[0] ? expect.stringContaining("/pull/7#r") : undefined,
    });
    expect(github.checkRuns[0]?.annotations.map((a) => [a.path, a.startLine, a.level])).toEqual([
      ["src/config.ts", 1, "failure"],
    ]);
    const order = github.calls.map((c) => c.method).filter((m) => /CheckRun|createReview/.test(m));
    expect(order).toEqual(["createCheckRun", "updateCheckRun", "createReview", "updateCheckRun"]);
  });

  it("a crash mid-review completes the check as neutral and still throws", async () => {
    const { github, deps } = setup();
    github.listPullRequestFiles = async () => {
      throw new Error("GitHub 502 listing files");
    };
    await expect(runReviewJob(job, deps)).rejects.toThrow("GitHub 502 listing files");
    expect(github.checkRuns[0]).toMatchObject({
      status: "completed",
      conclusion: "neutral",
      title: "Review failed to run",
    });
    expect(github.checkRuns[0]?.summary).toContain("GitHub 502 listing files");
    expect(deps.reviewedHeads.size).toBe(0); // not reviewed, so a retry runs again
  });

  it("if posting the review fails, the check keeps the real verdict", async () => {
    const { github, deps } = setup();
    github.createReview = async () => {
      throw new Error("422 line outside the diff");
    };
    await expect(runReviewJob(job, deps)).rejects.toThrow("422");
    expect(github.checkRuns[0]).toMatchObject({ conclusion: "failure" });
  });

  it("no rules file completes the check as skipped", async () => {
    const { github, deps } = setup();
    github.contents.clear();
    await runReviewJob(job, deps);
    expect(github.checkRuns[0]).toMatchObject({ conclusion: "skipped", title: "Not reviewed" });
  });

  it("a head already reviewed creates no second check run", async () => {
    const { github, deps } = setup();
    await runReviewJob(job, deps);
    await runReviewJob({ ...job, deliveryId: "d2" }, deps);
    expect(github.checkRuns).toHaveLength(1);
  });

  it("reportSkipped puts a completed neutral check on the webhook's commit", async () => {
    const { github, deps } = setup();
    await reportSkipped(job, "daily review cap (50) reached", deps);
    expect(github.checkRuns[0]).toMatchObject({
      headSha: OLD_HEAD,
      status: "completed",
      conclusion: "neutral",
      summary: "Diffwise didn't review this commit: daily review cap (50) reached.",
    });
  });
});
