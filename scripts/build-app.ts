// Bundles the GitHub App server into build/app.mjs for the Docker image, so the runtime image
// needs Node and this one file: no node_modules, no source, no dev tools.
import { build } from "esbuild";
import { BUNDLE_OPTIONS } from "./bundle-options.js";

const result = await build({
  ...BUNDLE_OPTIONS,
  entryPoints: ["src/adapters/app/main.ts"],
  outfile: "build/app.mjs",
});

const bytes = Object.values(result.metafile.outputs).reduce((sum, out) => sum + out.bytes, 0);
console.log(`build/app.mjs: ${(bytes / 1024).toFixed(0)} KiB`);
