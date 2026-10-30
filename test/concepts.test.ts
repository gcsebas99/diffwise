import { describe, expect, it } from "vitest";
import { extract } from "../scripts/concepts.js";

describe("concepts extractor", () => {
  it("captures tag, title and continuation lines", () => {
    const src = [
      "const x = 1;",
      "// [HARNESS:LOOP] Exit condition #3 — stuck detection.",
      "// WHY: a confused model can repeat the same call forever.",
      "// INTERVIEW: How do you stop runaway agents?",
      "if (stuck) return;",
      "  // [GH:API] Create a review.",
      "  // WHY: one request posts all comments.",
    ].join("\n");
    expect(extract(src, "src/a.ts")).toEqual([
      {
        tag: "HARNESS:LOOP",
        title: "Exit condition #3 — stuck detection.",
        body: [
          "WHY: a confused model can repeat the same call forever.",
          "INTERVIEW: How do you stop runaway agents?",
        ],
        file: "src/a.ts",
        line: 2,
      },
      {
        tag: "GH:API",
        title: "Create a review.",
        body: ["WHY: one request posts all comments."],
        file: "src/a.ts",
        line: 6,
      },
    ]);
  });

  it("ignores ordinary comments", () => {
    expect(extract("// just a note\n// [todo] lowercase", "f.ts")).toEqual([]);
  });
});
