import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createDefaultRegistry, TERMINAL_TOOL } from "../../../src/core/tools/index.js";
import { ToolRegistry } from "../../../src/core/tools/registry.js";
import { defineTool, ok } from "../../../src/core/tools/types.js";
import { safeRepoPath, truncate } from "../../../src/core/tools/util.js";
import { makeContext } from "../../fakes/tool-context.js";

const echo = defineTool({
  name: "echo",
  description: "Echo text back.",
  input: z.object({ text: z.string(), times: z.number().int().default(1) }),
  async run(_ctx, args) {
    return ok(args.text.repeat(args.times));
  },
});
const boom = defineTool({
  name: "boom",
  description: "Always throws.",
  input: z.object({}),
  async run() {
    throw new Error("disk on fire");
  },
});

describe("ToolRegistry", () => {
  it("rejects duplicate tool names at construction", () => {
    expect(() => new ToolRegistry([echo, echo])).toThrow("duplicate tool name 'echo'");
  });

  it("exports Anthropic tool definitions from the Zod schemas", () => {
    const [tool] = new ToolRegistry([echo]).toAnthropicTools();
    expect(tool).toMatchObject({ name: "echo", description: "Echo text back." });
    expect(tool?.input_schema).toMatchObject({ type: "object", required: ["text"] });
    expect(tool?.input_schema).not.toHaveProperty("$schema");
  });

  it("returns errors as values: unknown tool, invalid args, a throwing tool", async () => {
    const registry = new ToolRegistry([echo, boom]);
    const ctx = await makeContext();

    const unknown = await registry.execute("nope", {}, ctx);
    expect(unknown).toMatchObject({ ok: false });
    expect(unknown.content).toContain("Available tools: echo, boom");

    const invalid = await registry.execute("echo", { text: 42 }, ctx);
    expect(invalid.ok).toBe(false);
    expect(invalid.content).toContain("invalid arguments for echo");
    expect(invalid.content).toContain("text");

    expect(await registry.execute("boom", {}, ctx)).toMatchObject({
      ok: false,
      content: "boom failed: disk on fire",
    });
  });

  it("applies schema defaults and caps oversized output", async () => {
    const registry = new ToolRegistry([echo]);
    const ctx = await makeContext({ maxOutputChars: 200 });
    expect((await registry.execute("echo", { text: "hi" }, ctx)).content).toBe("hi");

    const big = await registry.execute("echo", { text: "line\n", times: 500 }, ctx);
    expect(big.ok).toBe(true);
    expect(big.truncated).toBe(true);
    expect(big.content.length).toBeLessThanOrEqual(200);
    expect(big.content).toMatch(/…\[\d+ more lines; output was cut/);
  });

  it("registers the six default tools with submit_review as the terminal tool", () => {
    expect(createDefaultRegistry().names()).toEqual([
      "list_changed_files",
      "get_file_diff",
      "read_file",
      "search_repo",
      "report_finding",
      "submit_review",
    ]);
    expect(TERMINAL_TOOL).toBe("submit_review");
  });
});

describe("tool utils", () => {
  it("truncate keeps short text and cuts long text at a line boundary", () => {
    expect(truncate("short", 100, "hint")).toEqual({ text: "short", truncated: false });
    const { text, truncated } = truncate("aaaa\n".repeat(100), 80, "hint");
    expect(truncated).toBe(true);
    expect(text).toMatch(/^(aaaa\n)+…\[\d+ more lines; hint\]$/);
  });

  it.each(["/etc/passwd", "../secrets", "src/../../x", "C:/x", "src\\x", "", "a\0b"])(
    "safeRepoPath rejects %j",
    (path) => {
      expect(safeRepoPath(path).ok).toBe(false);
    },
  );

  it("safeRepoPath accepts repo-relative paths and strips a leading ./", () => {
    expect(safeRepoPath("./src/app.ts")).toEqual({ ok: true, path: "src/app.ts" });
    expect(safeRepoPath("src/..hidden/x")).toEqual({ ok: true, path: "src/..hidden/x" });
  });
});
