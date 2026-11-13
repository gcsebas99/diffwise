import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type AppCredentials,
  createAppJwt,
  InstallationTokens,
  loadAppCredentials,
  REVIEW_PERMISSIONS,
} from "../../../src/adapters/app/auth.js";
import { loadConfig } from "../../../src/config.js";

// A throwaway key made per run: no real App key is ever needed in tests.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString(); // GitHub's format
const credentials: AppCredentials = { clientId: "Iv23test", privateKey };

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

describe("createAppJwt", () => {
  const now = Date.UTC(2026, 10, 12, 12, 0, 0);
  const jwt = createAppJwt(credentials, now);
  const [header = "", claims = "", signature = ""] = jwt.split(".");

  it("has an RS256 header and the claims GitHub requires", () => {
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const seconds = now / 1000;
    expect(decode(claims)).toEqual({ iat: seconds - 60, exp: seconds + 540, iss: "Iv23test" });
  });

  it("is signed by the App's private key", () => {
    const signed = Buffer.from(`${header}.${claims}`);
    expect(verify("sha256", signed, publicKey, Buffer.from(signature, "base64url"))).toBe(true);
    const tampered = Buffer.from(`${header}.${claims.slice(0, -2)}xx`);
    expect(verify("sha256", tampered, publicKey, Buffer.from(signature, "base64url"))).toBe(false);
  });

  it("lives under GitHub's 10-minute cap, counted from the backdated iat", () => {
    const { iat, exp } = decode(claims);
    expect(exp - iat).toBeLessThanOrEqual(600);
  });
});

describe("loadAppCredentials", () => {
  let dir: string | undefined;
  afterAll(() => (dir ? rm(dir, { recursive: true, force: true }) : undefined));

  it("reads the key inline, with escaped newlines, or from a file", async () => {
    const inline = await loadAppCredentials(
      loadConfig({
        GITHUB_APP_CLIENT_ID: "Iv23test",
        GITHUB_PRIVATE_KEY: pem.replaceAll("\n", "\\n"),
      }),
    );
    expect(inline.privateKey.asymmetricKeyType).toBe("rsa");

    dir = await mkdtemp(join(tmpdir(), "diffwise-key-"));
    const path = join(dir, "app.pem");
    await writeFile(path, pem);
    const fromFile = await loadAppCredentials(
      loadConfig({ GITHUB_APP_CLIENT_ID: "Iv23test", GITHUB_PRIVATE_KEY_PATH: path }),
    );
    expect(fromFile.clientId).toBe("Iv23test");
  });

  it("names what's missing or broken, never the key", async () => {
    await expect(loadAppCredentials(loadConfig({}))).rejects.toThrow(
      "GITHUB_APP_CLIENT_ID, GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH",
    );
    const broken = "-----BEGIN RSA PRIVATE KEY-----\nnot-a-key\n-----END RSA PRIVATE KEY-----";
    const err = await loadAppCredentials(
      loadConfig({ GITHUB_APP_CLIENT_ID: "x", GITHUB_PRIVATE_KEY: broken }),
    ).catch((e: Error) => e);
    expect(String(err)).toContain("GITHUB_PRIVATE_KEY is not a valid PEM private key");
    expect(String(err)).not.toContain("not-a-key");
  });
});

// Fake GitHub token endpoint: records requests, mints numbered tokens valid for `ttlMs`.
function fakeGitHub(clock: { now: number }, ttlMs = 60 * 60_000) {
  const requests: { url: string; auth: string; body: unknown }[] = [];
  let status = 201;
  const fetch = async (url: unknown, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    requests.push({
      url: String(url),
      auth: headers.Authorization ?? "",
      body: JSON.parse(String(init?.body)),
    });
    await Promise.resolve(); // let concurrent callers pile up before the reply
    if (status !== 201) {
      return new Response(JSON.stringify({ message: "A JSON web token could not be decoded" }), {
        status,
      });
    }
    return new Response(
      JSON.stringify({
        token: `ghs_test_${requests.length}`,
        expires_at: new Date(clock.now + ttlMs).toISOString(),
        permissions: { pull_requests: "write", metadata: "read" },
        repositories: [{ full_name: "o/r" }],
      }),
      { status: 201 },
    );
  };
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    requests,
    fail: (s: number) => {
      status = s;
    },
  };
}

describe("InstallationTokens", () => {
  const setup = () => {
    const clock = { now: Date.UTC(2026, 10, 12, 12, 0, 0) };
    const github = fakeGitHub(clock);
    const tokens = new InstallationTokens({
      credentials,
      fetch: github.fetch,
      now: () => clock.now,
    });
    return { clock, github, tokens };
  };

  it("POSTs the App JWT and the scope, and returns the installation token", async () => {
    const { github, tokens } = setup();
    const t = await tokens.get(42, { repositories: ["r"], permissions: REVIEW_PERMISSIONS });
    expect(t).toMatchObject({ token: "ghs_test_1", repositories: ["o/r"] });
    expect(github.requests[0]?.url).toBe(
      "https://api.github.com/app/installations/42/access_tokens",
    );
    expect(github.requests[0]?.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(github.requests[0]?.body).toEqual({
      repositories: ["r"],
      permissions: REVIEW_PERMISSIONS,
    });
  });

  it("reuses the token until 5 minutes before it expires, then mints a new one", async () => {
    const { clock, github, tokens } = setup();
    const first = await tokens.get(42);
    clock.now += 54 * 60_000; // 6 minutes left
    expect((await tokens.get(42)).token).toBe(first.token);
    clock.now += 2 * 60_000; // 4 minutes left
    expect((await tokens.get(42)).token).toBe("ghs_test_2");
    expect(github.requests).toHaveLength(2);
  });

  it("concurrent callers share one request", async () => {
    const { github, tokens } = setup();
    const [a, b, c] = await Promise.all([tokens.get(42), tokens.get(42), tokens.get(42)]);
    expect(github.requests).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("keys the cache by installation and scope, in any order", async () => {
    const { github, tokens } = setup();
    await tokens.get(42, { repositories: ["a", "b"] });
    await tokens.get(42, { repositories: ["b", "a"] }); // same scope
    await tokens.get(42); // unscoped: a different token
    await tokens.get(43, { repositories: ["a", "b"] }); // another installation
    expect(github.requests).toHaveLength(3);
  });

  it("a refusal says why without leaking the JWT, and isn't cached", async () => {
    const { github, tokens } = setup();
    github.fail(401);
    const err = await tokens.get(42).catch((e: Error) => e);
    expect(String(err)).toContain("HTTP 401");
    expect(String(err)).toContain("A JSON web token could not be decoded");
    expect(String(err)).toContain("check GITHUB_APP_CLIENT_ID");
    const jwt = github.requests[0]?.auth.replace("Bearer ", "") ?? "";
    expect(String(err)).not.toContain(jwt);

    github.fail(201);
    expect((await tokens.get(42)).token).toBe("ghs_test_2");
  });
});
