import { addedLines, type Check, type CheckHit } from "./types.js";

const ENV_FILE = ".env.example";
// process.env.NAME and process.env["NAME"] / process.env['NAME'].
const ENV_REF = /process\.env(?:\.([A-Za-z_]\w*)|\[\s*["']([A-Za-z_]\w*)["']\s*\])/g;
// "NAME=", "export NAME=", or a commented-out "# NAME=": all tell a reader the variable exists.
const DOCUMENTED = /^\s*#?\s*(?:export\s+)?([A-Za-z_]\w*)\s*=/;
// Set by Node tooling everywhere; listing it in every .env.example would be noise.
const ALWAYS_KNOWN = new Set(["NODE_ENV"]);

// Only variable names leave this function, never values from .env.example.
async function documentedNames(read: (path: string) => Promise<string | undefined>) {
  const text = await read(ENV_FILE);
  if (text === undefined) return undefined;
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const name = DOCUMENTED.exec(line)?.[1];
    if (name) names.add(name);
  }
  return names;
}

export const envDocumentedCheck: Check = {
  name: "env-documented",
  async run({ files, source }) {
    // Read at the head SHA: a PR that adds the variable to .env.example passes.
    const documented = await documentedNames((path) => source.readFile(path));
    const reported = new Set<string>();
    const hits: CheckHit[] = [];
    for (const { path, line, content } of addedLines(files)) {
      for (const match of content.matchAll(ENV_REF)) {
        const name = match[1] ?? match[2] ?? "";
        if (ALWAYS_KNOWN.has(name) || documented?.has(name) || reported.has(name)) continue;
        reported.add(name); // once per variable, on its first use
        const where =
          documented === undefined
            ? `the repo has no ${ENV_FILE}`
            : `it isn't listed in ${ENV_FILE}`;
        hits.push({
          path,
          line,
          message: `\`${name}\` is read here but ${where}, so someone setting up the app won't know it exists.`,
          suggestion: `Add \`${name}=\` to ${ENV_FILE} with a safe example value or a comment.`,
        });
      }
    }
    return hits;
  },
};
