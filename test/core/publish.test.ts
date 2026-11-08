import { describe, expect, it } from "vitest";
import type { PrRef, PullRequest } from "../../src/adapters/github/client.js";
import { FakeGitHubClient } from "../../src/adapters/github/fake.js";
import type { ReviewRun } from "../../src/core/loop.js";
import {
  formatSummary,
  MARKER,
  OUTDATED_MARKER,
  type PublishInput,
  publishReview,
  sanitize,
} from "../../src/core/publish.js";
import type { Finding } from "../../src/core/review.js";
import { computeVerdict } from "../../src/core/verdict.js";

const PR: PrRef = { owner: "gcsebas99", repo: "diffwise-demo", number: 7 };
const PULL: PullRequest = { number: 7, title: "t", body: "", baseSha: "base1", headSha: "head1" };

const FINDING: Finding = {
  ruleId: "route-needs-test",
  severity: "blocking",
  path: "src/routes/orders.ts",
  line: 8,
  message: "GET /orders changed without a test.",
  suggestion: "Add test/routes/orders.test.ts.",
};

function input(run: Partial<ReviewRun> = {}): PublishInput & { commitId: string } {
  const full: ReviewRun = {
    outcome: "completed",
    complete: true,
    findings: [FINDING],
    summary: "Adds a status filter without tests.",
    steps: 2,
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2549, cacheWriteTokens: 0 },
    promptVersion: "1c7d2e8afc90",
    ...run,
  };
  return {
    run: full,
    verdict: computeVerdict(full.findings, full.complete),
    model: "claude-haiku-5-5",
    cost: 0.0008,
    commitId: "head1",
  };
}

describe("publishReview", () => {
  it("posts one COMMENT review pinned to the commit, with one RIGHT-side comment per finding", async () => {
    const github = new FakeGitHubClient(PULL);
    const result = await publishReview(github, PR, input());

    const create = github.calls.find((c) => c.method === "createReview");
    expect(create?.args[1]).toMatchObject({
      commitId: "head1",
      event: "COMMENT",
      comments: [{ path: "src/routes/orders.ts", line: 8, side: "RIGHT" }],
    });
    expect(github.reviews[0]?.comments[0]?.body).toContain("`route-needs-test`");
    expect(github.reviews[0]?.comments[0]?.body).toContain("**Suggestion:** Add");
    expect(result).toMatchObject({ reviewId: 1, warnings: [] });
  });

  it("posts a review with no inline comments when there are no findings", async () => {
    const github = new FakeGitHubClient(PULL);
    await publishReview(github, PR, input({ findings: [] }));
    expect(github.reviews[0]?.comments).toEqual([]);
    expect(github.reviews[0]?.body).toContain("✅ PASS");
  });

  it("marks only our previous bot review outdated, after posting the new one", async () => {
    const github = new FakeGitHubClient(PULL);
    const ours = github.addReview({ body: `${MARKER}\nold`, authorType: "Bot", commitId: "old" });
    const human = github.addReview({ body: `${MARKER} lgtm`, authorType: "User", commitId: "old" });
    const done = github.addReview({ body: OUTDATED_MARKER, authorType: "Bot", commitId: "older" });

    const result = await publishReview(github, PR, input());

    expect(github.calls.map((c) => c.method)).toEqual([
      "listReviews",
      "createReview",
      "updateReview",
    ]);
    const body = (id: number) => github.reviews.find((r) => r.id === id)?.body;
    expect(body(ours)).toContain(OUTDATED_MARKER);
    expect(body(ours)).toContain(`[latest review](${result.url})`);
    expect(body(ours)).not.toContain(MARKER);
    expect(body(human)).toBe(`${MARKER} lgtm`);
    expect(body(done)).toBe(OUTDATED_MARKER);
  });

  it("keeps the new review and returns a warning when an old one can't be edited", async () => {
    const github = new FakeGitHubClient(PULL);
    github.addReview({ body: MARKER, authorType: "Bot", commitId: "old" });
    github.failUpdates = true;

    const result = await publishReview(github, PR, input());
    expect(result.warnings).toEqual([expect.stringMatching(/could not mark review 1 as outdated/)]);
    expect(github.reviews).toHaveLength(2);
  });

  it("leaves old reviews untouched when posting the new one fails", async () => {
    const github = new FakeGitHubClient(PULL);
    github.addReview({ body: MARKER, authorType: "Bot", commitId: "old" });
    github.createReview = async () => {
      throw new Error("422 Unprocessable Entity");
    };

    await expect(publishReview(github, PR, input())).rejects.toThrow(/422/);
    expect(github.calls.some((c) => c.method === "updateReview")).toBe(false);
    expect(github.reviews[0]?.body).toBe(MARKER);
  });
});

describe("formatSummary", () => {
  it("starts with the marker and shows verdict, findings and how it was produced", () => {
    const body = formatSummary(input());
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain("## Diffwise: ❌ FAIL");
    expect(body).toContain("**1 blocking**, 0 advisory");
    expect(body).toContain("| 🔴 | `route-needs-test` | `src/routes/orders.ts:8` |");
    expect(body).toContain("claude-haiku-5-5 · prompt `1c7d2e8afc90` · 2 steps");
    expect(body).toContain("3,549 in / 500 out tokens · est. $0.0008");
  });

  it("warns that an incomplete review with no findings is not a clean PR", () => {
    const body = formatSummary(
      input({ outcome: "max_steps", complete: false, findings: [], summary: undefined }),
    );
    expect(body).toContain("⚠️ NEUTRAL");
    expect(body).toContain("> [!WARNING]");
    expect(body).toContain("(`max_steps`)");
    expect(body).toContain("no findings does not mean the PR is clean");
    expect(body).toContain("_No summary._");
  });

  it("keeps model text from breaking the findings table", () => {
    const message = "first | second\nthird";
    const body = formatSummary(input({ findings: [{ ...FINDING, message }] }));
    expect(body).toContain("| first \\| second third |");
  });
});

describe("formatSummary for a checks-only run", () => {
  it("says the LLM rules were not checked and that no model ran", () => {
    const body = formatSummary({
      ...input({ findings: [], summary: "Only the automated checks ran.", steps: 0 }),
      modelSkipped: "deterministic-only",
    });
    expect(body).toContain("✅ PASS");
    expect(body).toContain("> [!NOTE]");
    expect(body).toContain("LLM rules were **not checked**: add the `live-review` label");
    expect(body).not.toContain("### Summary");
    expect(body).toContain("<sub>automated checks only · no model call · $0</sub>");
  });
});

describe("sanitize", () => {
  it("breaks @mentions and shows HTML as text", () => {
    expect(sanitize("ping @org/team and @sebas")).toBe("ping @​org/team and @​sebas");
    expect(sanitize('<img src="x">')).toBe('&lt;img src="x">');
  });

  it("leaves a lone @ readable", () => {
    expect(sanitize("a @ b")).toBe("a @ b");
  });
});
