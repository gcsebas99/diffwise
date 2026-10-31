import { z } from "zod";
import { defineTool, fail, ok } from "./types.js";
import { safeRepoPath, truncate } from "./util.js";

export const readFile = defineTool({
  name: "read_file",
  description: [
    "Read a file as it is in this pull request's head commit, with line numbers.",
    "Use it for context the diff hunks don't show: the rest of a function, imports, a related test.",
    "Works for any file in the repository, changed or not.",
    "Pass start_line/end_line to read a range; long output is cut and tells you how to continue.",
  ].join("\n"),
  input: z.object({
    path: z.string().describe("Repo-relative path, e.g. src/routes/orders.ts"),
    start_line: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("First line to show (1-based). Default 1."),
    end_line: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Last line to show, inclusive. Default: end of file."),
  }),
  async run(ctx, args) {
    const safe = safeRepoPath(args.path);
    if (!safe.ok) return fail(safe.error);
    const content = await ctx.source.readFile(safe.path);
    if (content === undefined) {
      return fail(
        `No file '${safe.path}' in the head commit (deleted, a directory, or misspelled). Use search_repo or list_changed_files to find the right path.`,
      );
    }
    if (content.includes("\0"))
      return ok(`${safe.path} is a binary file; it can't be shown as text.`);
    if (content === "") return ok(`${safe.path} is empty.`);

    // A trailing newline ends the last line; it doesn't start an extra empty one.
    const lines = (content.endsWith("\n") ? content.slice(0, -1) : content).split("\n");
    const total = lines.length;
    const start = args.start_line ?? 1;
    const end = Math.min(args.end_line ?? total, total);
    if (start > total)
      return fail(`start_line ${start} is past the end; ${safe.path} has ${total} lines.`);
    if (end < start) return fail(`end_line ${end} is before start_line ${start}.`);

    const width = String(end).length;
    const numbered = lines
      .slice(start - 1, end)
      .map((text, i) => `${String(start + i).padStart(width)}  ${text}`);
    const { text, truncated } = truncate(
      `${safe.path} (lines ${start}-${end} of ${total})\n${numbered.join("\n")}`,
      ctx.maxOutputChars,
      "narrow the range with start_line/end_line",
    );
    return ok(text, truncated);
  },
});
