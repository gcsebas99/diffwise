import { describe, expect, it } from "vitest";
import { GitHubApiSource } from "../../../src/adapters/app/api-source.js";
import { FakeGitHubClient } from "../../../src/adapters/github/fake.js";

const HEAD = "h".repeat(40);
const PR = { owner: "o", repo: "r", number: 7 };

function setup() {
  const github = new FakeGitHubClient({
    number: 7,
    title: "t",
    body: "",
    baseSha: "b".repeat(40),
    headSha: HEAD,
  });
  return { github, source: new GitHubApiSource(github, PR, HEAD) };
}

describe("GitHubApiSource.diff", () => {
  it("parses each file's patch with the shared diff parser", async () => {
    const { github, source } = setup();
    github.files = [
      {
        filename: "src/a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1,2 +1,3 @@\n one\n+two\n three",
      },
    ];
    const [file] = await source.diff();
    expect(file).toMatchObject({ path: "src/a.ts", status: "modified", binary: false });
    expect(file?.hunks[0]?.lines.map((l) => [l.kind, "newLine" in l ? l.newLine : null])).toEqual([
      ["context", 1],
      ["add", 2],
      ["context", 3],
    ]);
  });

  it("maps GitHub's statuses, renames and patchless files", async () => {
    const { github, source } = setup();
    github.files = [
      {
        filename: "gone.ts",
        status: "removed",
        additions: 0,
        deletions: 3,
        patch: "@@ -1,3 +0,0 @@\n-a\n-b\n-c",
      },
      {
        filename: "new.ts",
        previousFilename: "old.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
      },
      { filename: "logo.png", status: "added", additions: 0, deletions: 0 },
      {
        filename: "copy.ts",
        previousFilename: "src.ts",
        status: "copied",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+x",
      },
    ];
    const files = await source.diff();
    expect(files.map((f) => [f.path, f.status, f.oldPath, f.binary])).toEqual([
      ["gone.ts", "deleted", undefined, false],
      ["new.ts", "renamed", "old.ts", false], // a pure rename has no patch and isn't binary
      ["logo.png", "added", undefined, true], // no patch: nothing commentable
      ["copy.ts", "added", undefined, false],
    ]);
  });

  it("lists the files once per review", async () => {
    const { github, source } = setup();
    await source.diff();
    await source.diff();
    expect(github.calls.filter((c) => c.method === "listPullRequestFiles")).toHaveLength(1);
  });
});

describe("GitHubApiSource.readFile", () => {
  it("reads at the pinned head SHA, caches, and returns undefined for a missing path", async () => {
    const { github, source } = setup();
    github.setFile(HEAD, "src/a.ts", "export const a = 1;\n");
    github.setFile("main", "src/a.ts", "the branch moved on");
    expect(await source.readFile("src/a.ts")).toBe("export const a = 1;\n");
    expect(await source.readFile("src/a.ts")).toBe("export const a = 1;\n");
    expect(await source.readFile("nope.ts")).toBeUndefined();
    const reads = github.calls.filter((c) => c.method === "getFileContent");
    expect(reads.map((c) => c.args[1])).toEqual([HEAD, HEAD]);
  });
});

describe("GitHubApiSource.search", () => {
  it("matches line by line, changed files first, and honors the glob", async () => {
    const { github, source } = setup();
    github.setFile(HEAD, "src/a.ts", "const token = 1;\nconst x = token;");
    github.setFile(HEAD, "src/z.ts", "token here too");
    github.setFile(HEAD, "test/a.test.ts", "token in a test");
    github.files = [
      {
        filename: "src/z.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+token here too",
      },
    ];

    const all = await source.search("token");
    expect(all.matches.map((m) => `${m.path}:${m.line}`)).toEqual([
      "src/z.ts:1", // changed file first
      "src/a.ts:1",
      "src/a.ts:2",
      "test/a.test.ts:1",
    ]);
    expect(all.truncated).toBe(false);

    const tests = await source.search("token", { glob: "test/**" });
    expect(tests.matches.map((m) => m.path)).toEqual(["test/a.test.ts"]);
  });

  it("is truncated at maxResults, past the file cap, or when the tree was truncated", async () => {
    const { github, source } = setup();
    for (let i = 0; i < 101; i++) github.setFile(HEAD, `f${String(i).padStart(3, "0")}.ts`, "hit");
    const capped = await source.search("hit", { maxResults: 500 });
    expect(capped.matches).toHaveLength(100); // 100 files read, the 101st skipped
    expect(capped.truncated).toBe(true);
    expect((await source.search("hit", { maxResults: 3 })).matches).toHaveLength(3);

    const small = setup();
    small.github.setFile(HEAD, "a.ts", "hit");
    small.github.treeTruncated = true;
    expect((await small.source.search("hit")).truncated).toBe(true);
  });

  it("a catastrophic regex times out instead of freezing the server", async () => {
    const { github, source } = setup();
    github.setFile(HEAD, "a.txt", `${"a".repeat(40)}!`);
    const started = Date.now();
    await expect(source.search("(a+)+$")).rejects.toThrow(/took over 1000 ms/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("an invalid regex is an error the tool can show the model", async () => {
    const { github, source } = setup();
    github.setFile(HEAD, "a.ts", "x");
    await expect(source.search("(unclosed")).rejects.toThrow(/invalid regex/);
  });
});
