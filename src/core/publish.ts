import type { GitHubClient, PrRef, ReviewComment } from "../adapters/github/client.js";
import { totalInputTokens } from "../model/types.js";
import type { ModelSkipped } from "./engine.js";
import type { ReviewRun } from "./loop.js";
import type { Finding } from "./review.js";
import type { VerdictResult } from "./verdict.js";

// Hidden in every summary we post, so a re-run can find the previous Diffwise review.
export const MARKER = "<!-- diffwise -->";
// Replaces MARKER once a review is superseded, so later runs don't edit it again.
export const OUTDATED_MARKER = "<!-- diffwise:outdated -->";

export interface PublishInput {
  run: ReviewRun;
  verdict: VerdictResult;
  model: string;
  cost: number | undefined;
  modelSkipped?: ModelSkipped; // only the deterministic checks ran
}

// [HARNESS:GUARD] Model text is untrusted in markdown too: it can quote the PR it reviewed.
// WHY: an "@team" in a finding would make the bot ping people, and raw HTML could hide text or
//      fake a second summary. A zero-width space breaks mentions; "<" is shown, not parsed.
// INTERVIEW: "Is the agent's output safe to post?" → treat it like user input at every sink:
//            escape for where it lands (markdown, table cells, logs), not just at the prompt.
export function sanitize(text: string): string {
  return text.replaceAll("<", "&lt;").replace(/@(?=[\w-])/g, "@\u200b");
}

// A table cell ends at a newline or "|", so both must go.
const cell = (text: string) => sanitize(text).replace(/\r?\n/g, " ").replaceAll("|", "\\|");

const ICON = { blocking: "🔴", advisory: "🟡" } as const;
const HEADLINE = { pass: "✅ PASS", fail: "❌ FAIL", neutral: "⚠️ NEUTRAL" } as const;
const num = (n: number) => n.toLocaleString("en-US");

export function formatComment(finding: Finding): string {
  const lines = [`**${ICON[finding.severity]} ${finding.severity} · \`${finding.ruleId}\`**`];
  lines.push("", sanitize(finding.message));
  if (finding.suggestion) lines.push("", `**Suggestion:** ${sanitize(finding.suggestion)}`);
  return lines.join("\n");
}

// A checks-only pass must say what wasn't checked, or it reads as "the model found nothing".
const SKIPPED_NOTE: Record<ModelSkipped, string> = {
  "deterministic-only":
    "Only the automated checks ran. LLM rules were **not checked**: add the `live-review` label to run them.",
  "no-llm-rules":
    "Only the automated checks ran: no changed file has a rule for the model to check.",
};

export function formatSummary(input: PublishInput): string {
  const { run, verdict, model, cost, modelSkipped } = input;
  const { blocking, advisory } = verdict.counts;
  const lines = [MARKER, `## Diffwise: ${HEADLINE[verdict.verdict]}`, ""];
  lines.push(`**${blocking} blocking**, ${advisory} advisory`);
  if (modelSkipped) lines.push("", "> [!NOTE]", `> ${SKIPPED_NOTE[modelSkipped]}`);

  if (!run.complete) {
    lines.push(
      "",
      `> [!WARNING]`,
      `> The review did not finish (\`${run.outcome}\`). Findings below are what it found before`,
      "> it stopped; no findings does not mean the PR is clean.",
    );
  }

  if (run.findings.length > 0) {
    lines.push("", "| | Rule | Location | Finding |", "|---|---|---|---|");
    for (const f of run.findings) {
      const where = `\`${cell(f.path)}:${f.line}\``;
      lines.push(`| ${ICON[f.severity]} | \`${f.ruleId}\` | ${where} | ${cell(f.message)} |`);
    }
  }

  if (!modelSkipped) {
    lines.push("", "### Summary", "", run.summary ? sanitize(run.summary) : "_No summary._");
  }

  // [HARNESS:OBS] Every review states how it was produced: model, prompt version, effort, cost.
  // WHY: when a reviewer asks "why did it say that?", the footer says which model and prompt
  //      to replay, and a cost jump after a prompt change is visible on the PR itself.
  if (modelSkipped) {
    lines.push("", "<sub>automated checks only · no model call · $0</sub>");
    return lines.join("\n");
  }
  const usage = run.usage;
  const stats = [
    model,
    `prompt \`${run.promptVersion}\``,
    `${run.steps} steps`,
    `${num(totalInputTokens(usage))} in / ${num(usage.outputTokens)} out tokens`,
    cost === undefined ? "cost unknown" : `est. $${cost.toFixed(4)}`,
  ];
  lines.push("", `<sub>${stats.join(" · ")}</sub>`);
  return lines.join("\n");
}

export interface PublishResult {
  reviewId: number;
  url: string;
  warnings: string[]; // problems that didn't stop the publish, for the adapter to log
}

// Ours = our marker AND a bot author: anyone can paste the marker into their own review.
const isPreviousDiffwiseReview = (review: { body: string; authorType: string | undefined }) =>
  review.authorType === "Bot" && review.body.includes(MARKER);

const outdatedBody = (latestUrl: string) =>
  [
    OUTDATED_MARKER,
    "**Outdated Diffwise review.** The PR changed after this review; see the",
    `[latest review](${latestUrl}). Inline comments below may point at old code.`,
  ].join("\n");

// [GH:API] One current review per PR: post the new review, then mark earlier ones outdated.
// WHY: a full review on every push buries the current one, and GitHub can't delete a submitted
//      review, so we rewrite the old body. New first: if posting fails, the old review still
//      stands instead of being marked outdated with nothing to replace it.
// INTERVIEW: "What happens on a new push?" → one new review pinned to the new head SHA; the
//            old one is edited to point at it; the check result is recomputed for the new SHA.
export async function publishReview(
  client: GitHubClient,
  pr: PrRef,
  input: PublishInput & { commitId: string },
): Promise<PublishResult> {
  // Listed before posting, so the new review can't be mistaken for an old one.
  const previous = (await client.listReviews(pr)).filter(isPreviousDiffwiseReview);

  const comments: ReviewComment[] = input.run.findings.map((finding) => ({
    path: finding.path,
    line: finding.line,
    side: "RIGHT",
    body: formatComment(finding),
  }));
  const created = await client.createReview(pr, {
    commitId: input.commitId,
    event: "COMMENT",
    body: formatSummary(input),
    comments,
  });

  const warnings: string[] = [];
  for (const review of previous) {
    try {
      await client.updateReview(pr, review.id, outdatedBody(created.url));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warnings.push(`could not mark review ${review.id} as outdated: ${reason}`);
    }
  }
  return { reviewId: created.id, url: created.url, warnings };
}
