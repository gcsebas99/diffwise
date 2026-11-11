import { join } from "node:path";
import type { Config } from "../src/config.js";
import { needsModel, reviewChanges } from "../src/core/engine.js";
import { LocalGitSource } from "../src/core/local-git-source.js";
import type { Outcome } from "../src/core/loop.js";
import type { ModelClient } from "../src/model/types.js";
import { EVALS_DIR, type EvalCase } from "./case.js";
import { gradeTrial, type TrialGrade, type TrialResult, toTrialResult } from "./graders/index.js";
import { type CaseRepo, materialize } from "./materialize.js";

export type EvalMode = "live" | "record" | "replay";

export const CASSETTES_DIR = join(EVALS_DIR, "cassettes");

// One cassette per trial: replaying k trials replays k different recorded runs, so the
// variance between trials survives into CI instead of k copies of one run.
export function cassettePath(caseId: string, trial: number): string {
  return join(CASSETTES_DIR, caseId, `${trial}.jsonl`);
}

// Called only when the case needs the model, so a case with no LLM rule never needs a cassette.
export type ModelFactory = (c: EvalCase, trial: number) => ModelClient;

export interface RunOptions {
  config: Config;
  modelName: string | undefined; // for the cost estimate; undefined if no case needs a model
  createModel: ModelFactory;
}

interface TrialBase {
  caseId: string;
  trial: number; // 1-based, matches the cassette file name
  wallMs: number;
}

export type TrialRecord =
  | (TrialBase & {
      status: "graded";
      result: TrialResult;
      grade: TrialGrade;
      outcome: Outcome;
      modelUsed: boolean;
      promptVersion: string;
      latencyMs: number; // sum of model-call latencies: recorded, so live and replay compare
    })
  | (TrialBase & { status: "error"; error: string });

// [HARNESS:EVAL] One trial: fresh repo, the same engine the Action uses, graded, cleaned up.
// WHY: anything thrown here is the harness's fault (stale cassette, broken patch), not the
//      agent's, so it becomes status "error", reported apart from failed cases. An agent
//      problem never throws: it ends as an outcome (model_error, max_steps) and is graded.
// INTERVIEW: "Your eval failed: agent or harness?" → separate the two by construction, or a
//            stale fixture reads as a quality regression and someone "fixes" the prompt.
export async function runTrial(c: EvalCase, trial: number, opts: RunOptions): Promise<TrialRecord> {
  const started = performance.now();
  const base = { caseId: c.id, trial };
  let repo: CaseRepo | undefined;
  try {
    repo = await materialize(c);
    const source = await LocalGitSource.open(repo.path, repo.base, repo.head);
    const files = await source.diff();
    const model = needsModel(c.ruleSet, files) ? opts.createModel(c, trial) : undefined;
    let latencyMs = 0;
    const outcome = await reviewChanges({
      source,
      rules: c.ruleSet,
      files,
      config: opts.config,
      ...(c.pr ? { pr: c.pr } : {}),
      ...(model ? { model, modelName: opts.modelName } : {}),
      onEvent: (event) => {
        if (event.type === "model_call") latencyMs += event.latencyMs;
      },
    });
    const result = toTrialResult(outcome);
    return {
      ...base,
      status: "graded",
      result,
      grade: gradeTrial(c, result),
      outcome: outcome.run.outcome,
      modelUsed: model !== undefined,
      promptVersion: outcome.run.promptVersion,
      latencyMs,
      wallMs: Math.round(performance.now() - started),
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ...base, status: "error", error, wallMs: Math.round(performance.now() - started) };
  } finally {
    await repo?.cleanup();
  }
}

// k trials per case through a small worker pool. Results keep case/trial order whatever the
// concurrency, so two reports of the same suite line up row by row.
export async function runSuite(
  cases: readonly EvalCase[],
  opts: RunOptions & { k: number; concurrency: number; onTrial?: (t: TrialRecord) => void },
): Promise<TrialRecord[]> {
  const jobs = cases.flatMap((c) =>
    Array.from({ length: opts.k }, (_, i) => () => runTrial(c, i + 1, opts)),
  );
  const records: TrialRecord[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      const job = jobs[i];
      if (!job) break;
      const record = await job();
      records[i] = record;
      opts.onTrial?.(record);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, jobs.length) }, worker));
  return records;
}
