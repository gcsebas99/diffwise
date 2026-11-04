import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicModel } from "../../src/model/anthropic.js";
import type { ModelRequest } from "../../src/model/types.js";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "test-model",
  content: [{ type: "text", text: "Done." }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 120,
    output_tokens: 30,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: 2000,
  },
};

const apiError = (type: string, message: string) => ({ type: "error", error: { type, message } });
// retry-after-ms keeps the SDK's backoff to 1 ms so the test stays fast.
const overloaded = () =>
  json(529, apiError("overloaded_error", "Overloaded"), { "retry-after-ms": "1" });
const unauthorized = () => json(401, apiError("authentication_error", "bad key"));

// A fake fetch that plays back responses and records request bodies: nothing leaves the machine.
function fakeFetch(...replies: (() => Response)[]) {
  const bodies: Record<string, unknown>[] = [];
  const fetch = async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected extra request");
    return reply();
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, bodies };
}

const modelWith = (fetch: typeof globalThis.fetch) =>
  new AnthropicModel({ apiKey: "test-key", model: "test-model", fetch });

const request: ModelRequest = {
  system: [{ type: "text", text: "You are Diffwise.", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: "Review this PR." }],
  tools: [{ name: "submit_review", description: "Finish.", input_schema: { type: "object" } }],
};

describe("AnthropicModel", () => {
  it("sends model, system and tools, and maps the response and usage", async () => {
    const fake = fakeFetch(() => json(200, MESSAGE));
    const model = modelWith(fake.fetch);
    const result = await model.create(request);

    expect(fake.bodies[0]).toMatchObject({
      model: "test-model",
      max_tokens: 4096,
      system: request.system,
      tools: request.tools,
    });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "Done." }],
      stopReason: "end_turn",
      usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 2000 },
    });
  });

  it("retries a 529 overloaded response and then succeeds", async () => {
    const fake = fakeFetch(overloaded, () => json(200, MESSAGE));
    const model = modelWith(fake.fetch);
    await expect(model.create(request)).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(fake.bodies).toHaveLength(2);
  });

  it("does not retry a 401 and throws the SDK's authentication error", async () => {
    const fake = fakeFetch(unauthorized);
    const model = modelWith(fake.fetch);
    await expect(model.create(request)).rejects.toBeInstanceOf(Anthropic.AuthenticationError);
    expect(fake.bodies).toHaveLength(1);
  });
});
