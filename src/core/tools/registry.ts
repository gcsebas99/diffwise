import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { fail, type Tool, type ToolContext, type ToolResult } from "./types.js";
import { truncate } from "./util.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool[]) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new Error(`duplicate tool name '${tool.name}'`);
      this.tools.set(tool.name, tool);
    }
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  // [HARNESS:TOOLS] One Zod schema per tool, both the API's JSON Schema and the validator.
  // WHY: what the model is told and what execute() enforces can't drift apart.
  //      io:"input" describes what the caller may send (fields with defaults aren't required).
  toAnthropicTools(): Anthropic.Tool[] {
    return [...this.tools.values()].map((tool) => {
      const { $schema: _, ...schema } = z.toJSONSchema(tool.input, { io: "input" });
      return {
        name: tool.name,
        description: tool.description,
        input_schema: schema as Anthropic.Tool.InputSchema,
      };
    });
  }

  // [HARNESS:TOOLS] execute() never throws: every failure becomes ok=false with a next step.
  // WHY: the loop must keep running so the model can self-correct; a crash would lose the
  //      whole review over one bad call. Retries are bounded by the loop's step cap (1.8).
  // INTERVIEW: "Where do you validate tool calls?" → at one choke point, before run(); the
  //            model's arguments are untrusted input like any other.
  async execute(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return fail(`unknown tool '${name}'. Available tools: ${this.names().join(", ")}`);

    const parsed = tool.input.safeParse(rawArgs);
    if (!parsed.success) {
      const issues = z.prettifyError(parsed.error);
      return fail(
        `invalid arguments for ${name}:\n${issues}\nFix the arguments and call ${name} again.`,
      );
    }

    let result: ToolResult;
    try {
      result = await tool.run(ctx, parsed.data);
    } catch (err) {
      return fail(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Backstop: tools truncate with their own specific hint, but none may exceed the limit.
    const capped = truncate(
      result.content,
      ctx.maxOutputChars,
      "output was cut; ask for a smaller piece",
    );
    return { ...result, content: capped.text, truncated: result.truncated || capped.truncated };
  }
}
