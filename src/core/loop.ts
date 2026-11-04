import type Anthropic from "@anthropic-ai/sdk";
import {
  addUsage,
  type ModelClient,
  type ModelResponse,
  totalInputTokens,
  type Usage,
} from "../model/types.js";
import { promptVersion } from "./prompt.js";
import type { Finding } from "./review.js";
import { TERMINAL_TOOL } from "./tools/index.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { ToolContext } from "./tools/types.js";

export type Outcome =
  | "completed"
  | "max_steps"
  | "budget_exceeded"
  | "deadline_exceeded"
  | "stuck"
  | "no_review"
  | "model_error";

export interface LoopLimits {
  maxSteps: number;
  tokenBudget: number; // cumulative input (incl. cache) + output tokens across all turns
  deadlineMs: number; // wall-clock time for the whole review
}

export type LoopEvent =
  | { type: "step"; step: number }
  | { type: "model_call"; step: number; usage: Usage; latencyMs: number; stopReason: string | null }
  | { type: "tool_call"; step: number; name: string; ok: boolean; truncated: boolean }
  | { type: "nudge"; step: number; reason: "no_tool_call" | "repeated_calls" | "output_cut_off" }
  | { type: "exit"; step: number; outcome: Outcome; error?: string };

export interface RunReviewOptions {
  model: ModelClient;
  registry: ToolRegistry;
  ctx: ToolContext;
  system: Anthropic.TextBlockParam[];
  initialMessage: string;
  limits: LoopLimits;
  onEvent?: (event: LoopEvent) => void;
  now?: () => number; // injectable clock, so the deadline can be tested without waiting
}

export interface ReviewRun {
  outcome: Outcome;
  complete: boolean; // true only for "completed"; anything else must never count as a pass
  findings: Finding[];
  summary?: string;
  steps: number;
  usage: Usage;
  promptVersion: string;
  error?: string; // set for model_error
}

const REPEAT_LIMIT = 3;

// [HARNESS:LOOP] Stuck detection: the same set of tool calls REPEAT_LIMIT turns in a row.
// WHY: a confused model can repeat a call forever (often one that keeps failing) and burn the
//      budget. The first time gets a nudge; repeating after the nudge ends the review.
// INTERVIEW: "How do you stop runaway agents?" → step cap, token budget, deadline,
//            repeated-call detection, and an explicit terminal tool.
export class RepeatDetector {
  private last = "";
  private count = 0;
  private nudged = false;

  observe(calls: Anthropic.ToolUseBlock[]): "ok" | "nudge" | "stuck" {
    // The whole turn, names and arguments: catches a model that repeats a pair of calls too.
    const signature = JSON.stringify(calls.map((call) => [call.name, call.input]));
    this.count = signature === this.last ? this.count + 1 : 1;
    this.last = signature;
    if (this.count < REPEAT_LIMIT) return "ok";
    if (this.nudged) return "stuck";
    this.nudged = true;
    return "nudge";
  }
}

// Nudges go after the turn's tool results (the API requires tool_result blocks first).
const NUDGE_NO_TOOL_CALL = [
  "You replied without calling a tool.",
  "Continue the review with tools, or call submit_review if you are done.",
].join(" ");
const NUDGE_REPEATED_CALLS = [
  "You made the same tool calls 3 times in a row and got the same results.",
  "Try something different, or call submit_review with what you have.",
].join(" ");
const NOTE_OUTPUT_CUT_OFF = [
  "Your last response hit the output limit and was cut off.",
  "Make smaller tool calls, fewer per turn.",
].join(" ");

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

// [HARNESS:LOOP] The agent loop: think (model call) → act (run tools) → observe (results back).
// WHY: the model only decides; the loop executes, enforces every limit, and owns the exits.
//      Findings live in ctx.state, so whatever was reported survives any exit.
// INTERVIEW: "Walk me through your agent loop." → messages in, tool_use blocks out, execute,
//            one user message of tool_results paired by id; repeat until terminal tool or limit.
export async function runReview(options: RunReviewOptions): Promise<ReviewRun> {
  const { model, registry, ctx, system, limits } = options;
  const emit = options.onEvent ?? (() => {});
  const now = options.now ?? Date.now;
  const tools = registry.toAnthropicTools();
  const version = promptVersion(system, tools);
  const startedAt = now();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: options.initialMessage }];
  const repeats = new RepeatDetector();
  let usage = ZERO_USAGE;
  let step = 0;
  let nudgedNoToolCall = false;

  const finish = (outcome: Outcome, error?: string): ReviewRun => {
    emit({ type: "exit", step, outcome, ...(error ? { error } : {}) });
    return {
      outcome,
      complete: outcome === "completed",
      findings: ctx.state.findings,
      ...(ctx.state.summary ? { summary: ctx.state.summary } : {}),
      steps: step,
      usage,
      promptVersion: version,
      ...(error ? { error } : {}),
    };
  };

  while (true) {
    // [HARNESS:LOOP] Exits: step cap, token budget, deadline. Checked before every model call.
    // WHY: each one bounds a different cost (turns, money, time); a review that hits one keeps
    //      its findings but is marked incomplete, never passed.
    if (step >= limits.maxSteps) return finish("max_steps");
    if (totalInputTokens(usage) + usage.outputTokens >= limits.tokenBudget) {
      return finish("budget_exceeded");
    }
    if (now() - startedAt >= limits.deadlineMs) return finish("deadline_exceeded");

    step++;
    emit({ type: "step", step });

    // Think.
    let response: ModelResponse;
    try {
      response = await model.create({ system, messages, tools });
    } catch (err) {
      // Exit: model error. The SDK already retried what it could; the model can't fix the rest.
      return finish("model_error", err instanceof Error ? err.message : String(err));
    }
    usage = addUsage(usage, response.usage);
    emit({
      type: "model_call",
      step,
      usage: response.usage,
      latencyMs: response.latencyMs,
      stopReason: response.stopReason,
    });
    messages.push({ role: "assistant", content: response.content });

    const calls = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    // [HARNESS:LOOP] Exit: a turn without tool calls gets one nudge, then ends the review.
    // WHY: plain text is the model "talking" instead of finishing; nothing posts a review
    //      unless submit_review is called, so it gets one reminder, not unlimited turns.
    if (calls.length === 0) {
      if (nudgedNoToolCall) return finish("no_review");
      nudgedNoToolCall = true;
      emit({ type: "nudge", step, reason: "no_tool_call" });
      messages.push({ role: "user", content: NUDGE_NO_TOOL_CALL });
      continue;
    }

    // Act: run the calls in the order the model gave them, so findings keep that order.
    // [HARNESS:TOOLS] One tool_result per tool_use, paired by id, all in one user message.
    // WHY: the API rejects a turn whose tool_use ids lack results; is_error tells the model
    //      the call failed so it reads the message and corrects itself.
    const content: (Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam)[] = [];
    for (const call of calls) {
      const result = await registry.execute(call.name, call.input, ctx);
      emit({
        type: "tool_call",
        step,
        name: call.name,
        ok: result.ok,
        truncated: result.truncated,
      });
      // Exit: the terminal tool succeeded. Calls after it in the same turn are ignored.
      if (call.name === TERMINAL_TOOL && result.ok) return finish("completed");
      content.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: result.content,
        ...(result.ok ? {} : { is_error: true }),
      });
    }

    // Observe: results first, then any notes for the model.
    if (response.stopReason === "max_tokens") {
      emit({ type: "nudge", step, reason: "output_cut_off" });
      content.push({ type: "text", text: NOTE_OUTPUT_CUT_OFF });
    }
    const repeat = repeats.observe(calls);
    if (repeat === "stuck") return finish("stuck"); // exit: repeated calls after the nudge
    if (repeat === "nudge") {
      emit({ type: "nudge", step, reason: "repeated_calls" });
      content.push({ type: "text", text: NUDGE_REPEATED_CALLS });
    }
    messages.push({ role: "user", content });
  }
}
