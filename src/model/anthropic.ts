import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import type { ModelClient, ModelRequest, ModelResponse } from "./types.js";

export interface AnthropicModelOptions {
  apiKey: string;
  model: string; // from DIFFWISE_MODEL, never hardcoded
  maxTokens?: number;
  fetch?: ClientOptions["fetch"]; // tests inject a fake so no request leaves the machine
}
export class AnthropicModel implements ModelClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(options: AnthropicModelOptions) {
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? 4096;
    // [HARNESS:ORCH] Retries live in the SDK: 408/409/429/5xx (incl. 529 overloaded) and
    //   connection errors, with exponential backoff that honors retry-after headers.
    // WHY: transient API errors are normal at scale and the model can't fix them, so retry
    //      quietly; 4xx client errors (bad request, auth) won't succeed on retry, so they throw.
    // INTERVIEW: "How do you handle rate limits?" → bounded retries with backoff + jitter,
    //            respect retry-after, cap total time with a timeout, then fail visibly.
    this.client = new Anthropic({
      apiKey: options.apiKey,
      maxRetries: 4,
      timeout: 120_000, // per attempt; the SDK default is 10 minutes, too long for a CI job
      fetch: options.fetch,
    });
  }

  async create(request: ModelRequest): Promise<ModelResponse> {
    const started = performance.now();
    // Throws once retries are exhausted: an API failure isn't something the model can fix,
    // so the loop catches it and ends the review as incomplete.
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
    });
    return {
      content: message.content,
      stopReason: message.stop_reason,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
      latencyMs: Math.round(performance.now() - started), // includes any retries
    };
  }
}
