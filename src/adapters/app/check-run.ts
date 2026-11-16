import { formatSummary, MARKER, type PublishInput, sanitize } from "../../core/publish.js";
import type { Finding } from "../../core/review.js";
import type { CheckAnnotation, CheckConclusion, CheckOutput } from "../github/client.js";

export const CHECK_NAME = "Diffwise";
export const ANNOTATIONS_PER_REQUEST = 50; // GitHub's limit; later batches are appended
const MAX_SUMMARY = 65_535;
const MAX_TITLE = 255;

const CONCLUSION: Record<PublishInput["verdict"]["verdict"], CheckConclusion> = {
  pass: "success",
  fail: "failure",
  neutral: "neutral", // the review didn't finish: neither a pass nor a fail
};

export interface CompletedCheck {
  conclusion: CheckConclusion;
  output: CheckOutput; // the first annotation batch
  moreAnnotations: CheckAnnotation[][]; // the rest, one update each
}

// [GH:API] The verdict as a check run: the conclusion is what branch protection reads.
// WHY: a review comment can't block a merge; a required check can, and it's recomputed per
//      commit. Annotations put each finding on its line in "Files changed", 50 per request.
export function completedCheck(input: PublishInput): CompletedCheck {
  const { blocking, advisory } = input.verdict.counts;
  const title =
    input.verdict.verdict === "neutral"
      ? "Review incomplete"
      : blocking > 0
        ? `${blocking} blocking finding${blocking === 1 ? "" : "s"}`
        : `No blocking findings${advisory ? ` (${advisory} advisory)` : ""}`;
  const annotations = input.run.findings.map(toAnnotation);
  const [first = [], ...rest] = batches(annotations, ANNOTATIONS_PER_REQUEST);
  return {
    conclusion: CONCLUSION[input.verdict.verdict],
    output: {
      title,
      summary: capSummary(formatSummary(input).replace(MARKER, "").trim()),
      annotations: first,
    },
    moreAnnotations: rest,
  };
}

export function skippedCheck(reason: string): CheckOutput {
  return {
    title: "Not reviewed",
    summary: capSummary(`Diffwise didn't review this commit: ${reason}.`),
  };
}

// What a reader of the PR needs: that it didn't run and why. Our errors are written to name
// settings and statuses, never tokens or keys, so the message is safe to show.
export function erroredCheck(err: unknown): CheckOutput {
  const reason = sanitize((err instanceof Error ? err.message : String(err)).slice(0, 1000));
  return {
    title: "Review failed to run",
    summary: capSummary(
      `Diffwise could not finish this review: ${reason}\n\nThis is not a review result. Push again or redeliver the webhook to retry.`,
    ),
  };
}

function toAnnotation(f: Finding): CheckAnnotation {
  return {
    path: f.path,
    startLine: f.line,
    endLine: f.line,
    level: f.severity === "blocking" ? "failure" : "warning",
    title: `${f.severity} · ${f.ruleId}`.slice(0, MAX_TITLE),
    // Plain text, not markdown: GitHub shows annotation messages as-is.
    message: f.suggestion ? `${f.message}\n\nSuggestion: ${f.suggestion}` : f.message,
  };
}

export function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function capSummary(text: string): string {
  const note = "\n\n…(truncated: see the PR review for everything)";
  return text.length <= MAX_SUMMARY ? text : text.slice(0, MAX_SUMMARY - note.length) + note;
}
