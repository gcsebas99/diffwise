import { describe, expect, it } from "vitest";
import { secretsCheck } from "../../src/checks/secrets.js";
import { parseUnifiedDiff } from "../../src/core/diff.js";
import { fileDiff } from "../fakes/diff-builder.js";
import { FakeRepoSource } from "../fakes/fake-repo-source.js";

// Fake keys are assembled at runtime so this file never contains a literal that looks like a
// real credential (GitHub push protection would block it, and so would our own check).
const ANTHROPIC = `sk-ant-${"api03-"}${"Ab9".repeat(30)}`;
const GITHUB = `ghp_${"a1B2".repeat(9)}`;
const AWS = `AKIA${"Z".repeat(4)}${"7".repeat(12)}`;

const run = (added: string[], options?: { context?: string[]; removed?: string[] }) =>
  secretsCheck.run({
    files: parseUnifiedDiff(fileDiff("src/app.ts", added, options)),
    source: new FakeRepoSource(),
  });

describe("secrets check", () => {
  it.each([
    ["Anthropic API key (sk-ant-…, 103 chars)", `const key = "${ANTHROPIC}";`],
    ["GitHub token (gh…, 40 chars)", `token: "${GITHUB}",`],
    ["AWS access key ID (AKIA…, 20 chars)", `aws_access_key_id = ${AWS}`],
    ["private key.", "-----BEGIN RSA PRIVATE KEY-----"],
    ["hardcoded password (8 chars)", 'const password = "hunter22";'],
  ])("finds a %s", async (description, line) => {
    const hits = await run([line]);
    expect(hits).toEqual([expect.objectContaining({ line: 1, path: "src/app.ts" })]);
    expect(hits[0]?.message).toContain(description);
  });

  it("never puts the secret itself in the message or suggestion", async () => {
    const hits = await run([`const a = "${ANTHROPIC}";`, `const g = "${GITHUB}";`]);
    const text = JSON.stringify(hits);
    expect(hits).toHaveLength(2);
    for (const secret of [ANTHROPIC, GITHUB]) expect(text).not.toContain(secret.slice(8));
  });

  it("skips placeholders from docs and examples", async () => {
    const hits = await run([
      "ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxx",
      'const password = "changeme";',
      'const password = "<your-password>";',
      "key: sk-ant-your-key-goes-here-1234567890",
    ]);
    expect(hits).toEqual([]);
  });

  it("flags a credential-looking name passed to a logger (PR #5's two lines)", async () => {
    const hits = await run([
      '    logger.debug("auth check", { path: req.path, token });',
      '      logger.warn("auth rejected", { path: req.path, authorization: header });',
    ]);
    expect(hits.map((h) => [h.line, h.message.split(" ")[0]])).toEqual([
      [1, "`token`"],
      [2, "`authorization`"],
    ]);
  });

  it("ignores credential words inside the log message string", async () => {
    expect(await run(['logger.info("auth token refreshed");'])).toEqual([]);
  });

  it("reports a literal secret once, without a second logger finding on the same line", async () => {
    const hits = await run([`console.log("key", "${ANTHROPIC}", token);`]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.message).toMatch(/^Possible secret: Anthropic API key/);
  });

  it("looks at added lines only", async () => {
    const hits = await run(["const ok = 1;"], {
      context: [`const old = "${ANTHROPIC}";`],
      removed: ["logger.info({ token });"],
    });
    expect(hits).toEqual([]);
  });
});
