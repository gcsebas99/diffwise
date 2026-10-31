import { describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../../../src/core/tools/index.js";
import { FakeRepoSource } from "../../fakes/fake-repo-source.js";
import { makeContext } from "../../fakes/tool-context.js";

// Through the registry, like the loop calls them, so argument validation is exercised too.
const registry = createDefaultRegistry();

describe("list_changed_files", () => {
  it("lists status, counts and the llm rules for each file", async () => {
    const result = await registry.execute("list_changed_files", {}, await makeContext());
    expect(result.ok).toBe(true);
    expect(result.content.split("\n")).toEqual([
      "3 files changed:",
      "M src/routes/orders.ts (+3 -1)  rules: route-needs-test",
      "A migrations/002_add_status.sql (+2 -0)  rules: migration-reversible",
      "D src/legacy.ts (-1) [deleted: no lines to comment on]  rules: none",
    ]);
  });
});

describe("get_file_diff", () => {
  it("prints new-side line numbers and the commentable ranges", async () => {
    const ctx = await makeContext();
    const result = await registry.execute("get_file_diff", { path: "src/routes/orders.ts" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Commentable lines: 1-9");
    expect(result.content).toContain(" 4 +   router.delete('/orders/:id', deleteOrder);");
    expect(result.content).toContain("   -   router.post('/orders', createOrder);");
  });

  it("rejects files outside the diff and unsafe paths", async () => {
    const ctx = await makeContext();
    const missing = await registry.execute("get_file_diff", { path: "src/app.ts" }, ctx);
    expect(missing.ok).toBe(false);
    expect(missing.content).toContain("not changed in this PR");

    const outside = await registry.execute("get_file_diff", { path: "../outside.ts" }, ctx);
    expect(outside).toMatchObject({ ok: false });
    expect(outside.content).toContain("contains '..'");
  });
});

describe("read_file", () => {
  it("reads a line range with line numbers", async () => {
    const args = { path: "src/routes/orders.ts", start_line: 3, end_line: 4 };
    const result = await registry.execute("read_file", args, await makeContext());
    expect(result.content.split("\n")).toEqual([
      "src/routes/orders.ts (lines 3-4 of 9)",
      "3    router.post('/orders', createOrder);",
      "4    router.delete('/orders/:id', deleteOrder);",
    ]);
  });

  it("truncates long files with a hint to narrow the range", async () => {
    const source = new FakeRepoSource({ files: { "big.ts": "const x = 1;\n".repeat(1000) } });
    const ctx = await makeContext({ source, maxOutputChars: 500 });
    const result = await registry.execute("read_file", { path: "big.ts" }, ctx);
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(result.content.length).toBeLessThanOrEqual(500);
    expect(result.content).toContain("narrow the range with start_line/end_line");
  });

  it("returns errors for missing files, escaping paths and bad ranges", async () => {
    const ctx = await makeContext();
    const missing = await registry.execute("read_file", { path: "src/legacy.ts" }, ctx);
    expect(missing.content).toContain("No file 'src/legacy.ts' in the head commit");
    const outside = await registry.execute("read_file", { path: "/etc/passwd" }, ctx);
    expect(outside.content).toContain("not repo-relative");
    const past = await registry.execute(
      "read_file",
      { path: "src/routes/orders.ts", start_line: 50 },
      ctx,
    );
    expect(past.content).toContain("past the end");
    const zero = await registry.execute(
      "read_file",
      { path: "src/routes/orders.ts", start_line: 0 },
      ctx,
    );
    expect(zero.content).toContain("invalid arguments for read_file");
    expect([missing, outside, past, zero].every((r) => !r.ok)).toBe(true);
  });
});

describe("search_repo", () => {
  it("returns path:line matches, optionally limited by a glob", async () => {
    const ctx = await makeContext();
    const all = await registry.execute("search_repo", { pattern: "listOrders" }, ctx);
    expect(all.content.split("\n")).toEqual([
      "3 matches for /listOrders/:",
      "src/routes/orders.ts:2: router.get('/orders', listOrders);",
      "src/routes/orders.ts:8: function listOrders() {}",
      "test/routes/orders.test.ts:1: test('lists orders', () => listOrders());",
    ]);
    const tests = await registry.execute(
      "search_repo",
      { pattern: "listOrders", glob: "test/**" },
      ctx,
    );
    expect(tests.content).toContain("1 matches for /listOrders/ in test/**");
  });

  it("treats no matches as a successful answer", async () => {
    const result = await registry.execute(
      "search_repo",
      { pattern: "deleteOrderTest" },
      await makeContext(),
    );
    expect(result).toMatchObject({ ok: true, content: "No matches for /deleteOrderTest/." });
  });

  it("reports an invalid regex as an error with a hint", async () => {
    const result = await registry.execute(
      "search_repo",
      { pattern: "listOrders(" },
      await makeContext(),
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("escape special characters");
  });
});
