import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readActionContext } from "../../../src/adapters/action/context.js";

const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);

function payloadFile(pullRequest: Record<string, unknown>): string {
  const path = join(mkdtempSync(join(tmpdir(), "diffwise-event-")), "event.json");
  const pr = {
    number: 7,
    title: "Add filter",
    body: null,
    base: { sha: BASE },
    head: { sha: HEAD, repo: { full_name: "gcsebas99/diffwise-demo" } },
    ...pullRequest,
  };
  writeFileSync(path, JSON.stringify({ action: "opened", pull_request: pr }));
  return path;
}

const env = (eventPath: string, overrides: Record<string, string> = {}) => ({
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_EVENT_PATH: eventPath,
  GITHUB_REPOSITORY: "gcsebas99/diffwise-demo",
  GITHUB_WORKSPACE: "/home/runner/work/diffwise-demo",
  ...overrides,
});

describe("readActionContext", () => {
  it("takes the PR number and both SHAs from the payload", async () => {
    expect(await readActionContext(env(payloadFile({})))).toEqual({
      owner: "gcsebas99",
      repo: "diffwise-demo",
      number: 7,
      title: "Add filter",
      body: "",
      baseSha: BASE,
      headSha: HEAD,
      workspace: "/home/runner/work/diffwise-demo",
      fromFork: false,
    });
  });

  it("treats a PR from another repo, or from a deleted fork, as a fork", async () => {
    const fork = payloadFile({ head: { sha: HEAD, repo: { full_name: "someone/diffwise-demo" } } });
    const deleted = payloadFile({ head: { sha: HEAD, repo: null } });
    expect((await readActionContext(env(fork))).fromFork).toBe(true);
    expect((await readActionContext(env(deleted))).fromFork).toBe(true);
  });

  it("refuses any event other than pull_request", async () => {
    const path = payloadFile({});
    await expect(
      readActionContext(env(path, { GITHUB_EVENT_NAME: "pull_request_target" })),
    ).rejects.toThrow(/pull_request events only; got 'pull_request_target'/);
  });

  it("names the missing runner variables, not their values", async () => {
    await expect(readActionContext({})).rejects.toThrow(
      "Not a GitHub Actions run? Missing or invalid: GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_WORKSPACE",
    );
  });

  it("rejects a payload whose SHA isn't a commit SHA", async () => {
    const path = payloadFile({ head: { sha: "--output=x", repo: null } });
    await expect(readActionContext(env(path))).rejects.toThrow(
      /Unexpected pull_request payload: pull_request\.head\.sha: expected a commit SHA/,
    );
  });
});
