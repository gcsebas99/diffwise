import type { z } from "zod";
import type { FileDiff } from "../diff.js";
import type { RepoSource } from "../repo-source.js";
import type { ReviewState } from "../review.js";
import type { RuleSet } from "../rules.js";

// [HARNESS:TOOLS] Tool failures are values: ok=false becomes is_error on the tool_result.
// WHY: a thrown error ends the review; a returned error lets the model read why and retry
//      with corrected arguments on its next turn.
// INTERVIEW: "What happens when the model calls a tool wrong?" → validate, return an actionable
//            error as the tool result, let it self-correct; the step cap bounds retries.
export interface ToolResult {
  ok: boolean;
  content: string;
  truncated: boolean;
}

export interface ToolContext {
  source: RepoSource;
  rules: RuleSet;
  files: readonly FileDiff[]; // loaded once per review, so every tool sees the same diff
  maxOutputChars: number;
  state: ReviewState;
}

export interface Tool<Input extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: Input;
  // Method syntax (not an arrow property) so a Tool<SpecificSchema> fits in a Tool[] list.
  run(ctx: ToolContext, args: z.output<Input>): Promise<ToolResult>;
}

// Identity function: exists only so TypeScript infers `args` from `input` in each tool file.
export function defineTool<Input extends z.ZodType>(tool: Tool<Input>): Tool<Input> {
  return tool;
}

export const ok = (content: string, truncated = false): ToolResult => ({
  ok: true,
  content,
  truncated,
});
export const fail = (content: string): ToolResult => ({ ok: false, content, truncated: false });
