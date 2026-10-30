import { describe, expect, it } from "vitest";
import {
  commentableRanges,
  type FileDiff,
  isCommentable,
  parseUnifiedDiff,
} from "../../src/core/diff.js";

// Real `git diff` output (captured from a scratch repo) so the parser is tested on what git emits.
const diff = (...lines: string[]) => `${lines.join("\n")}\n`;

describe("parseUnifiedDiff", () => {
  it("maps old and new line numbers through adds, deletes and context", () => {
    const [file] = parseUnifiedDiff(
      diff(
        "diff --git a/keep.ts b/keep.ts",
        "index 4cb29ea..6addb9b 100644",
        "--- a/keep.ts",
        "+++ b/keep.ts",
        "@@ -1,3 +1,4 @@",
        " one",
        "-two",
        "+TWO",
        " three",
        "+four",
      ),
    );
    expect(file?.hunks[0]?.lines).toEqual([
      { kind: "context", content: "one", oldLine: 1, newLine: 1, commentable: true },
      { kind: "del", content: "two", oldLine: 2, commentable: false },
      { kind: "add", content: "TWO", newLine: 2, commentable: true },
      { kind: "context", content: "three", oldLine: 3, newLine: 3, commentable: true },
      { kind: "add", content: "four", newLine: 4, commentable: true },
    ]);
    expect(file).toMatchObject({ path: "keep.ts", status: "modified", additions: 2, deletions: 1 });
  });

  it("restarts line numbers at each hunk header", () => {
    const [file] = parseUnifiedDiff(
      diff(
        "diff --git a/multi.txt b/multi.txt",
        "--- a/multi.txt",
        "+++ b/multi.txt",
        "@@ -1,3 +1,3 @@",
        " 1",
        "-2",
        "+TWO",
        "@@ -22,3 +22,3 @@",
        " 22",
        "-23",
        "+TWENTY-THREE",
      ),
    );
    expect(file?.hunks.map((h) => [h.oldStart, h.newStart])).toEqual([
      [1, 1],
      [22, 22],
    ]);
    expect(file && commentableRanges(file)).toEqual([
      [1, 2],
      [22, 23],
    ]);
    expect(file && isCommentable(file, 23)).toBe(true);
    expect(file && isCommentable(file, 10)).toBe(false);
  });

  it("parses an added file", () => {
    const [file] = parseUnifiedDiff(
      diff(
        "diff --git a/added.ts b/added.ts",
        "new file mode 100644",
        "index 0000000..07f33c4",
        "--- /dev/null",
        "+++ b/added.ts",
        "@@ -0,0 +1,2 @@",
        "+new",
        "+file",
      ),
    );
    expect(file).toMatchObject({ path: "added.ts", status: "added", additions: 2 });
    expect(file && commentableRanges(file)).toEqual([[1, 2]]);
  });

  it("parses a deleted file as having nothing commentable", () => {
    const [file] = parseUnifiedDiff(
      diff(
        "diff --git a/gone.ts b/gone.ts",
        "deleted file mode 100644",
        "--- a/gone.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-bye",
      ),
    );
    expect(file).toMatchObject({ path: "gone.ts", status: "deleted", deletions: 1 });
    expect(file && commentableRanges(file)).toEqual([]);
  });

  it("parses a rename with edits, keeping both paths", () => {
    const [file] = parseUnifiedDiff(
      diff(
        "diff --git a/old-name.ts b/new-name.ts",
        "similarity index 87%",
        "rename from old-name.ts",
        "rename to new-name.ts",
        "--- a/old-name.ts",
        "+++ b/new-name.ts",
        "@@ -3,2 +3,2 @@",
        " c",
        "-d",
        "+D",
      ),
    );
    expect(file).toMatchObject({ path: "new-name.ts", oldPath: "old-name.ts", status: "renamed" });
    expect(file && isCommentable(file, 4)).toBe(true);
  });

  it("keeps hunkless files: binary, empty new file, mode change", () => {
    const files: FileDiff[] = parseUnifiedDiff(
      diff(
        "diff --git a/bin.dat b/bin.dat",
        "new file mode 100644",
        "Binary files /dev/null and b/bin.dat differ",
        "diff --git a/empty.ts b/empty.ts",
        "new file mode 100644",
        "index 0000000..e69de29",
        "diff --git a/mode.sh b/mode.sh",
        "old mode 100644",
        "new mode 100755",
      ),
    );
    expect(files.map((f) => [f.path, f.status, f.binary, f.hunks.length])).toEqual([
      ["bin.dat", "added", true, 0],
      ["empty.ts", "added", false, 0],
      ["mode.sh", "modified", false, 0],
    ]);
  });

  it("skips '\\ No newline at end of file' markers", () => {
    const [file] = parseUnifiedDiff(
      diff(
        "diff --git a/nonl.ts b/nonl.ts",
        "--- a/nonl.ts",
        "+++ b/nonl.ts",
        "@@ -1 +1 @@",
        "-no newline",
        "\\ No newline at end of file",
        "+still no newline",
        "\\ No newline at end of file",
      ),
    );
    expect(file?.hunks[0]?.lines.map((l) => l.kind)).toEqual(["del", "add"]);
  });

  it("handles paths with spaces and content that looks like headers", () => {
    const [file] = parseUnifiedDiff(
      diff(
        "diff --git a/with space.ts b/with space.ts",
        "--- a/with space.ts\t",
        "+++ b/with space.ts\t",
        "@@ -1,2 +1,2 @@",
        "--- not a header",
        "+rename to nothing",
        " diff --git a/x b/x",
      ),
    );
    expect(file?.path).toBe("with space.ts");
    expect(file?.hunks[0]?.lines.map((l) => [l.kind, l.content])).toEqual([
      ["del", "-- not a header"],
      ["add", "rename to nothing"],
      ["context", "diff --git a/x b/x"],
    ]);
  });

  it("returns no files for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
