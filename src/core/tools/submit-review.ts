import { z } from "zod";
import { defineTool, ok } from "./types.js";

export const submitReview = defineTool({
  name: "submit_review",
  description: [
    "Finish the review. Call exactly once, after you have reported every finding.",
    "The summary is posted on the pull request: 2-5 sentences on what changed and what you found,",
    "including any problem that couldn't be anchored to a diff line.",
    "Don't state a verdict (pass/fail); it is computed from the findings.",
    "No tool calls are processed after this one.",
  ].join("\n"),
  input: z.object({
    summary: z.string().min(1).describe("Short review summary for the pull request"),
  }),
  async run(ctx, args) {
    ctx.state.summary = args.summary;
    const n = ctx.state.findings.length;
    return ok(`Review submitted with ${n} finding${n === 1 ? "" : "s"}.`);
  },
});
