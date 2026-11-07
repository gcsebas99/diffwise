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

// [GH:API] Only the four GitHub calls Diffwise makes, behind an interface.
// WHY: the publisher and the adapters depend on this, not on Octokit, so tests run against a
//      fake and Phase 4's App can swap the auth without touching the review logic.
export interface GitHubClient {
  getPullRequest(pr: PrRef): Promise<PullRequest>;
  listReviews(pr: PrRef): Promise<ExistingReview[]>;
  createReview(pr: PrRef, review: NewReview): Promise<{ id: number; url: string }>;
  updateReview(pr: PrRef, reviewId: number, body: string): Promise<void>; // the body only
}
