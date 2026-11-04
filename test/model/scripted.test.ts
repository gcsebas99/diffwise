import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { response, ScriptedModel, text, toolUse } from "../../src/model/scripted.js";
import type { ModelRequest } from "../../src/model/types.js";

const base = { system: [], tools: [] } satisfies Omit<ModelRequest, "messages">;

describe("ScriptedModel", () => {
  it("drives a two-turn exchange: tool_use, then tool_result, then end_turn", async () => {
    const call = toolUse("list_changed_files", {}, "toolu_a");
    const model = new ScriptedModel([
      response([text("Let me look."), call]),
      response([text("Done.")]),
    ]);
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "Review this PR." }];

    const first = await model.create({ ...base, messages });
    expect(first.stopReason).toBe("tool_use");
    messages.push({ role: "assistant", content: first.content });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "1 files changed" }],
    });

    const second = await model.create({ ...base, messages });
    expect(second.stopReason).toBe("end_turn");
    expect(model.remaining).toBe(0);

    // Each recorded request is a snapshot of that turn, not the shared, growing array.
    expect(model.requests.map((r) => r.messages.length)).toEqual([1, 3]);
    expect(model.requests[1]?.messages[2]).toMatchObject({
      content: [{ type: "tool_result", tool_use_id: "toolu_a" }],
    });
  });

  it("throws scripted errors and fails loudly when the script runs out", async () => {
    const model = new ScriptedModel([new Error("529 overloaded")]);
    await expect(model.create({ ...base, messages: [] })).rejects.toThrow("529 overloaded");
    await expect(model.create({ ...base, messages: [] })).rejects.toThrow(
      "script ran out at call 2",
    );
  });

  it("gives tool calls unique ids and fills usage defaults", () => {
    expect(toolUse("a").id).not.toBe(toolUse("a").id);
    expect(response([text("hi")], { inputTokens: 5 }).usage).toEqual({
      inputTokens: 5,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});
