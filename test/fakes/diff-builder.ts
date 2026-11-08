// A one-file unified diff: optional context and removed lines, then the added lines.
export function fileDiff(
  path: string,
  added: string[],
  options: { context?: string[]; removed?: string[] } = {},
): string {
  const context = options.context ?? [];
  const removed = options.removed ?? [];
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${context.length + removed.length} +1,${context.length + added.length} @@`,
    ...context.map((l) => ` ${l}`),
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    "",
  ].join("\n");
}
