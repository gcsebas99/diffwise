import { Octokit } from "@octokit/rest";
import type { ExistingReview, GitHubClient, NewReview, PrRef, PullRequest } from "./client.js";

export interface OctokitClientOptions {
  token: string; // GITHUB_TOKEN in the Action; an installation token in the App (Phase 4)
  baseUrl?: string; // GITHUB_API_URL on GitHub Enterprise Server; api.github.com otherwise
  fetch?: typeof globalThis.fetch; // tests pass a fake, so nothing leaves the machine
}

// The only file that knows GitHub's REST field names (pull_number, commit_id, html_url).
export class OctokitGitHubClient implements GitHubClient {
  private readonly octokit: Octokit;

  constructor(options: OctokitClientOptions) {
    this.octokit = new Octokit({
      auth: options.token,
      userAgent: "diffwise",
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.fetch ? { request: { fetch: options.fetch } } : {}),
    });
  }

  async getPullRequest(pr: PrRef): Promise<PullRequest> {
    const { data } = await this.octokit.rest.pulls.get(params(pr));
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? "",
      baseSha: data.base.sha,
      headSha: data.head.sha,
    };
  }

  // [GH:API] List reviews with pagination: GitHub returns at most 100 per page.
  // WHY: a busy PR can have more reviews than one page; reading only page 1 would miss our
  //      latest review and leave the old one looking current.
  async listReviews(pr: PrRef): Promise<ExistingReview[]> {
    const reviews = await this.octokit.paginate(this.octokit.rest.pulls.listReviews, {
      ...params(pr),
      per_page: 100,
    });
    return reviews.map((review) => ({
      id: review.id,
      body: review.body,
      authorType: review.user?.type,
      commitId: review.commit_id,
    }));
  }

  async createReview(pr: PrRef, review: NewReview): Promise<{ id: number; url: string }> {
    const { data } = await this.octokit.rest.pulls.createReview({
      ...params(pr),
      commit_id: review.commitId,
      event: review.event,
      body: review.body,
      comments: review.comments,
    });
    return { id: data.id, url: data.html_url };
  }

  async updateReview(pr: PrRef, reviewId: number, body: string): Promise<void> {
    await this.octokit.rest.pulls.updateReview({ ...params(pr), review_id: reviewId, body });
  }
}

const params = (pr: PrRef) => ({ owner: pr.owner, repo: pr.repo, pull_number: pr.number });
