import type {
  ExistingReview,
  GitHubClient,
  NewReview,
  PrRef,
  PullRequest,
  PullRequestFile,
  RepoRef,
  ReviewComment,
  TreeEntry,
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
  // The repo as the App sees it through the API: changed files, and file text per commit.
  files: PullRequestFile[] = [];
  readonly contents = new Map<string, string>(); // `${ref}:${path}` → text
  treeTruncated = false;
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

  async listPullRequestFiles(pr: PrRef): Promise<PullRequestFile[]> {
    this.record("listPullRequestFiles", pr);
    return structuredClone(this.files);
  }

  async getFileContent(repo: RepoRef, ref: string, path: string): Promise<string | undefined> {
    this.record("getFileContent", repo, ref, path);
    return this.contents.get(`${ref}:${path}`);
  }

  async getTree(repo: RepoRef, sha: string): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    this.record("getTree", repo, sha);
    const prefix = `${sha}:`;
    const entries = [...this.contents]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, text]) => ({
        path: key.slice(prefix.length),
        type: "blob" as const,
        size: text.length,
      }));
    return { entries, truncated: this.treeTruncated };
  }

  // Seeds a file at a commit, for getFileContent and getTree.
  setFile(ref: string, path: string, text: string): void {
    this.contents.set(`${ref}:${path}`, text);
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
