import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { reviewChanges } from "../../src/core/engine.js";
import { parseRules } from "../../src/core/rules.js";
import { RecordingModel } from "../../src/model/recording.js";
import { CassetteMissError, ReplayModel } from "../../src/model/replay.js";
import { response, ScriptedModel, text, toolUse } from "../../src/model/scripted.js";
import type { ModelClient, ModelRequest } from "../../src/model/types.js";
import { FakeRepoSource } from "../fakes/fake-repo-source.js";
import { HEAD_FILES, PR_DIFF, RULES_YAML } from "../fakes/tool-context.js";

const MODEL = "claude-haiku-5-5";
const cassettePath = () => join(mkdtempSync(join(tmpdir(), "diffwise-rr-")), "case/1.jsonl");

// A real engine run on the fake PR; only the model is swapped.
async function review(model: ModelClient, rulesYaml = RULES_YAML) {
  const source = new FakeRepoSource({ files: HEAD_FILES, diff: PR_DIFF });
  return reviewChanges({
    source,
    rules: parseRules(rulesYaml),
    files: await source.diff(),
    model,
    modelName: MODEL,
    config: loadConfig({}),
  });
}

// What the "real" model does while recording: read the diff, report, submit.
const realRun = () =>
  new ScriptedModel([
    response([toolUse("get_file_diff", { path: "src/routes/orders.ts" })]),
    response([
      toolUse("report_finding", {
        rule_id: "route-needs-test",
        path: "src/routes/orders.ts",
        line: 4,
        message: "New route without a test.",
      }),
      toolUse("submit_review", { summary: "One finding." }),
    ]),
  ]);

describe("record and replay", () => {
  it("replays a recorded review exactly, without calling any real model", async () => {
    const path = cassettePath();
    const recorded = await review(new RecordingModel(realRun(), MODEL, path));
    const replayed = await review(new ReplayModel(MODEL, path));

    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2); // one line per call
    expect(replayed).toEqual(recorded);
    expect(recorded.verdict.verdict).toBe("fail");
  });

  it("starts each recording from an empty file", async () => {
    const path = cassettePath();
    await review(new RecordingModel(realRun(), MODEL, path));
    await review(new RecordingModel(realRun(), MODEL, path));
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("writes nothing for a call that failed", async () => {
    const path = cassettePath();
    const failing = new ScriptedModel([new Error("529 overloaded")]);
    const result = await review(new RecordingModel(failing, MODEL, path));
    expect(result.run.outcome).toBe("model_error");
    expect(readFileSync(path, "utf8")).toBe("");
  });

  it("fails loudly and names the change when a rule's text changed", async () => {
    const path = cassettePath();
    await review(new RecordingModel(realRun(), MODEL, path));
    const edited = RULES_YAML.replace(
      "Route changes need a test change.",
      "Routes need two tests.",
    );

    const replay = review(new ReplayModel(MODEL, path), edited);
    await expect(replay).rejects.toBeInstanceOf(CassetteMissError);
    await expect(replay).rejects.toThrow(
      /Cassette miss at call 1 .* first difference from recorded call 1: request\.system\[0\]\.text/,
    );
  });

  it("misses when replayed under a different model name", async () => {
    const path = cassettePath();
    await review(new RecordingModel(realRun(), MODEL, path));
    await expect(review(new ReplayModel("claude-sonnet-5-5", path))).rejects.toThrow(
      /first difference from recorded call 1: request\.model/,
    );
  });

  it("says when the cassette stopped early", async () => {
    const path = cassettePath();
    await review(new RecordingModel(realRun(), MODEL, path));
    const [first = ""] = readFileSync(path, "utf8").split("\n");
    writeFileSync(path, `${first}\n`); // as if the recording crashed after call 1
    await expect(review(new ReplayModel(MODEL, path))).rejects.toThrow(
      /call 2 .* the cassette has only 1 recorded calls/,
    );
  });

  it("serves the same request's responses in recorded order", async () => {
    const path = cassettePath();
    const same: ModelRequest = {
      system: [],
      tools: [],
      messages: [{ role: "user", content: "hi" }],
    };
    const recording = new RecordingModel(
      new ScriptedModel([response([text("first")]), response([text("second")])]),
      MODEL,
      path,
    );
    await recording.create(same);
    await recording.create(same);

    const replay = new ReplayModel(MODEL, path);
    expect((await replay.create(same)).content).toEqual([text("first")]);
    expect((await replay.create(same)).content).toEqual([text("second")]);
  });
});
