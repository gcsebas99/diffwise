import type Anthropic from "@anthropic-ai/sdk";

// SDK types on purpose: the loop needs tool_use blocks and ids exactly as the API defines them.
export interface ModelRequest {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
}

// [HARNESS:OBS] The four token counters, recorded on every model call.
// WHY: they are the cost. inputTokens is only the uncached part; cache reads bill at ~0.1x and
//      cache writes at ~1.25x, so "is caching working?" is a cacheReadTokens > 0 question.
export interface Usage {
  inputTokens: number; // input after the last cache breakpoint, full price
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ModelResponse {
  content: Anthropic.ContentBlock[];
  stopReason: Anthropic.StopReason | null;
  usage: Usage;
  latencyMs: number;
}

// [HARNESS:ORCH] The loop talks to this interface, never to the SDK directly.
// WHY: tests swap in a ScriptedModel (no network, no cost, same result every run), and Phase 3
//      adds Recording/Replay models for evals. The loop can't tell which one it has.
// INTERVIEW: "How do you test an agent without paying for API calls?" → put the model behind
//            an interface; script responses for unit tests, record and replay real ones for evals.
export interface ModelClient {
  create(request: ModelRequest): Promise<ModelResponse>;
}

// Everything the model read this turn, cached or not: what the token budget counts.
export function totalInputTokens(usage: Usage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}
