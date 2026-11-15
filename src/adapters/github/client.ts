export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string; // "" when the PR has no description
  baseSha: string;
  headSha: string;
}

// line + side, not the diff "position" GitHub's docs say is closing down. Findings are on the
// head version of a file (report_finding checked the line is in the diff), so side is RIGHT.
export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

// [GH:API] A review is created already submitted, pinned to the commit that was reviewed.
// WHY: without `event` GitHub creates a PENDING review nobody sees; without `commitId` a push
//      during the review would make GitHub place our line numbers on a newer commit.
export interface NewReview {
  commitId: string;
  // [HARNESS:GUARD] The only event the type allows is "COMMENT": the bot can never approve.
  // WHY: a bot APPROVE could satisfy "required reviews"; the verdict is a check (exit code),
  //      which reruns on every push, not a review state that sticks until someone dismisses it.
  event: "COMMENT";
  body: string;
  comments: ReviewComment[];
}

export interface ExistingReview {
  id: number;
  body: string;
  authorType: string | undefined; // "Bot" for GITHUB_TOKEN and Apps; undefined for a deleted user
  commitId: string | null;
}

// A changed file as GET /pulls/{n}/files returns it. `patch` is absent for binary and very
// large files; the endpoint stops at 3000 files.
export interface PullRequestFile {
  filename: string;
  previousFilename?: string; // set for renames and copies
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  patch?: string;
}

export interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit"; // commit = a submodule
  size?: number; // blobs only
}

export interface CheckAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  level: "notice" | "warning" | "failure";
  title: string; // ≤ 255 chars
  message: string;
}

export interface CheckOutput {
  title: string;
  summary: string; // markdown, ≤ 65,535 chars
  annotations?: CheckAnnotation[]; // ≤ 50 per request; each update appends
}

export type CheckConclusion = "success" | "failure" | "neutral" | "skipped";

export interface CheckRunUpdate {
  status?: "in_progress" | "completed";
  conclusion?: CheckConclusion; // required with status "completed"
  output?: CheckOutput;
  detailsUrl?: string;
}

// [GH:API] Only the GitHub calls Diffwise makes, behind an interface.
// WHY: the publisher and the adapters depend on this, not on Octokit, so tests run against a
//      fake and Phase 4's App can swap the auth without touching the review logic.
export interface GitHubClient {
  getPullRequest(pr: PrRef): Promise<PullRequest>;
  listReviews(pr: PrRef): Promise<ExistingReview[]>;
  createReview(pr: PrRef, review: NewReview): Promise<{ id: number; url: string }>;
  updateReview(pr: PrRef, reviewId: number, body: string): Promise<void>; // the body only
  // Read-only calls for the App, which reviews through the API instead of a checkout.
  listPullRequestFiles(pr: PrRef): Promise<PullRequestFile[]>;
  // File text at a commit; undefined when the path doesn't exist there or isn't a file.
  getFileContent(repo: RepoRef, ref: string, path: string): Promise<string | undefined>;
  getTree(repo: RepoRef, sha: string): Promise<{ entries: TreeEntry[]; truncated: boolean }>;
  // Check runs: GitHub Apps only. The Action's verdict is its job result instead.
  createCheckRun(
    repo: RepoRef,
    check: { name: string; headSha: string } & CheckRunUpdate,
  ): Promise<{ id: number; url: string }>;
  updateCheckRun(repo: RepoRef, id: number, update: CheckRunUpdate): Promise<void>;
}

export type RepoRef = Pick<PrRef, "owner" | "repo">;
