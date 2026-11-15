import { describe, expect, it } from "vitest";
import { type ReviewJobDeps, runReviewJob } from "../../../src/adapters/app/review-job.js";
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
      reason: "no .review-rules.yaml on the base branch",
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
});
