import type { FileDiff } from "./diff.js";

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
}

// Read-only view of the PR under review: local git now, the GitHub API in Phase 4.
// The engine and tools depend only on this, never on where the code actually lives.
export interface RepoSource {
  diff(): Promise<FileDiff[]>;
  // File contents at the head commit, or undefined if no such file exists there.
  readFile(path: string): Promise<string | undefined>;
  search(pattern: string, options?: { glob?: string; maxResults?: number }): Promise<SearchResult>;
}
