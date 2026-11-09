import {
  type CassetteEntry,
  firstDifference,
  normalizeRequest,
  readCassette,
  requestHash,
} from "./cassette.js";
import { HarnessError, type ModelClient, type ModelRequest, type ModelResponse } from "./types.js";

export class CassetteMissError extends HarnessError {
  override readonly name: string = "CassetteMissError";
}

// [HARNESS:EVAL] Serves recorded responses by request hash; anything unrecorded fails loudly.
// WHY: a replay must only ever answer the exact question that was recorded. If the prompt,
//      a tool or the diff changed, serving the old answer would test nothing and hide it.
// INTERVIEW: "How do you run agent evals in CI?" → record real runs once, replay them by
//            request hash; a miss means the input changed, so re-record and review the diff.
export class ReplayModel implements ModelClient {
  private readonly modelName: string;
  private readonly path: string;
  private entries: CassetteEntry[] | undefined;
  private readonly queues = new Map<string, ModelResponse[]>(); // same request twice → in order
  private calls = 0;

  constructor(modelName: string, path: string) {
    this.modelName = modelName;
    this.path = path;
  }

  async create(request: ModelRequest): Promise<ModelResponse> {
    const entries = await this.load();
    const call = this.calls++;
    const normalized = normalizeRequest(this.modelName, request);
    const hash = requestHash(normalized);
    const response = this.queues.get(hash)?.shift();
    // A copy: the loop appends the response to its message history.
    if (response) return structuredClone(response);

    // The conversation is linear, so the recorded call at the same position is the one to
    // compare with; past the end, the cassette simply stopped earlier (e.g. a crash mid-recording).
    const recorded = entries[call];
    const reason = recorded
      ? `first difference from recorded call ${call + 1}: ${firstDifference(recorded.request, normalized) ?? "none (served already)"}`
      : `the cassette has only ${entries.length} recorded calls`;
    throw new CassetteMissError(
      `Cassette miss at call ${call + 1} (hash ${hash}) in ${this.path}; ${reason}. ` +
        "The prompt, tools, rules or diff changed since recording: re-record with --mode record.",
    );
  }

  private async load(): Promise<CassetteEntry[]> {
    if (this.entries) return this.entries;
    this.entries = await readCassette(this.path);
    for (const entry of this.entries) {
      const queue = this.queues.get(entry.hash) ?? [];
      queue.push(entry.response);
      this.queues.set(entry.hash, queue);
    }
    return this.entries;
  }
}
