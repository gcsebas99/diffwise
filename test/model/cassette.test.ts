import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  firstDifference,
  normalizeRequest,
  readCassette,
  requestHash,
} from "../../src/model/cassette.js";
import { HarnessError, type ModelRequest } from "../../src/model/types.js";

// A two-turn conversation: one tool call and its result, paired by id.
function request(options: { id?: string; rule?: string; toolDescription?: string } = {}) {
  const id = options.id ?? "toolu_01AbCdEf";
  return {
    system: [{ type: "text", text: `Rules:\n${options.rule ?? "Routes need tests."}` }],
    tools: [
      {
        name: "get_file_diff",
        description: options.toolDescription ?? "Show a file's diff.",
        input_schema: { type: "object" },
      },
    ],
    messages: [
      { role: "user", content: "Review this PR." },
      {
        role: "assistant",
        content: [{ type: "tool_use", id, name: "get_file_diff", input: { path: "a.ts" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "+x" }] },
    ],
  } as ModelRequest;
}

const hash = (model: string, req: ModelRequest) => requestHash(normalizeRequest(model, req));

describe("request hash", () => {
  it("ignores random tool ids and key order", () => {
    const reordered = JSON.parse(JSON.stringify(request(), Object.keys(request()).reverse()));
    expect(hash("m", request({ id: "toolu_09Zz" }))).toBe(hash("m", request()));
    expect(hash("m", { ...reordered, ...request() })).toBe(hash("m", request()));
  });

  it("renumbers tool ids in order and keeps each result paired with its call", () => {
    const normalized = JSON.stringify(normalizeRequest("m", request()));
    expect(normalized).toContain('"id":"toolu_0"');
    expect(normalized).toContain('"tool_use_id":"toolu_0"');
  });

  it.each([
    ["the model", hash("other-model", request())],
    ["a rule's text", hash("m", request({ rule: "Routes need two tests." }))],
    ["a tool description", hash("m", request({ toolDescription: "Show a diff." }))],
  ])("changes when %s changes", (_, changed) => {
    expect(changed).not.toBe(hash("m", request()));
  });
});

describe("firstDifference", () => {
  it("points at the path and character where two requests diverge", () => {
    const a = normalizeRequest("m", request());
    const b = normalizeRequest("m", request({ rule: "Routes need two tests." }));
    expect(firstDifference(a, b)).toBe(
      'request.system[0].text, char 20: "Rules:\\nRoutes need tests." vs "Rules:\\nRoutes need two tests."',
    );
  });

  it("reports length and value differences, and undefined when equal", () => {
    expect(firstDifference([1, 2], [1, 2, 3])).toBe("request: 2 items vs 3");
    expect(firstDifference({ a: 1 }, { a: 2 })).toBe("request.a: 1 vs 2");
    expect(
      firstDifference(normalizeRequest("m", request()), normalizeRequest("m", request())),
    ).toBe(undefined);
  });
});

describe("readCassette", () => {
  it("throws a harness error that says to record first", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "diffwise-cassette-")), "missing.jsonl");
    const read = readCassette(path);
    await expect(read).rejects.toBeInstanceOf(HarnessError);
    await expect(read).rejects.toThrow(/Record one first with --mode record/);
  });
});
