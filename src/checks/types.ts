import type { FileDiff } from "../core/diff.js";
import type { RepoSource } from "../core/repo-source.js";
import type { DeterministicCheck } from "../core/rules.js";

// What a check reports. No rule id or severity: the runner adds both from the rules file, so a
// check can't decide how serious its own finding is (same principle as the model).
export interface CheckHit {
  path: string;
  line: number; // an added line, so always commentable
  message: string;
  suggestion?: string;
}

export interface CheckInput {
  files: readonly FileDiff[]; // only the files the rule's applies_to matches
  source: RepoSource; // reads at the head SHA, e.g. .env.example
}

export interface Check {
  name: DeterministicCheck;
  run(input: CheckInput): Promise<CheckHit[]>;
}

export interface AddedLine {
  path: string;
  line: number;
  content: string;
}

// Checks look at added lines only: code that already existed isn't this PR's doing.
export function* addedLines(files: readonly FileDiff[]): Generator<AddedLine> {
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const l of hunk.lines) {
        if (l.kind === "add") yield { path: file.path, line: l.newLine, content: l.content };
      }
    }
  }
}
