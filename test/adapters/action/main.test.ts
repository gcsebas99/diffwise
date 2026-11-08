import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { ActionContext } from "../../../src/adapters/action/context.js";
import { type ActionIO, type Annotation, run } from "../../../src/adapters/action/main.js";
import { FakeGitHubClient } from "../../../src/adapters/github/fake.js";
import { MARKER } from "../../../src/core/publish.js";
import { response, ScriptedModel, type ScriptStep, toolUse } from "../../../src/model/scripted.js";
import { RULES_YAML } from "../../fakes/tool-context.js";

// A throwaway checkout like the one actions/checkout leaves: main → route change, main → docs.
let workspace: string;
const sha: Record<"base" | "route" | "docs" | "leak", string> = {
  base: "",
  route: "",
  docs: "",
  leak: "",
};
const git = (...args: string[]) =>
  execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8" }).trim();
const write = (path: string, text: string) => {
  mkdirSync(join(workspace, path, ".."), { recursive: true });
  writeFileSync(join(workspace, path), text);
};

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "diffwise-action-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  write(".review-rules.yaml", RULES_YAML);
  write("src/routes/orders.ts", "router.get('/orders', list);\nrouter.post('/orders', create);\n");
  write("README.md", "# demo\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  sha.base = git("rev-parse", "HEAD");
  git("switch", "-qc", "route");
  write("src/routes/orders.ts", "router.get('/orders', list);\nrouter.post('/orders', save);\n");
  git("commit", "-qam", "route");
  sha.route = git("rev-parse", "HEAD");
  git("switch", "-q", "-c", "docs", "main");
  write("README.md", "# demo\n\nMore docs.\n");
  git("commit", "-qam", "docs");
  sha.docs = git("rev-parse", "HEAD");
  git("switch", "-q", "-c", "leak", "main");
  write("README.md", "# demo\n\nlogger.info({ token });\n");
  git("commit", "-qam", "leak");
  sha.leak = git("rev-parse", "HEAD");
});

// Records everything the action tells the runner.
class FakeIO implements ActionIO {
  readonly log: string[] = [];
  readonly annotations: { level: string; message: string; annotation?: Annotation }[] = [];
  readonly outputs: Record<string, string> = {};
  readonly summaries: string[] = [];
  readonly secrets: string[] = [];
  failed: string | undefined;
  private readonly inputs: Record<string, string>;

  constructor(inputs: Record<string, string>) {
    this.inputs = inputs;
  }

  getInput(name: string): string {
    return this.inputs[name] ?? "";
  }
  info(message: string): void {
    this.log.push(message);
  }
  warning(message: string, annotation?: Annotation): void {
    this.annotations.push({ level: "warning", message, annotation });
  }
  error(message: string, annotation?: Annotation): void {
    this.annotations.push({ level: "error", message, annotation });
  }
  setSecret(value: string): void {
    this.secrets.push(value);
  }
  setOutput(name: string, value: string): void {
    this.outputs[name] = value;
  }
  setFailed(message: string): void {
    this.failed = message;
  }
  async writeSummary(markdown: string): Promise<void> {
    this.summaries.push(markdown);
  }
}

const LIVE = {
  mode: "live",
  "anthropic-api-key": "sk-test",
  model: "claude-haiku-5-5",
  "github-token": "ghs-test",
};

const finding = toolUse("report_finding", {
  rule_id: "route-needs-test",
  path: "src/routes/orders.ts",
  line: 2,
  message: "POST /orders changed without a test.",
});
const submit = toolUse("submit_review", { summary: "One route changed without a test." });

function setup(options: { inputs?: Record<string, string>; head?: string; script?: ScriptStep[] }) {
  const head = options.head ?? sha.route;
  const context: ActionContext = {
    owner: "gcsebas99",
    repo: "diffwise-demo",
    number: 7,
    title: "Save orders differently",
    body: "Please review.",
    baseSha: sha.base,
    headSha: head,
    workspace,
    fromFork: false,
  };
  const io = new FakeIO(options.inputs ?? LIVE);
  const model = new ScriptedModel(options.script ?? []);
  const github = new FakeGitHubClient({ number: 7, title: "", body: "", baseSha: "", headSha: "" });
  const created = { model: 0, github: 0 };
  const deps = {
    readContext: async () => context,
    createModel: () => {
      created.model++;
      return model;
    },
    createGitHub: () => {
      created.github++;
      return github;
    },
    env: {},
  };
  return { io, model, github, created, context, start: () => run(io, deps), deps };
}

describe("action run", () => {
  it("fails the job on a blocking finding, after posting the review and the summary", async () => {
    const t = setup({ script: [response([finding]), response([submit])] });
    await t.start();

    expect(t.github.reviews).toHaveLength(1);
    expect(t.github.reviews[0]).toMatchObject({ commitId: sha.route });
    expect(t.github.reviews[0]?.comments).toMatchObject([
      { path: "src/routes/orders.ts", line: 2 },
    ]);
    expect(t.io.annotations).toEqual([
      {
        level: "error",
        message: "POST /orders changed without a test.",
        annotation: { title: "route-needs-test", file: "src/routes/orders.ts", startLine: 2 },
      },
    ]);
    expect(t.io.summaries[0]).toContain(MARKER);
    expect(t.io.outputs).toEqual({ verdict: "fail", "review-url": expect.stringContaining("#r1") });
    expect(t.io.failed).toMatch(/^1 blocking finding\(s\)\. See the review: https:/);
    expect(t.io.secrets).toEqual(["sk-test"]);
  });

  it("passes the PR title and body to the model as untrusted text", async () => {
    const t = setup({ script: [response([submit])] });
    await t.start();
    const first = JSON.stringify(t.model.requests[0]?.messages[0]);
    expect(first).toContain("<untrusted_pr_title>\\nSave orders differently");
    expect(first).toContain("<untrusted_pr_description>\\nPlease review.");
    expect(t.io.outputs.verdict).toBe("pass");
    expect(t.io.failed).toBeUndefined();
  });

  it("skips the model and GitHub entirely in deterministic-only mode (the default)", async () => {
    const t = setup({ inputs: { "github-token": "ghs-test" } });
    await t.start();
    expect(t.created).toEqual({ model: 0, github: 0 });
    expect(t.io.outputs).toEqual({ verdict: "pass" });
    expect(t.io.summaries).toEqual([expect.stringContaining("add the `live-review` label")]);
    expect(t.io.failed).toBeUndefined();
  });

  it("fails on a deterministic finding in deterministic-only mode, without the model", async () => {
    const t = setup({ inputs: { "github-token": "ghs-test" }, head: sha.leak });
    await t.start();
    expect(t.created).toEqual({ model: 0, github: 1 });
    expect(t.github.reviews[0]?.comments).toMatchObject([{ path: "README.md", line: 3 }]);
    expect(t.io.summaries[0]).toContain("automated checks only · no model call · $0");
    expect(t.io.failed).toMatch(/^1 blocking finding\(s\)/);
  });

  it("skips the model when no changed file has an LLM rule, even in live mode", async () => {
    const t = setup({ head: sha.docs });
    await t.start();
    expect(t.created).toEqual({ model: 0, github: 0 });
    expect(t.io.summaries[0]).toContain("no changed file has a rule for the model to check");
  });

  it("explains a missing API key on a fork PR without calling the model", async () => {
    const t = setup({ inputs: { ...LIVE, "anthropic-api-key": "" } });
    t.deps.readContext = async () => ({ ...t.context, fromFork: true });
    await t.start();
    expect(t.created.model).toBe(0);
    expect(t.io.failed).toMatch(/could not run: .*PRs from forks don't receive secrets/);
  });

  it("rejects an unknown mode", async () => {
    const t = setup({ inputs: { ...LIVE, mode: "yolo" } });
    await t.start();
    expect(t.io.failed).toMatch(/input 'mode' must be one of live, deterministic-only; got 'yolo'/);
  });

  it("warns but stays green when the review doesn't finish", async () => {
    const t = setup({ script: [new Error("529 Overloaded")] });
    await t.start();
    expect(t.io.outputs.verdict).toBe("neutral");
    expect(t.io.annotations.at(-1)?.message).toMatch(/did not finish \(model_error\)/);
    expect(t.io.failed).toBeUndefined();
  });

  it("still writes the summary and verdict when posting the review fails", async () => {
    const t = setup({ script: [response([submit])] });
    t.github.createReview = async () => {
      throw new Error("Resource not accessible by integration");
    };
    await t.start();
    expect(t.io.summaries).toHaveLength(1);
    expect(t.io.outputs).toEqual({ verdict: "pass" });
    expect(t.io.failed).toMatch(/could not run: Resource not accessible by integration/);
  });
});
