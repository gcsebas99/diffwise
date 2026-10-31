import { z } from "zod";
import { commentableRanges, isCommentable } from "../diff.js";
import type { Finding } from "../review.js";
import { defineTool, fail, ok } from "./types.js";
import { findChangedFile, llmRulesFor, notInDiffMessage, safeRepoPath } from "./util.js";

const formatRanges = (ranges: [number, number][]) =>
  ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");

export const reportFinding = defineTool({
  name: "report_finding",
  description: [
    "Record one rule violation, anchored to a line of the pull request diff.",
    "rule_id must be a rule that applies to the file (see list_changed_files).",
    "line must be a commentable line in the NEW version of the file (see get_file_diff's header).",
    "Report each problem once, on the most relevant changed line.",
    "If a problem has no line in the diff (e.g. a missing test file), anchor it to the changed line",
    "that causes it; if there is none, explain it in submit_review's summary instead.",
    "Errors explain what to fix; correct the arguments and call again.",
  ].join("\n"),
  // No severity argument: it comes from the rule, so the model can't downgrade a finding.
  input: z.object({
    rule_id: z.string().describe("Id of the violated rule, e.g. route-needs-test"),
    path: z.string().describe("Repo-relative path of a changed file"),
    line: z.number().int().positive().describe("Line number in the new version of the file"),
    message: z
      .string()
      .min(1)
      .describe("What is wrong and why it violates the rule, in 1-3 sentences"),
    suggestion: z.string().optional().describe("Optional concrete fix"),
  }),
  //   rule, rule applies to the path, file is in the diff, line is commentable, not a duplicate.
  // WHY: an invalid line makes GitHub reject the whole review (422); a wrong rule or path is a
  //      hallucination. Each check fails with the valid options so the model can fix it.
  // INTERVIEW: "How do you keep agent output valid?" → validate structured actions against
  //            ground truth (rules file, diff model) at the tool, not after the fact.
  async run(ctx, args) {
    const llmIds = ctx.rules.rules.filter((r) => r.check.kind === "llm").map((r) => r.id);
    const rule = ctx.rules.rules.find((r) => r.id === args.rule_id);
    if (!rule)
      return fail(`Unknown rule_id '${args.rule_id}'. Valid rule ids: ${llmIds.join(", ")}.`);
    if (rule.check.kind !== "llm") {
      return fail(
        `Rule '${rule.id}' is checked automatically by code; don't report it. Report only: ${llmIds.join(", ")}.`,
      );
    }

    const safe = safeRepoPath(args.path);
    if (!safe.ok) return fail(safe.error);
    const file = findChangedFile(ctx, safe.path);
    if (!file) return fail(notInDiffMessage(ctx, safe.path));

    const applicable = llmRulesFor(ctx, file.path);
    if (!applicable.some((r) => r.id === rule.id)) {
      const others = applicable.map((r) => r.id).join(", ") || "none";
      return fail(
        `Rule '${rule.id}' doesn't apply to ${file.path} (it covers ${rule.applies_to.join(", ")}). Rules for this file: ${others}.`,
      );
    }

    if (!isCommentable(file, args.line)) {
      const ranges = commentableRanges(file);
      return fail(
        ranges.length > 0
          ? `Line ${args.line} of ${file.path} is not in the diff. Commentable lines: ${formatRanges(ranges)}. Pick the changed line closest to the problem.`
          : `${file.path} has no commentable lines (${file.binary ? "binary" : file.status}). Mention this problem in submit_review's summary instead.`,
      );
    }

    const duplicate = ctx.state.findings.some(
      (f) => f.ruleId === rule.id && f.path === file.path && f.line === args.line,
    );
    if (duplicate) {
      return fail(
        `Already reported ${rule.id} at ${file.path}:${args.line}. Don't report it again; move on.`,
      );
    }

    const finding: Finding = {
      ruleId: rule.id,
      severity: rule.severity,
      path: file.path,
      line: args.line,
      message: args.message,
      ...(args.suggestion ? { suggestion: args.suggestion } : {}),
    };
    ctx.state.findings.push(finding);
    return ok(
      `Recorded finding #${ctx.state.findings.length}: ${rule.id} (${rule.severity}) at ${file.path}:${args.line}.`,
    );
  },
});
