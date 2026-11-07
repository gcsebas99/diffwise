import { describe, expect, it } from "vitest";
import { OctokitGitHubClient } from "../../../src/adapters/github/octokit.js";

const PR = { owner: "o", repo: "r", number: 7 };

interface SentRequest {
  method: string;
  url: string;
  body: unknown;
}

// A fake fetch that plays back responses and records requests: nothing leaves the machine.
function fakeFetch(...replies: Response[]) {
  const requests: SentRequest[] = [];
  const fetch = async (url: unknown, init?: RequestInit) => {
    requests.push({
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected extra request");
    return reply;
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });

const clientWith = (fetch: typeof globalThis.fetch) =>
  new OctokitGitHubClient({ token: "test-token", fetch });

describe("OctokitGitHubClient", () => {
  it("maps a pull request and turns a null description into an empty string", async () => {
    const fake = fakeFetch(
      json({
        number: 7,
        title: "Add filter",
        body: null,
        base: { sha: "b1" },
        head: { sha: "h1" },
      }),
    );
    const pull = await clientWith(fake.fetch).getPullRequest(PR);
    expect(pull).toEqual({
      number: 7,
      title: "Add filter",
      body: "",
      baseSha: "b1",
      headSha: "h1",
    });
    expect(fake.requests[0]?.url).toBe("https://api.github.com/repos/o/r/pulls/7");
  });

  it("follows the Link header to read every page of reviews", async () => {
    const review = (id: number, user: { type: string } | null) => ({
      id,
      body: `review ${id}`,
      user,
      commit_id: "h1",
    });
    const next =
      '<https://api.github.com/repos/o/r/pulls/7/reviews?per_page=100&page=2>; rel="next"';
    const fake = fakeFetch(
      json([review(1, { type: "Bot" })], { link: next }),
      json([review(2, null)]),
    );
    const reviews = await clientWith(fake.fetch).listReviews(PR);
    expect(reviews).toEqual([
      { id: 1, body: "review 1", authorType: "Bot", commitId: "h1" },
      { id: 2, body: "review 2", authorType: undefined, commitId: "h1" },
    ]);
    expect(fake.requests).toHaveLength(2);
  });

  it("creates a review with GitHub's field names", async () => {
    const fake = fakeFetch(json({ id: 42, html_url: "https://github.com/o/r/pull/7#r42" }));
    const comments = [{ path: "a.ts", line: 3, side: "RIGHT" as const, body: "Problem." }];
    const created = await clientWith(fake.fetch).createReview(PR, {
      commitId: "h1",
      event: "COMMENT",
      body: "Summary",
      comments,
    });
    expect(created).toEqual({ id: 42, url: "https://github.com/o/r/pull/7#r42" });
    expect(fake.requests[0]).toMatchObject({
      method: "POST",
      url: "https://api.github.com/repos/o/r/pulls/7/reviews",
      body: { commit_id: "h1", event: "COMMENT", body: "Summary", comments },
    });
  });

  it("updates only a review's body", async () => {
    const fake = fakeFetch(json({ id: 42 }));
    await clientWith(fake.fetch).updateReview(PR, 42, "Outdated");
    expect(fake.requests[0]).toMatchObject({
      method: "PUT",
      url: "https://api.github.com/repos/o/r/pulls/7/reviews/42",
      body: { body: "Outdated" },
    });
  });
});
