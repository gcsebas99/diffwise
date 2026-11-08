// Bundles the GitHub Action into dist/index.js: one file, every dependency inlined.
// The runner executes the action straight from the repo at a tag, with no install step.
import { build } from "esbuild";

const result = await build({
  entryPoints: ["src/adapters/action/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // Unminified: readable stack traces in job logs, reviewable diffs when dist/ changes.
  minify: false,
  legalComments: "none",
  logLevel: "warning",
  metafile: true,
  // Some dependencies still call require() for Node built-ins; ESM has no require, so give it one.
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});

const bytes = Object.values(result.metafile.outputs).reduce((sum, out) => sum + out.bytes, 0);
console.log(`dist/index.js: ${(bytes / 1024).toFixed(0)} KiB`);
