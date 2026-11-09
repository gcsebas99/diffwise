import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { type LoopEvent, type LoopLimits, runReview } from "../../src/core/loop.js";
import { buildSystemPrompt, promptVersion } from "../../src/core/prompt.js";
import { createDefaultRegistry } from "../../src/core/tools/index.js";
import {
  response,
  ScriptedModel,
  type ScriptStep,
  text,
  toolUse,
} from "../../src/model/scripted.js";
import { HarnessError } from "../../src/model/types.js";
import { makeContext } from "../fakes/tool-context.js";

const LIMITS: LoopLimits = { maxSteps: 20, tokenBudget: 100_000, deadlineMs: 600_000 };

const finding = (line: number) =>
  toolUse("report_finding", {
    rule_id: "route-needs-test",
    path: "src/routes/orders.ts",
    line,
    message: "New route has no test.",
  });
const submit = (summary = "Done.") => toolUse("submit_review", { summary });

// Runs a review against the fake PR from test/fakes, with a scripted model.
async function run(
  script: ScriptStep[],
  options: { limits?: Partial<LoopLimits>; now?: () => number } = {},
) {
  const ctx = await makeContext();
  const model = new ScriptedModel(script);
  const registry = createDefaultRegistry();
  const system = buildSystemPrompt(ctx.rules);
  const events: LoopEvent[] = [];
  const result = await runReview({
    model,
    registry,
    ctx,
    system,
    initialMessage: "Review this pull request.",
    limits: { ...LIMITS, ...options.limits },
    onEvent: (event) => events.push(event),
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    result,
    model,
    events,
    expectedVersion: promptVersion(system, registry.toAnthropicTools()),
  };
}

// The user message the loop sent back after turn `n` (1-based) is the last message of request n+1.
function replyAfterTurn(model: ScriptedModel, n: number): Anthropic.MessageParam | undefined {
  return model.requests[n]?.messages.at(-1);
}

describe("runReview: completing a review", () => {
  it("completes when submit_review succeeds, keeping findings, summary and usage", async () => {
    const { result, expectedVersion } = await run([
      response([toolUse("list_changed_files")]),
      response([finding(4)]),
      response([submit("Adds two routes without tests.")]),
    ]);
    expect(result).toMatchObject({
      outcome: "completed",
      complete: true,
      summary: "Adds two routes without tests.",
      steps: 3,
      usage: { inputTokens: 300, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 },
      promptVersion: expectedVersion,
    });
    expect(result.findings).toMatchObject([{ ruleId: "route-needs-test", line: 4 }]);
  });

  it("answers parallel calls in one message, paired by id, with is_error on failures", async () => {
    const { model } = await run([
      response([
        text("Checking two files."),
        toolUse("get_file_diff", { path: "src/app.ts" }, "toolu_7"),
        toolUse("get_file_diff", { path: "src/routes/orders.ts" }, "toolu_8"),
      ]),
      response([submit()]),
    ]);
    const reply = replyAfterTurn(model, 1);
    expect(reply?.role).toBe("user");
    expect(reply?.content).toMatchObject([
      { type: "tool_result", tool_use_id: "toolu_7", is_error: true },
      { type: "tool_result", tool_use_id: "toolu_8" },
    ]);
    const blocks = reply?.content as Anthropic.ToolResultBlockParam[];
    expect(blocks[1]).not.toHaveProperty("is_error");
    expect(blocks[1]?.content).toContain("Commentable lines: 1-9");
  });

  it("ignores calls after a successful submit_review in the same turn", async () => {
    const { result } = await run([response([finding(4), submit(), finding(5)])]);
    expect(result.outcome).toBe("completed");
    expect(result.findings.map((f) => f.line)).toEqual([4]);
  });

  it("keeps going when submit_review fails validation", async () => {
    const { result, model } = await run([response([submit("")]), response([submit("Fixed.")])]);
    expect(result).toMatchObject({ outcome: "completed", summary: "Fixed.", steps: 2 });
    expect(replyAfterTurn(model, 1)?.content).toMatchObject([
      { type: "tool_result", is_error: true },
    ]);
  });
  it("emits step, model_call, tool_call and exit events", async () => {
    const { events } = await run([response([submit()])]);
    expect(events.map((e) => e.type)).toEqual(["step", "model_call", "tool_call", "exit"]);
    expect(events.at(-1)).toEqual({ type: "exit", step: 1, outcome: "completed" });
  });
});

describe("runReview: early exits keep findings and are never complete", () => {
  it("max_steps: stops at the step cap", async () => {
    const { result, model } = await run(
      [response([finding(4)]), response([toolUse("read_file", { path: "src/routes/orders.ts" })])],
      { limits: { maxSteps: 2 } },
    );
    expect(result).toMatchObject({ outcome: "max_steps", complete: false, steps: 2 });
    expect(result.findings).toHaveLength(1);
    expect(model.remaining).toBe(0);
  });

  it("budget_exceeded: counts cache tokens toward the budget", async () => {
    // 500 uncached alone is under 1000; with 600 cache-read tokens the turn costs 1120.
    const { result, model } = await run(
      [response([finding(4)], { inputTokens: 500, cacheReadTokens: 600 }), response([submit()])],
      { limits: { tokenBudget: 1_000 } },
    );
    expect(result).toMatchObject({ outcome: "budget_exceeded", complete: false, steps: 1 });
    expect(result.findings).toHaveLength(1); // the over-budget turn's tools still ran
    expect(model.requests).toHaveLength(1);
  });

  it("deadline_exceeded: stops before the next call once time is up", async () => {
    const times = [0, 0, 11 * 60_000]; // start, check before turn 1, check before turn 2
    const { result } = await run([response([finding(4)]), response([submit()])], {
      now: () => times.shift() ?? 11 * 60_000,
    });
    expect(result).toMatchObject({ outcome: "deadline_exceeded", complete: false, steps: 1 });
    expect(result.findings).toHaveLength(1);
  });

  it("stuck: nudges on the 3rd identical turn, stops on the 4th", async () => {
    const same = () => response([toolUse("read_file", { path: "src/nope.ts" })]);
    const { result, model, events } = await run([same(), same(), same(), same(), same()]);
    expect(result).toMatchObject({ outcome: "stuck", complete: false, steps: 4 });
    expect(events.filter((e) => e.type === "nudge")).toEqual([
      { type: "nudge", step: 3, reason: "repeated_calls" },
    ]);
    const nudge = replyAfterTurn(model, 3)?.content as Anthropic.ContentBlockParam[];
    expect(nudge.map((b) => b.type)).toEqual(["tool_result", "text"]); // text after results
    expect(nudge[1]).toMatchObject({ text: expect.stringContaining("same tool calls 3 times") });
  });

  it("no_review: one nudge after a text-only turn, then stops", async () => {
    const { result, model } = await run([
      response([text("The changes look fine.")]),
      response([text("Yes, all good.")]),
    ]);
    expect(result).toMatchObject({ outcome: "no_review", complete: false, steps: 2 });
    expect(result.summary).toBeUndefined();
    expect(replyAfterTurn(model, 1)).toEqual({
      role: "user",
      content: expect.stringContaining("call submit_review"),
    });
  });

  it("model_error: an API failure ends the review with its message", async () => {
    const { result } = await run([response([finding(4)]), new Error("529 overloaded")]);
    expect(result).toMatchObject({
      outcome: "model_error",
      complete: false,
      steps: 2,
      error: "529 overloaded",
    });
    expect(result.findings).toHaveLength(1);
  });

  it("re-throws a harness error instead of ending as model_error", async () => {
    const stale = new HarnessError("Cassette miss at call 2");
    await expect(run([response([finding(4)]), stale])).rejects.toBe(stale);
  });

  it("adds a note after the results when the output was cut off", async () => {
    const cutOff = {
      ...response([toolUse("list_changed_files")]),
      stopReason: "max_tokens" as const,
    };
    const { model, events } = await run([cutOff, response([submit()])]);
    expect(replyAfterTurn(model, 1)?.content).toMatchObject([
      { type: "tool_result" },
      { type: "text", text: expect.stringContaining("cut off") },
    ]);
    expect(events).toContainEqual({ type: "nudge", step: 1, reason: "output_cut_off" });
  });
});
