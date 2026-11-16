import { runInNewContext } from "node:vm";
import picomatch from "picomatch";
import { type FileDiff, type FileStatus, parseUnifiedDiff } from "../../core/diff.js";
import type { RepoSource, SearchMatch, SearchResult } from "../../core/repo-source.js";
import type { GitHubClient, PrRef, PullRequestFile } from "../github/client.js";

// search reads files one API call each, so it stops here; the result says when it did.
const SEARCH_MAX_FILES = 100;
const SEARCH_MAX_BYTES = 2 * 1024 * 1024;
const SEARCH_SKIP_FILE_BYTES = 512 * 1024; // lockfiles, bundles: noise, and slow to scan
const REGEX_TIMEOUT_MS = 1000;

const STATUS: Record<PullRequestFile["status"], FileStatus> = {
  added: "added",
  copied: "added", // a new file whose content came from another one
  removed: "deleted",
  renamed: "renamed",
  modified: "modified",
  changed: "modified", // mode change only
  unchanged: "modified",
};

// [GH:API] The App reads the PR through the API at a pinned head SHA: no clone, no checkout.
// WHY: the Action runs on a throwaway runner, so git on a checkout is cheap and isolated. The
//      App runs on our server, next to the private key and the API key: cloning puts untrusted
//      code there, and git can run code from a repo (hooks, filters, config). Over the API we
//      only ever receive text; nothing from the PR is executed.
export class GitHubApiSource implements RepoSource {
  private readonly cache = new Map<string, Promise<string | undefined>>();
  private files: Promise<FileDiff[]> | undefined;

  constructor(
    private readonly github: GitHubClient,
    private readonly pr: PrRef,
    readonly headSha: string, // every read uses this commit, so a push mid-review changes nothing
  ) {}

  diff(): Promise<FileDiff[]> {
    this.files ??= this.github.listPullRequestFiles(this.pr).then((files) => files.map(toFileDiff));
    return this.files;
  }

  readFile(path: string): Promise<string | undefined> {
    let text = this.cache.get(path);
    if (!text) {
      text = this.github.getFileContent(this.pr, this.headSha, path);
      this.cache.set(path, text);
      text.catch(() => this.cache.delete(path)); // a failed read is retried, not remembered
    }
    return text;
  }

  // git grep isn't available over the API, so: list the tree, pick files (changed ones first),
  // read them, and match line by line. Partial results are marked truncated.
  async search(
    pattern: string,
    options: { glob?: string; maxResults?: number } = {},
  ): Promise<SearchResult> {
    const max = options.maxResults ?? 50;
    const matchesGlob = options.glob ? picomatch(options.glob, { dot: true }) : () => true;
    const [tree, changed] = await Promise.all([
      this.github.getTree(this.pr, this.headSha),
      this.diff(),
    ]);
    const blobs = new Map(
      tree.entries
        .filter((e) => e.type === "blob" && matchesGlob(e.path))
        .map((e) => [e.path, e.size ?? 0]),
    );
    const changedPaths = changed.map((f) => f.path).filter((p) => blobs.has(p));
    const rest = [...blobs.keys()].filter((p) => !changedPaths.includes(p)).sort();

    const files: { path: string; text: string }[] = [];
    let bytes = 0;
    let skipped = tree.truncated;
    for (const path of [...changedPaths, ...rest]) {
      const size = blobs.get(path) ?? 0;
      if (size > SEARCH_SKIP_FILE_BYTES) continue;
      if (files.length >= SEARCH_MAX_FILES || bytes + size > SEARCH_MAX_BYTES) {
        skipped = true;
        break;
      }
      const text = await this.readFile(path);
      if (text === undefined || text.includes("\0")) continue; // gone, or binary
      files.push({ path, text });
      bytes += size;
    }

    const { matches, more } = grep(pattern, files, max);
    return { matches, truncated: more || skipped };
  }
}

function toFileDiff(file: PullRequestFile): FileDiff {
  // GitHub sends each file's hunks without git's headers; a minimal header lets the same
  // parser the Action uses read them. Status and paths come from the API, not the header.
  const parsed = file.patch
    ? parseUnifiedDiff(`diff --git a/${file.filename} b/${file.filename}\n${file.patch}`)[0]
    : undefined;
  const status = STATUS[file.status];
  return {
    path: file.filename,
    ...(status === "renamed" && file.previousFilename ? { oldPath: file.previousFilename } : {}),
    status,
    // No patch: binary, or too large for GitHub to diff; either way nothing is commentable.
    // A pure rename (or mode change) has no patch either, and isn't binary.
    binary: file.patch === undefined && file.status !== "renamed" && file.status !== "changed",
    additions: file.additions,
    deletions: file.deletions,
    hunks: parsed?.hunks ?? [],
  };
}

// [HARNESS:GUARD] The model's regex runs in a VM context with a 1-second timeout.
// WHY: git grep's engine can't backtrack, but JavaScript's can: a pattern like (a+)+$ on a long
//      line takes exponential time and would freeze the whole server, every queued review with
//      it. The pattern comes from the model, which may be following an injected instruction.
function grep(
  pattern: string,
  files: { path: string; text: string }[],
  max: number,
): { matches: SearchMatch[]; more: boolean } {
  const code = `
    const re = new RegExp(pattern);
    const matches = [];
    let more = false;
    outer: for (const f of files) {
      const lines = f.text.split("\\n");
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        if (matches.length === max) { more = true; break outer; }
        matches.push({ path: f.path, line: i + 1, text: lines[i] });
      }
    }
    JSON.stringify({ matches, more });
  `;
  try {
    const out = runInNewContext(code, { pattern, files, max }, { timeout: REGEX_TIMEOUT_MS });
    return JSON.parse(out as string);
  } catch (err) {
    const e = err as { code?: string; name?: string; message?: string };
    if (e.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new Error(
        `the pattern took over ${REGEX_TIMEOUT_MS} ms (nested quantifiers like (a+)+ backtrack); simplify it`,
      );
    }
    if (e.name === "SyntaxError") throw new Error(`invalid regex: ${e.message}`);
    throw err;
  }
}
