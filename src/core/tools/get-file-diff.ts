import { z } from "zod";
import { commentableRanges, type Hunk } from "../diff.js";
import { defineTool, fail, ok } from "./types.js";
import { findChangedFile, notInDiffMessage, safeRepoPath, truncate } from "./util.js";

export const getFileDiff = defineTool({
  name: "get_file_diff",
  description: [
    "Show the changes to one file in this pull request, as diff hunks.",
    "Every line is prefixed with its line number in the NEW version of the file, then a marker:",
    "'+' added, ' ' unchanged context, '-' removed (removed lines have no new line number).",
    "The header lists the commentable line ranges: report_finding only accepts lines in them.",
    "Use read_file when you need more surrounding code than the hunks show.",
  ].join("\n"),
  input: z.object({
    path: z.string().describe("Repo-relative path exactly as shown by list_changed_files"),
  }),
  async run(ctx, args) {
    const safe = safeRepoPath(args.path);
    if (!safe.ok) return fail(safe.error);
    const file = findChangedFile(ctx, safe.path);
    if (!file) return fail(notInDiffMessage(ctx, safe.path));
    if (file.binary) return ok(`${file.path} is a binary file; there is no text diff to review.`);
    if (file.hunks.length === 0) {
      return ok(
        `${file.path} has no content changes (${file.status}, e.g. a mode change or empty file).`,
      );
    }

    const ranges = commentableRanges(file).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
    const from = file.oldPath ? ` from ${file.oldPath}` : "";
    const header = [
      `${file.path} (${file.status}${from}, +${file.additions} -${file.deletions})`,
      `Commentable lines: ${ranges.join(", ") || "none"}`,
    ];
    const body = file.hunks.map(renderHunk).join("\n");
    const { text, truncated } = truncate(
      `${header.join("\n")}\n\n${body}`,
      ctx.maxOutputChars,
      "use read_file with start_line/end_line to see a specific region",
    );
    return ok(text, truncated);
  },
});

// [HARNESS:CONTEXT] Print the new-side line number on every line instead of raw +/- patch text.
// WHY: models are unreliable at counting lines from a hunk header; printing the number makes
//      "report line 9" a copy, not arithmetic, and that is the number report_finding checks.
function renderHunk(hunk: Hunk): string {
  const width = String(hunk.newStart + hunk.newLines).length;
  const lines = hunk.lines.map((line) => {
    const num = line.kind === "del" ? "" : String(line.newLine);
    const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
    return `${num.padStart(width)} ${marker} ${line.content}`;
  });
  return [hunk.header, ...lines].join("\n");
}
