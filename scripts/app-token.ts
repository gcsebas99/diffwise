// Live check of the App's auth against the real GitHub API: `pnpm app:token [owner/repo]`.
// Prints IDs, expiry and permissions; never a token, the JWT or the key.
import {
  createAppJwt,
  githubHeaders,
  InstallationTokens,
  loadAppCredentials,
  REVIEW_PERMISSIONS,
} from "../src/adapters/app/auth.js";
import { loadConfig } from "../src/config.js";

const API = "https://api.github.com";
const fullName = process.argv[2] ?? "gcsebas99/diffwise-demo";
const [, repo] = fullName.split("/");
if (!repo) throw new Error("usage: pnpm app:token <owner/repo>");

const config = loadConfig();
const credentials = await loadAppCredentials(config);

// 1. As the App (JWT): which installation covers this repo?
const res = await fetch(`${API}/repos/${fullName}/installation`, {
  headers: githubHeaders(createAppJwt(credentials)),
});
if (!res.ok) throw new Error(`GET /repos/${fullName}/installation: HTTP ${res.status}`);
const install = (await res.json()) as { id: number; app_slug: string };
console.log(
  `1. App JWT accepted: ${install.app_slug} is installed on ${fullName} as ${install.id}`,
);
if (config.GITHUB_INSTALLATION_ID && config.GITHUB_INSTALLATION_ID !== install.id) {
  console.warn(`   GITHUB_INSTALLATION_ID is ${config.GITHUB_INSTALLATION_ID}, not ${install.id}`);
}

// 2. As the installation: a token scoped to this repo and the review's permissions.
const tokens = new InstallationTokens({ credentials });
const scope = { repositories: [repo], permissions: REVIEW_PERMISSIONS };
const token = await tokens.get(install.id, scope);
const minutes = Math.round((token.expiresAt.getTime() - Date.now()) / 60_000);
console.log(`2. Installation token: expires in ${minutes} min (${token.expiresAt.toISOString()})`);
console.log(`   repositories: ${token.repositories?.join(", ") ?? "all"}`);
console.log(`   permissions:  ${JSON.stringify(token.permissions)}`);
console.log(`   cached:       ${(await tokens.get(install.id, scope)) === token ? "yes" : "no"}`);

// 3. Use it: read the repo's open PRs (one page of up to 100 is plenty for a check).
const prs = await fetch(`${API}/repos/${fullName}/pulls?state=open&per_page=100`, {
  headers: githubHeaders(token.token),
});
if (!prs.ok) throw new Error(`GET /repos/${fullName}/pulls: HTTP ${prs.status}`);
const open = (await prs.json()) as { number: number; title: string }[];
console.log(`3. Token works: ${open.length} open PR(s) on ${fullName}`);
for (const pr of open) console.log(`   #${pr.number} ${pr.title}`);
