import picomatch from "picomatch";
import { type FileDiff, parseUnifiedDiff } from "../../src/core/diff.js";
import type { RepoSource, SearchMatch, SearchResult } from "../../src/core/repo-source.js";

// In-memory RepoSource: head-commit files plus a unified diff, no git process involved.
export class FakeRepoSource implements RepoSource {
  readonly files: Record<string, string>;
  private readonly diffText: string;

  constructor(options: { files?: Record<string, string>; diff?: string } = {}) {
    this.files = options.files ?? {};
    this.diffText = options.diff ?? "";
  }

  async diff(): Promise<FileDiff[]> {
    return parseUnifiedDiff(this.diffText);
  }

  async readFile(path: string): Promise<string | undefined> {
    return this.files[path];
  }

  // JS regex instead of git's POSIX ERE: close enough for tests. An invalid pattern throws,
  // like git exits non-zero.
  async search(
    pattern: string,
    options: { glob?: string; maxResults?: number } = {},
  ): Promise<SearchResult> {
    const regex = new RegExp(pattern);
    const inGlob = options.glob ? picomatch(options.glob, { dot: true }) : () => true;
    const max = options.maxResults ?? 100;
    const matches: SearchMatch[] = [];
    for (const [path, content] of Object.entries(this.files).sort()) {
      if (!inGlob(path)) continue;
      for (const [i, text] of content.split("\n").entries()) {
        if (regex.test(text)) matches.push({ path, line: i + 1, text });
      }
    }
    return { matches: matches.slice(0, max), truncated: matches.length > max };
  }
}
