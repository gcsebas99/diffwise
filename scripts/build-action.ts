// Bundles the GitHub Action into dist/index.js: one file, every dependency inlined.
// The runner executes the action straight from the repo at a tag, with no install step.
import { build } from "esbuild";
import { BUNDLE_OPTIONS } from "./bundle-options.js";

const result = await build({
  ...BUNDLE_OPTIONS,
  entryPoints: ["src/adapters/action/index.ts"],
  outfile: "dist/index.js",
});

const bytes = Object.values(result.metafile.outputs).reduce((sum, out) => sum + out.bytes, 0);
console.log(`dist/index.js: ${(bytes / 1024).toFixed(0)} KiB`);
