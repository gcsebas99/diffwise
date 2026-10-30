import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { LocalGitSource } from "../../src/core/local-git-source.js";

// A throwaway repo with a known history: main → feature (edit, delete, rename, add).
let repo: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "diffwise-git-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(join(repo, "keep.ts"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "gone.ts"), "bye\n");
  writeFileSync(join(repo, "old-name.ts"), "a\nb\nc\nd\ne\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("switch", "-qc", "feature");
  writeFileSync(join(repo, "keep.ts"), "one\nTWO\nthree\n");
  writeFileSync(join(repo, "odd:name.ts"), "TWO again\n");
  git("rm", "-q", "gone.ts");
  git("mv", "old-name.ts", "new-name.ts");
  git("add", "-A");
  git("commit", "-qm", "feature");
  // Check out main so tests prove reads come from the head commit, not the working tree.
  git("switch", "-q", "main");
});

describe("LocalGitSource", () => {
  it("resolves refs to SHAs and rejects anything that isn't a commit", async () => {
    const source = await LocalGitSource.open(repo, "main", "feature");
    expect(source.headSha).toBe(git("rev-parse", "feature").trim());
    await expect(LocalGitSource.open(repo, "main", "nope")).rejects.toThrow(
      /'nope' is not a commit/,
    );
  });

  it("diffs base...head into the parsed model", async () => {
    const source = await LocalGitSource.open(repo, "main", "feature");
    const files = await source.diff();
    expect(files.map((f) => [f.status, f.path])).toEqual([
      ["deleted", "gone.ts"],
      ["modified", "keep.ts"],
      ["renamed", "new-name.ts"],
      ["added", "odd:name.ts"],
    ]);
  });

  it("reads files at head even when another branch is checked out", async () => {
    const source = await LocalGitSource.open(repo, "main", "feature");
    expect(await source.readFile("keep.ts")).toBe("one\nTWO\nthree\n");
    expect(await source.readFile("gone.ts")).toBeUndefined();
    expect(await source.readFile("missing.ts")).toBeUndefined();
  });

  it("searches head with -E regexes, globs and a result cap", async () => {
    const source = await LocalGitSource.open(repo, "main", "feature");
    expect(await source.search("TW[O]")).toEqual({
      matches: [
        { path: "keep.ts", line: 2, text: "TWO" },
        { path: "odd:name.ts", line: 1, text: "TWO again" },
      ],
      truncated: false,
    });
    expect((await source.search("TWO", { glob: "keep*" })).matches).toHaveLength(1);
    expect(await source.search("TWO", { maxResults: 1 })).toMatchObject({ truncated: true });
    // One file with more matches than the cap must still report truncation.
    expect(await source.search("[a-z]", { glob: "keep.ts", maxResults: 1 })).toMatchObject({
      matches: [{ path: "keep.ts", line: 1 }],
      truncated: true,
    });
    expect(await source.search("zzz")).toEqual({ matches: [], truncated: false });
  });

  it("treats option-like patterns as text and surfaces invalid regexes", async () => {
    const source = await LocalGitSource.open(repo, "main", "feature");
    expect(await source.search("--open-files-in-pager=sh")).toEqual({
      matches: [],
      truncated: false,
    });
    await expect(source.search("(")).rejects.toThrow(/parentheses/);
  });
});
