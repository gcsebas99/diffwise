import { stringify } from "yaml";
import { createReviewState } from "../../src/core/review.js";
import { parseRules } from "../../src/core/rules.js";
import type { ToolContext } from "../../src/core/tools/types.js";
import { FakeRepoSource } from "./fake-repo-source.js";

// A small PR: one route file changed (lines 1-9 commentable), one migration added, one file deleted.
export const PR_DIFF = [
  "diff --git a/src/routes/orders.ts b/src/routes/orders.ts",
  "--- a/src/routes/orders.ts",
  "+++ b/src/routes/orders.ts",
  "@@ -1,7 +1,9 @@",
  " export function registerOrderRoutes(router) {",
  "   router.get('/orders', listOrders);",
  "-  router.post('/orders', createOrder);",
  "+  router.post('/orders', createOrder);",
  "+  router.delete('/orders/:id', deleteOrder);",
  "+  router.patch('/orders/:id', updateOrder);",
  " }",
  " ",
  " function listOrders() {}",
  " function createOrder() {}",
  "diff --git a/migrations/002_add_status.sql b/migrations/002_add_status.sql",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/migrations/002_add_status.sql",
  "@@ -0,0 +1,2 @@",
  "+-- up",
  "+ALTER TABLE orders ADD COLUMN status TEXT;",
  "diff --git a/src/legacy.ts b/src/legacy.ts",
  "deleted file mode 100644",
  "--- a/src/legacy.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-export const old = 1;",
  "",
].join("\n");

export const HEAD_FILES: Record<string, string> = {
  "src/routes/orders.ts": [
    "export function registerOrderRoutes(router) {",
    "  router.get('/orders', listOrders);",
    "  router.post('/orders', createOrder);",
    "  router.delete('/orders/:id', deleteOrder);",
    "  router.patch('/orders/:id', updateOrder);",
    "}",
    "",
    "function listOrders() {}",
    "function createOrder() {}",
    "",
  ].join("\n"),
  "migrations/002_add_status.sql": "-- up\nALTER TABLE orders ADD COLUMN status TEXT;\n",
  "test/routes/orders.test.ts": "test('lists orders', () => listOrders());\n",
};

export const RULES_YAML = stringify({
  version: 1,
  rules: [
    {
      id: "route-needs-test",
      title: "API route changes need a test change",
      severity: "blocking",
      applies_to: ["src/routes/**"],
      check: "llm",
      instructions: "Route changes need a test change.",
    },
    {
      id: "migration-reversible",
      title: "Migrations must be reversible",
      severity: "advisory",
      applies_to: ["migrations/**"],
      check: "llm",
      instructions: "Every migration needs a down.",
    },
    {
      id: "no-secrets-in-diff",
      title: "No secrets",
      severity: "blocking",
      applies_to: ["**/*"],
      check: "deterministic:secrets",
    },
  ],
});

export async function makeContext(overrides: Partial<ToolContext> = {}): Promise<ToolContext> {
  const source = overrides.source ?? new FakeRepoSource({ files: HEAD_FILES, diff: PR_DIFF });
  return {
    source,
    rules: parseRules(RULES_YAML),
    files: await source.diff(),
    maxOutputChars: 4000,
    state: createReviewState(),
    ...overrides,
  };
}
