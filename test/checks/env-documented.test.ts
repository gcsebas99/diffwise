import { describe, expect, it } from "vitest";
import { envDocumentedCheck } from "../../src/checks/env-documented.js";
import { parseUnifiedDiff } from "../../src/core/diff.js";
import { fileDiff } from "../fakes/diff-builder.js";
import { FakeRepoSource } from "../fakes/fake-repo-source.js";

const ENV_EXAMPLE = [
  "# Copy to .env",
  "PORT=3000",
  "export AUTH_SECRET=super-secret-example-value",
  "# LOG_LEVEL=debug",
].join("\n");

// null = the repo has no .env.example (undefined would fall back to the default).
const run = (added: string[], envExample: string | null = ENV_EXAMPLE) =>
  envDocumentedCheck.run({
    files: parseUnifiedDiff(fileDiff("src/config.ts", added)),
    source: new FakeRepoSource({
      files: envExample === null ? {} : { ".env.example": envExample },
    }),
  });

describe("env-documented check", () => {
  it("reports a new variable missing from .env.example, once, at its first use", async () => {
    const hits = await run([
      "const limit = Number(process.env.RATE_LIMIT_PER_MIN ?? 60);",
      "const again = process.env.RATE_LIMIT_PER_MIN;",
    ]);
    expect(hits).toEqual([
      {
        path: "src/config.ts",
        line: 1,
        message: expect.stringMatching(/^`RATE_LIMIT_PER_MIN` is read here but it isn't listed/),
        suggestion:
          "Add `RATE_LIMIT_PER_MIN=` to .env.example with a safe example value or a comment.",
      },
    ]);
  });

  it("accepts NAME=, export NAME= and a commented-out # NAME= as documented", async () => {
    const hits = await run([
      "process.env.PORT;",
      "process.env.AUTH_SECRET;",
      "process.env.LOG_LEVEL;",
    ]);
    expect(hits).toEqual([]);
  });

  it("understands bracket access and ignores NODE_ENV", async () => {
    const hits = await run(['process.env["SENTRY_DSN"];', "process.env.NODE_ENV;"]);
    expect(hits.map((h) => h.message.split(" ")[0])).toEqual(["`SENTRY_DSN`"]);
  });

  it("says when the repo has no .env.example", async () => {
    const hits = await run(["process.env.PORT;"], null);
    expect(hits[0]?.message).toContain("the repo has no .env.example");
  });

  it("never copies values from .env.example into a message", async () => {
    const hits = await run(["process.env.NEW_ONE;"]);
    expect(JSON.stringify(hits)).not.toContain("super-secret-example-value");
  });
});
