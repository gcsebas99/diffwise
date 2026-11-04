import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient, ModelRequest, ModelResponse, Usage } from "./types.js";

// An Error in the script is thrown instead of returned, to simulate an API failure.
export type ScriptStep = ModelResponse | Error;

// [HARNESS:ORCH] A fake model that plays back a script: no network, same result every run.
// WHY: loop tests need exact control over what the model "decides" (call a tool, repeat a call,
//      answer in plain text, fail) and must check what the loop sent back each turn.
export class ScriptedModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private readonly script: ScriptStep[];

  constructor(script: ScriptStep[]) {
    this.script = [...script];
  }

  async create(request: ModelRequest): Promise<ModelResponse> {
    // A copy, because the loop keeps appending to the same messages array after this call.
    this.requests.push(structuredClone(request));
    const step = this.script.shift();
    if (!step) {
      throw new Error(`ScriptedModel: script ran out at call ${this.requests.length}`);
    }
    if (step instanceof Error) throw step;
    return step;
  }

  get remaining(): number {
    return this.script.length;
  }
}

let nextId = 1;

export function toolUse(
  name: string,
  input: Record<string, unknown> = {},
  id = `toolu_${String(nextId++).padStart(3, "0")}`,
): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input, caller: { type: "direct" } };
}

export function text(value: string): Anthropic.TextBlock {
  return { type: "text", text: value, citations: null };
}

// stopReason follows the content, like the real API: any tool_use block means "tool_use".
export function response(
  content: Anthropic.ContentBlock[],
  usage: Partial<Usage> = {},
): ModelResponse {
  return {
    content,
    stopReason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      ...usage,
    },
    latencyMs: 0,
  };
}
