import { z } from "zod";
import type { FileDiff } from "../diff.js";
import { defineTool, ok } from "./types.js";
import { llmRulesFor } from "./util.js";

const STATUS_CODE = { added: "A", modified: "M", deleted: "D", renamed: "R" } as const;

export const listChangedFiles = defineTool({
  name: "list_changed_files",
  // [HARNESS:TOOLS] A tool description is a prompt: when to call it, what the output means.
  // WHY: the model knows nothing beyond name + description + schema. "Call this first" and
  //      "a file with no rules needs no findings" steer behavior more than any system prompt line.
  // INTERVIEW: "How do you get an agent to use tools well?" → write descriptions like docs for a
  //            new teammate, name the next tool to use, explain every symbol in the output.
  description: [
    "List every file changed in this pull request. Call this first.",
    "Each line shows: status (A added, M modified, D deleted, R renamed), path, line counts,",
    "and the ids of the review rules that apply to that file.",
    "Focus on files that have rules; a file with no rules needs no findings.",
    "Takes no arguments.",
  ].join("\n"),
  input: z.object({}),
  async run(ctx) {
    if (ctx.files.length === 0) return ok("No files changed.");
    const lines = ctx.files.map((file) => {
      const rules = llmRulesFor(ctx, file.path).map((rule) => rule.id);
      const status = STATUS_CODE[file.status];
      return `${status} ${describePath(file)} ${counts(file)}  rules: ${rules.join(", ") || "none"}`;
    });
    return ok(`${ctx.files.length} files changed:\n${lines.join("\n")}`);
  },
});

function describePath(file: FileDiff): string {
  return file.oldPath ? `${file.path} (renamed from ${file.oldPath})` : file.path;
}

function counts(file: FileDiff): string {
  if (file.binary) return "[binary]";
  if (file.status === "deleted") return `(-${file.deletions}) [deleted: no lines to comment on]`;
  return `(+${file.additions} -${file.deletions})`;
}
