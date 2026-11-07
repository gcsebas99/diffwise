import type {
  ExistingReview,
  GitHubClient,
  NewReview,
  PrRef,
  PullRequest,
  ReviewComment,
} from "./client.js";

export interface StoredReview extends ExistingReview {
  comments: ReviewComment[];
}

// [HARNESS:ORCH] A fake GitHub that keeps reviews in memory and records every call.
// WHY: publish tests must check exactly what would reach GitHub (comment lines, summary text,
//      which review got edited) with no token, no network and no real PR.
export class FakeGitHubClient implements GitHubClient {
  readonly calls: { method: keyof GitHubClient; args: unknown[] }[] = [];
  readonly reviews: StoredReview[] = [];
  failUpdates = false; // simulate GitHub refusing an edit, e.g. a review we don't own
  private readonly pull: PullRequest;
  private nextId = 1;

  constructor(pull: PullRequest) {
    this.pull = pull;
  }

  async getPullRequest(pr: PrRef): Promise<PullRequest> {
    this.record("getPullRequest", pr);
    return { ...this.pull };
  }

  async listReviews(pr: PrRef): Promise<ExistingReview[]> {
    this.record("listReviews", pr);
    return this.reviews.map(({ comments: _, ...review }) => ({ ...review }));
  }

  async createReview(pr: PrRef, review: NewReview): Promise<{ id: number; url: string }> {
    this.record("createReview", pr, review);
    const id = this.addReview({ body: review.body, authorType: "Bot", commitId: review.commitId });
    const stored = this.reviews.find((r) => r.id === id);
    if (stored) stored.comments = structuredClone(review.comments);
    return { id, url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}#r${id}` };
  }

  async updateReview(pr: PrRef, reviewId: number, body: string): Promise<void> {
    this.record("updateReview", pr, reviewId, body);
    const review = this.reviews.find((r) => r.id === reviewId);
    if (this.failUpdates || !review) throw new Error(`Cannot update review ${reviewId}`);
    review.body = body;
  }

  // Seeds a review that already exists, e.g. our own from an earlier push, or a human's.
  addReview(review: Omit<ExistingReview, "id">): number {
    const id = this.nextId++;
    this.reviews.push({ ...review, id, comments: [] });
    return id;
  }

  // A copy, so a later change to the caller's objects can't rewrite what was "sent".
  private record(method: keyof GitHubClient, ...args: unknown[]): void {
    this.calls.push({ method, args: structuredClone(args) });
  }
}
