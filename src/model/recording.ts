import { appendEntry, clearCassette, normalizeRequest, requestHash } from "./cassette.js";
import type { ModelClient, ModelRequest, ModelResponse } from "./types.js";

// [HARNESS:EVAL] Wraps a real model and writes every exchange to a cassette as it happens.
// WHY: one paid run becomes a fixture that replays for free, exactly, as often as needed;
//      evals in CI then test the harness without paying or depending on the API being up.
export class RecordingModel implements ModelClient {
  private readonly inner: ModelClient;
  private readonly modelName: string;
  private readonly path: string;
  private started: Promise<void> | undefined;

  constructor(inner: ModelClient, modelName: string, path: string) {
    this.inner = inner;
    this.modelName = modelName;
    this.path = path;
  }

  async create(request: ModelRequest): Promise<ModelResponse> {
    this.started ??= clearCassette(this.path);
    await this.started;
    // A failed call throws before anything is written: an outage isn't something to replay.
    const response = await this.inner.create(request);
    const normalized = normalizeRequest(this.modelName, request);
    await appendEntry(this.path, { hash: requestHash(normalized), request: normalized, response });
    return response;
  }
}
