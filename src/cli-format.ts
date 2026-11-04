import { styleText } from "node:util";
import type { LoopEvent, ReviewRun } from "./core/loop.js";
import type { VerdictResult } from "./core/verdict.js";
import { totalInputTokens } from "./model/types.js";

type Style = Parameters<typeof styleText>[0];

// Pure string builders: the CLI decides whether to color (TTY, NO_COLOR); tests pass false.
const paint = (style: Style, text: string, color: boolean) =>
  color ? styleText(style, text, { validateStream: false }) : text;

const num = (n: number) => n.toLocaleString("en-US");

// One live line per model call and tool call, so a long review shows progress as it goes.
export function formatEvent(event: LoopEvent, color: boolean): string | undefined {
  switch (event.type) {
    case "model_call": {
      const { usage } = event;
      const cached = usage.cacheReadTokens > 0 ? ` (${num(usage.cacheReadTokens)} cached)` : "";
      const seconds = (event.latencyMs / 1000).toFixed(1);
      const tokens = `in ${num(totalInputTokens(usage))}${cached}  out ${num(usage.outputTokens)}`;
      return paint("dim", `step ${event.step}  ${seconds}s  ${tokens}`, color);
    }
    case "tool_call": {
      const mark = event.ok ? paint("green", "✓", color) : paint("red", "✗", color);
      return `  ${mark} ${event.name}${event.truncated ? paint("dim", " (truncated)", color) : ""}`;
    }
    case "nudge":
      return paint("yellow", `  ↻ nudge: ${event.reason.replaceAll("_", " ")}`, color);
    default:
      return undefined; // step and exit add nothing the other lines and the report don't show
  }
}

const VERDICT_STYLE: Record<VerdictResult["verdict"], Style> = {
  pass: "green",
  fail: "red",
  neutral: "yellow",
};

export function formatReport(
  run: ReviewRun,
  verdict: VerdictResult,
  cost: number | undefined,
  color: boolean,
): string {
  const lines: string[] = [""];
  lines.push(paint("bold", `Findings (${run.findings.length})`, color));
  if (run.findings.length === 0) lines.push("  none");
  const byFile = Map.groupBy(run.findings, (f) => f.path);
  for (const [path, findings] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${paint("underline", path, color)}`);
    for (const f of findings.toSorted((a, b) => a.line - b.line)) {
      const severity = paint(f.severity === "blocking" ? "red" : "yellow", f.severity, color);
      lines.push(`    ${String(f.line).padStart(4)}  ${severity}  ${f.ruleId}  ${f.message}`);
      if (f.suggestion) lines.push(paint("dim", `          suggestion: ${f.suggestion}`, color));
    }
  }

  lines.push("", paint("bold", "Summary", color));
  lines.push(`  ${run.summary ?? paint("dim", "(no summary: the review did not finish)", color)}`);

  const { blocking, advisory } = verdict.counts;
  const word = paint(VERDICT_STYLE[verdict.verdict], verdict.verdict.toUpperCase(), color);
  const label = paint("bold", word, color);
  lines.push("", `Verdict: ${label}  (${blocking} blocking, ${advisory} advisory)`);

  const outcome = run.complete
    ? run.outcome
    : paint("yellow", `${run.outcome} (incomplete)`, color);
  lines.push(`Outcome: ${outcome}${run.error ? `: ${run.error}` : ""}`);

  const { usage } = run;
  const cache = [
    `${num(usage.cacheReadTokens)} cache read`,
    `${num(usage.cacheWriteTokens)} cache write`,
  ].join(", ");
  const costText = cost === undefined ? "cost unknown" : `est. $${cost.toFixed(4)}`;
  lines.push(
    paint(
      "dim",
      [
        `${run.steps} steps`,
        `${num(totalInputTokens(usage))} in (${cache})`,
        `${num(usage.outputTokens)} out`,
        costText,
        `prompt ${run.promptVersion}`,
      ].join(" · "),
      color,
    ),
  );
  return lines.join("\n");
}
