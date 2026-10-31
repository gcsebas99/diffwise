import { z } from "zod";
import type { SearchResult } from "../repo-source.js";
import { defineTool, fail, ok } from "./types.js";
import { safeRepoPath } from "./util.js";

const MAX_RESULTS = 30;
const MAX_LINE_CHARS = 200; // one minified line shouldn't eat the whole output budget

export const searchRepo = defineTool({
  name: "search_repo",
  description: [
    "Search the whole repository (head commit) for a regular expression, like `git grep -E`.",
    "Use it to answer questions the diff can't, e.g. 'is this function tested anywhere?' or",
    "'where else is this env var read?'. Returns up to 30 matches as path:line: text.",
    "'No matches' is a real answer, not an error.",
    "The pattern is a POSIX extended regex: escape ( ) [ ] { } . * + ? | with a backslash to match them literally.",
  ].join("\n"),
  input: z.object({
    pattern: z
      .string()
      .min(1)
      .describe("Extended regex, e.g. registerOrderRoutes or process\\.env\\.[A-Z_]+"),
    glob: z.string().optional().describe("Limit to matching paths, e.g. test/** or **/*.ts"),
  }),
  async run(ctx, args) {
    let glob: string | undefined;
    if (args.glob !== undefined) {
      const safe = safeRepoPath(args.glob);
      if (!safe.ok) return fail(safe.error);
      glob = safe.path;
    }

    let result: SearchResult;
    try {
      result = await ctx.source.search(args.pattern, { glob, maxResults: MAX_RESULTS });
    } catch (err) {
      // git's stderr ("parentheses not balanced") is the useful part; the full error message
      // also repeats the whole command line, including the local repo path.
      const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim();
      const reason = stderr || (err instanceof Error ? err.message : String(err));
      return fail(
        `search failed: ${reason}\nCheck the regex: escape special characters with a backslash.`,
      );
    }

    const where = glob ? ` in ${glob}` : "";
    if (result.matches.length === 0) return ok(`No matches for /${args.pattern}/${where}.`);
    const lines = result.matches.map(
      (m) => `${m.path}:${m.line}: ${m.text.trim().slice(0, MAX_LINE_CHARS)}`,
    );
    const header = result.truncated
      ? `First ${result.matches.length} matches for /${args.pattern}/${where} (more exist; add a glob or a more specific pattern):`
      : `${result.matches.length} matches for /${args.pattern}/${where}:`;
    return ok(`${header}\n${lines.join("\n")}`, result.truncated);
  },
});
