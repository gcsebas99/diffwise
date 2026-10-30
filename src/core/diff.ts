// [HARNESS:CONTEXT] Structured diff model: files → hunks → lines with new-side line numbers.
// WHY: the agent gets numbered, per-file hunks through tools instead of one raw patch, so it
//      can cite exact lines and pull only the files it needs.
// INTERVIEW: "Why not paste the diff?" → token cost, attention dilution, and the model can't
//            reliably count lines in raw patch text; structured data can be validated.
export type DiffLine =
  | { kind: "add"; content: string; newLine: number; commentable: true }
  | { kind: "context"; content: string; oldLine: number; newLine: number; commentable: true }
  // [HARNESS:GUARD] Only new-side lines (added or context, inside a hunk) are commentable.
  // WHY: findings are published as GitHub review comments with side=RIGHT; a line outside the
  //      diff gets a 422, and one bad comment fails the whole review request.
  // INTERVIEW: "How do you stop comments GitHub will reject?" → validate line against the
  //            diff model in report_finding, before anything reaches the API.
  | { kind: "del"; content: string; oldLine: number; commentable: false };

export interface Hunk {
  header: string; // "@@ -10,7 +11,8 @@ function name", kept for display to the model
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileDiff {
  path: string; // new path; for deleted files, the path that was removed
  oldPath?: string; // set only when status is "renamed"
  status: FileStatus;
  binary: boolean; // binary files have no hunks, so nothing in them is commentable
  additions: number;
  deletions: number;
  hunks: Hunk[];
}

export function isCommentable(file: FileDiff, line: number): boolean {
  return file.hunks.some((hunk) => hunk.lines.some((l) => l.commentable && l.newLine === line));
}

// Contiguous commentable new-side ranges, e.g. [[1, 4], [21, 22]]. report_finding (1.5) puts
// these in its error so the model can pick a valid line instead of guessing again.
export function commentableRanges(file: FileDiff): [start: number, end: number][] {
  const ranges: [number, number][] = [];
  for (const hunk of file.hunks) {
    for (const l of hunk.lines) {
      if (!l.commentable) continue;
      const last = ranges.at(-1);
      if (last && last[1] === l.newLine - 1) last[1] = l.newLine;
      else ranges.push([l.newLine, l.newLine]);
    }
  }
  return ranges;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// "diff --git a/<path> b/<path>": without a rename both paths are identical, so the split point
// is the exact middle, which also works for paths with spaces. Renames are overwritten below.
// We don't read "---"/"+++" lines: git appends a tab to them when the path has a space.
function pathFromGitHeader(line: string): string {
  const rest = line.slice("diff --git ".length);
  const length = (rest.length - " a/ b/".length + 1) / 2;
  return rest.slice("a/".length, "a/".length + length);
}

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let hunk: Hunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = {
        path: pathFromGitHeader(line),
        status: "modified",
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;

    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      // A missing count means 1: "@@ -1 +1 @@" is a one-line hunk.
      hunk = {
        header: line,
        oldStart: oldLine,
        oldLines: Number(header[2] ?? 1),
        newStart: newLine,
        newLines: Number(header[4] ?? 1),
        lines: [],
      };
      file.hunks.push(hunk);
      continue;
    }

    // Before a file's first "@@" every line is header. The early `continue` also skips the
    // "--- a/x" / "+++ b/x" lines, which would otherwise look like a deletion and an addition.
    if (!hunk) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) {
        file.status = "renamed";
        file.oldPath = line.slice("rename from ".length);
      } else if (line.startsWith("rename to ")) file.path = line.slice("rename to ".length);
      else if (line.startsWith("Binary files ")) file.binary = true;
      continue;
    }

    // Inside a hunk the first character says which side(s) the line belongs to. Anything else
    // ("\ No newline at end of file", the final empty line) is metadata and is skipped.
    const content = line.slice(1);
    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", content, newLine: newLine++, commentable: true });
      file.additions++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", content, oldLine: oldLine++, commentable: false });
      file.deletions++;
    } else if (line.startsWith(" ")) {
      const both = { oldLine: oldLine++, newLine: newLine++ };
      hunk.lines.push({ kind: "context", content, ...both, commentable: true });
    }
  }
  return files;
}
