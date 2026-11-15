import { Octokit } from "@octokit/rest";
import type {
  CheckOutput,
  CheckRunUpdate,
  ExistingReview,
  GitHubClient,
  NewReview,
  PrRef,
  PullRequest,
  PullRequestFile,
  RepoRef,
  TreeEntry,
} from "./client.js";

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
      // Octokit logs every failed request itself, including 404s we expect (a file that
      // doesn't exist). Errors are thrown to us and reported there, so its own copy is noise.
      log: { debug: () => {}, info: () => {}, warn: console.warn, error: () => {} },
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

  async listPullRequestFiles(pr: PrRef): Promise<PullRequestFile[]> {
    const files = await this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
      ...params(pr),
      per_page: 100,
    });
    return files.map((f) => ({
      filename: f.filename,
      ...(f.previous_filename ? { previousFilename: f.previous_filename } : {}),
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      ...(f.patch !== undefined ? { patch: f.patch } : {}),
    }));
  }

  async getFileContent(repo: RepoRef, ref: string, path: string): Promise<string | undefined> {
    try {
      // The raw media type returns the file's bytes (up to 100 MB); a directory still comes
      // back as a JSON listing, which isn't a string.
      const { data } = await this.octokit.rest.repos.getContent({
        owner: repo.owner,
        repo: repo.repo,
        path,
        ref,
        mediaType: { format: "raw" },
      });
      return typeof data === "string" ? data : undefined;
    } catch (err) {
      if ((err as { status?: number }).status === 404) return undefined;
      throw err;
    }
  }

  async getTree(repo: RepoRef, sha: string): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    const { data } = await this.octokit.rest.git.getTree({
      owner: repo.owner,
      repo: repo.repo,
      tree_sha: sha,
      recursive: "1",
    });
    const entries = data.tree.flatMap((e): TreeEntry[] =>
      e.path && isEntryType(e.type)
        ? [{ path: e.path, type: e.type, ...(e.size !== undefined ? { size: e.size } : {}) }]
        : [],
    );
    return { entries, truncated: data.truncated };
  }

  async createCheckRun(
    repo: RepoRef,
    check: { name: string; headSha: string } & CheckRunUpdate,
  ): Promise<{ id: number; url: string }> {
    const { data } = await this.octokit.rest.checks.create({
      owner: repo.owner,
      repo: repo.repo,
      name: check.name,
      head_sha: check.headSha,
      ...checkBody(check),
    });
    return { id: data.id, url: data.html_url ?? "" };
  }

  async updateCheckRun(repo: RepoRef, id: number, update: CheckRunUpdate): Promise<void> {
    await this.octokit.rest.checks.update({
      owner: repo.owner,
      repo: repo.repo,
      check_run_id: id,
      ...checkBody(update),
    });
  }
}

// Our camelCase check fields → the REST body. Timestamps are set here, from the status.
function checkBody(update: CheckRunUpdate) {
  const now = new Date().toISOString();
  return {
    ...(update.status ? { status: update.status } : {}),
    ...(update.status === "in_progress" ? { started_at: now } : {}),
    ...(update.conclusion ? { conclusion: update.conclusion, completed_at: now } : {}),
    ...(update.detailsUrl ? { details_url: update.detailsUrl } : {}),
    ...(update.output ? { output: outputBody(update.output) } : {}),
  };
}

const outputBody = (output: CheckOutput) => ({
  title: output.title,
  summary: output.summary,
  ...(output.annotations
    ? {
        annotations: output.annotations.map((a) => ({
          path: a.path,
          start_line: a.startLine,
          end_line: a.endLine,
          annotation_level: a.level,
          title: a.title,
          message: a.message,
        })),
      }
    : {}),
});

const isEntryType = (type: string | undefined): type is TreeEntry["type"] =>
  type === "blob" || type === "tree" || type === "commit";

const params = (pr: PrRef) => ({ owner: pr.owner, repo: pr.repo, pull_number: pr.number });
