import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type FileDiff, parseUnifiedDiff } from "./diff.js";
import type { RepoSource, SearchMatch, SearchResult } from "./repo-source.js";

const execFileAsync = promisify(execFile);

export class LocalGitSource implements RepoSource {
  private readonly repo: string;
  readonly baseSha: string;
  readonly headSha: string;

  private constructor(repo: string, baseSha: string, headSha: string) {
    this.repo = repo;
    this.baseSha = baseSha;
    this.headSha = headSha;
  }

  // Refs are resolved to SHAs once, so the whole review reads one fixed commit and no later
  // argument can start with "-". `--end-of-options` stops a ref like "--output=x" being a flag.
  static async open(repo: string, base: string, head: string): Promise<LocalGitSource> {
    const resolve = async (ref: string) => {
      try {
        const args = ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`];
        return (await git(repo, args)).trim();
      } catch {
        throw new Error(`'${ref}' is not a commit in ${repo}`);
      }
    };
    return new LocalGitSource(repo, await resolve(base), await resolve(head));
  }

  async diff(): Promise<FileDiff[]> {
    // Every flag pins the output format, so the user's git config can't break the parser.
    // Three dots: diff against the merge base, which is what GitHub's "Files changed" shows.
    const out = await git(this.repo, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--find-renames",
      "--unified=3",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      `${this.baseSha}...${this.headSha}`,
    ]);
    return parseUnifiedDiff(out);
  }

  async readFile(path: string): Promise<string | undefined> {
    const spec = `${this.headSha}:${path}`;
    // The repo and SHA were verified in open(), so a failure here means "no such path at head".
    const type = await git(this.repo, ["cat-file", "-t", spec]).catch(() => undefined);
    if (type?.trim() !== "blob") return undefined; // missing, or a directory
    return git(this.repo, ["cat-file", "blob", spec]);
  }

  async search(
    pattern: string,
    options: { glob?: string; maxResults?: number } = {},
  ): Promise<SearchResult> {
    const max = options.maxResults ?? 50;
    const pathspec = options.glob ? [`:(glob)${options.glob}`] : [];
    let out: string;
    try {
      // -z separates path/line/text with NUL (paths may contain ":"), -I skips binaries,
      // -e marks the pattern as a pattern even if it starts with "-".
      // max + 1 per file: if git stopped at exactly `max` in one file, we couldn't tell
      // whether more matches existed, and `truncated` would wrongly be false.
      const args = ["grep", "-z", "-n", "-I", "--no-color", "-E", `--max-count=${max + 1}`];
      out = await git(this.repo, [...args, "-e", pattern, this.headSha, "--", ...pathspec]);
    } catch (err) {
      if ((err as { code?: unknown }).code === 1) return { matches: [], truncated: false };
      throw err; // exit 128: e.g. an invalid regex. The tool layer turns it into a model error.
    }
    const prefix = `${this.headSha}:`;
    const matches: SearchMatch[] = [];
    for (const row of out.split("\n")) {
      if (!row) continue;
      const [file = "", line = "", ...text] = row.split("\0");
      matches.push({ path: file.slice(prefix.length), line: Number(line), text: text.join("\0") });
    }
    return { matches: matches.slice(0, max), truncated: matches.length > max };
  }
}

// [HARNESS:GUARD] git runs via execFile with an argument array, never a shell string.
// WHY: patterns, paths and refs come from the model or the PR; in a shell string, a value like
//      "x; rm -rf ~" or "$(curl …)" would execute. As an array element it's just text.
// INTERVIEW: "How do you run tools on untrusted input?" → no shell, `--`/-e/--end-of-options
//            separators, timeouts and output caps, read-only commands only.
async function git(repo: string, args: string[]): Promise<string> {
  const fullArgs = ["-C", repo, "-c", "core.quotePath=false", ...args];
  const { stdout } = await execFileAsync("git", fullArgs, {
    maxBuffer: 20 * 1024 * 1024,
    timeout: 30_000,
  });
  return stdout;
}
