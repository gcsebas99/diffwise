import type { BuildOptions } from "esbuild";

// One file, every dependency inlined: used for the Action (dist/index.js) and the App
// (build/app.mjs), so both run on plain Node with no install step.
export const BUNDLE_OPTIONS = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // Unminified: readable stack traces in logs, reviewable diffs when dist/ changes.
  minify: false,
  legalComments: "none",
  logLevel: "warning",
  metafile: true,
  // Some dependencies still call require() for Node built-ins; ESM has no require, so give it one.
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
} satisfies BuildOptions;
