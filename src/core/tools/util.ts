import type { FileDiff } from "../diff.js";
import { type Rule, rulesForFile } from "../rules.js";
import type { ToolContext } from "./types.js";

// [HARNESS:CONTEXT] Truncate tool output at a line boundary and say how to get the rest.
// WHY: one huge file or search can fill the context window and push out the task itself; a hint
//      ("…[312 more lines; narrow the range]") turns the cut into a next step, not a dead end.
export function truncate(
  text: string,
  maxChars: number,
  hint: string,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  // Leave room for the hint line itself ("\n…[NNN more lines; <hint>]").
  const budget = Math.max(0, maxChars - hint.length - 40);
  const cut = text.lastIndexOf("\n", budget);
  const kept = text.slice(0, cut > 0 ? cut : budget);
  const remaining = text.slice(kept.length).split("\n").filter(Boolean).length;
  return { text: `${kept}\n…[${remaining} more lines; ${hint}]`, truncated: true };
}

export type SafePath = { ok: true; path: string } | { ok: false; error: string };

// [HARNESS:GUARD] Tool paths must be repo-relative: no absolute paths, no ".." segments.
// WHY: paths come from the model, which can be steered by PR content ("read ../../.ssh/id_rsa").
//      LocalGitSource reads git objects only, but the check belongs at the tool boundary so a
//      future source (e.g. a plain filesystem) can't be tricked either.
export function safeRepoPath(input: string): SafePath {
  const path = input.trim().replace(/^(\.\/)+/, "");
  if (path === "")
    return { ok: false, error: "path is empty; use a repo-relative path like src/app.ts" };
  if (path.includes("\0")) return { ok: false, error: "path contains a NUL byte" };
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\\")) {
    return {
      ok: false,
      error: `'${input}' is not repo-relative; use forward slashes from the repo root, like src/app.ts`,
    };
  }
  if (path.split("/").includes("..")) {
    return {
      ok: false,
      error: `'${input}' contains '..'; only files inside the repository can be read`,
    };
  }
  return { ok: true, path };
}

// Only LLM rules are the model's job; deterministic ones run as code (Phase 3).
export function llmRulesFor(ctx: ToolContext, path: string): Rule[] {
  return rulesForFile(ctx.rules, path).filter((rule) => rule.check.kind === "llm");
}

export function findChangedFile(ctx: ToolContext, path: string): FileDiff | undefined {
  return ctx.files.find((file) => file.path === path);
}

export function notInDiffMessage(ctx: ToolContext, path: string): string {
  const paths = ctx.files.slice(0, 20).map((file) => file.path);
  const more =
    ctx.files.length > paths.length ? ` (and ${ctx.files.length - paths.length} more)` : "";
  return `'${path}' is not changed in this PR. Changed files: ${paths.join(", ")}${more}. Call list_changed_files for details.`;
}
