import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Config } from "../../config.js";

// The version Octokit's requests get by default, so the App and the Action read the same API.
const API_VERSION = "2022-11-28";
const DEFAULT_BASE_URL = "https://api.github.com";

export interface AppCredentials {
  clientId: string;
  privateKey: KeyObject;
}

// Fail at startup, not on the first webhook: a missing or broken key would otherwise surface
// as a 401 on someone's PR. Errors name the variable, never the key's contents.
export async function loadAppCredentials(config: Config): Promise<AppCredentials> {
  const { GITHUB_APP_CLIENT_ID: clientId, GITHUB_PRIVATE_KEY: inline } = config;
  const path = config.GITHUB_PRIVATE_KEY_PATH;
  const missing = [
    ...(clientId ? [] : ["GITHUB_APP_CLIENT_ID"]),
    ...(inline || path ? [] : ["GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH"]),
  ];
  if (!clientId || missing.length > 0) {
    throw new Error(`The GitHub App requires: ${missing.join(", ")} (see .env.example)`);
  }
  if (inline && path) {
    throw new Error("Set GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH, not both");
  }
  const source = inline ? "GITHUB_PRIVATE_KEY" : `GITHUB_PRIVATE_KEY_PATH (${path})`;
  // A PEM pasted into a single-line env field often arrives with literal "\n" for newlines.
  const pem = inline ? inline.replaceAll("\\n", "\n") : await readFile(path as string, "utf8");
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    throw new Error(`${source} is not a valid PEM private key`);
  }
  if (privateKey.asymmetricKeyType !== "rsa") {
    throw new Error(`${source} must be an RSA key (the .pem GitHub generates for the App)`);
  }
  return { clientId, privateKey };
}

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

// [GH:AUTH] Identity #1, the App itself: a JWT signed with its private key (RS256).
// WHY: the JWT proves "I hold the App's key" and can do almost nothing but ask for an
//      installation token, so it lives 9 minutes (GitHub's cap is 10). iat is 60s in the past
//      because a server clock running ahead of GitHub's makes the token "issued in the future".
// INTERVIEW: "Walk me through GitHub App auth" → sign a JWT (iss = client ID), POST it to
//            /app/installations/{id}/access_tokens, use the 1-hour installation token.
export function createAppJwt(credentials: AppCredentials, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64url({ alg: "RS256", typ: "JWT" });
  const claims = base64url({ iat: now - 60, exp: now + 9 * 60, iss: credentials.clientId });
  const signed = `${header}.${claims}`;
  // An RSA key with sha256 signs RSASSA-PKCS1-v1_5, which is what "RS256" means.
  const signature = sign("sha256", Buffer.from(signed), credentials.privateKey);
  return `${signed}.${signature.toString("base64url")}`;
}

export function githubHeaders(bearer: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${bearer}`,
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "diffwise",
  };
}

export type Permission = "read" | "write";

export interface TokenScope {
  repositories?: string[]; // repo names (no owner); omitted = every repo the install can see
  permissions?: Record<string, Permission>; // omitted = everything the App was granted
}

// [GH:AUTH] Down-scope: a review's token gets one repo and only what a review uses.
// WHY: if a review is hijacked (say, an injection that reaches a tool), the token it could
//      leak works on that PR's repo alone, can't touch issues or settings, and dies in an hour.
// INTERVIEW: "What does a down-scoped token buy you?" → blast radius: least privilege per
//            job, not per App, so one bad review can't reach the other repos.
export const REVIEW_PERMISSIONS: Record<string, Permission> = {
  pull_requests: "write",
  contents: "read",
  checks: "write",
};

export interface InstallationToken {
  token: string;
  expiresAt: Date;
  permissions: Record<string, string>;
  repositories: string[] | undefined; // full names when the token was scoped to repos
}

const TokenResponseSchema = z.object({
  token: z.string().min(1), // no length check: GitHub is rolling out a longer format
  expires_at: z.iso.datetime(),
  permissions: z.record(z.string(), z.string()).default({}),
  repositories: z.array(z.object({ full_name: z.string() })).optional(),
});

const HINTS: Record<number, string> = {
  401: "GitHub rejected the App JWT: check GITHUB_APP_CLIENT_ID, the private key, and the clock.",
  403: "The App isn't allowed this token; check its permissions in the App settings.",
  404: "No such installation for this App: check the installation ID and that the App is installed.",
  422: "The scope asks for a repo or permission the installation wasn't granted.",
};

// Never the JWT or a token: GitHub's own message (e.g. "'exp' claim is too far in the future").
async function refusal(res: Response, installationId: number): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { message?: unknown };
  const detail =
    typeof body.message === "string" ? ` GitHub said: "${body.message.slice(0, 200)}".` : "";
  const hint = HINTS[res.status] ?? "";
  return new Error(
    `GitHub refused a token for installation ${installationId}: HTTP ${res.status}.${detail} ${hint}`.trim(),
  );
}

export interface InstallationTokensOptions {
  credentials: AppCredentials;
  fetch?: typeof globalThis.fetch; // tests pass a fake, so nothing leaves the machine
  now?: () => number; // ms; tests pass a fake clock
  baseUrl?: string;
}

const REFRESH_MARGIN_MS = 5 * 60_000;

interface CacheEntry {
  pending: Promise<InstallationToken>;
  expiresAt?: number; // unset while the request is in flight
}

// [GH:AUTH] Identity #2, the installation: 1-hour tokens, cached per installation and scope.
// WHY: minting a token per API call wastes a round trip and GitHub's rate limit; refreshing
//      with 5 minutes left means a review never starts on a token that dies mid-review.
//      Concurrent callers share the in-flight request instead of each minting a token.
// INTERVIEW: "Why two steps?" → the App key never leaves the server and only mints tokens;
//            what does the work is per installation, scoped and short-lived.
export class InstallationTokens {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly baseUrl: string;

  constructor(private readonly options: InstallationTokensOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  get(installationId: number, scope: TokenScope = {}): Promise<InstallationToken> {
    const key = cacheKey(installationId, scope);
    const entry = this.cache.get(key);
    if (
      entry &&
      (entry.expiresAt === undefined || entry.expiresAt - this.now() > REFRESH_MARGIN_MS)
    ) {
      return entry.pending;
    }
    const fresh: CacheEntry = { pending: this.request(installationId, scope) };
    this.cache.set(key, fresh);
    fresh.pending.then(
      (t) => {
        fresh.expiresAt = t.expiresAt.getTime();
      },
      () => {
        // Don't cache a failure: the next call tries again.
        if (this.cache.get(key) === fresh) this.cache.delete(key);
      },
    );
    return fresh.pending;
  }

  private async request(installationId: number, scope: TokenScope): Promise<InstallationToken> {
    const jwt = createAppJwt(this.options.credentials, this.now());
    const res = await this.fetch(
      `${this.baseUrl}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: { ...githubHeaders(jwt), "Content-Type": "application/json" },
        body: JSON.stringify(scope),
      },
    );
    if (!res.ok) throw await refusal(res, installationId);
    const data = TokenResponseSchema.parse(await res.json());
    return {
      token: data.token,
      expiresAt: new Date(data.expires_at),
      permissions: data.permissions,
      repositories: data.repositories?.map((r) => r.full_name),
    };
  }
}

// Same scope in any order = same token: sort repos and permission names before keying.
function cacheKey(installationId: number, scope: TokenScope): string {
  const repos = [...(scope.repositories ?? [])].sort();
  const perms = Object.entries(scope.permissions ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([installationId, scope.repositories ? repos : null, perms]);
}
