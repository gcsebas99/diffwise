import { describe, expect, it } from "vitest";
import {
  JobQueue,
  type JobQueueOptions,
  parseInstallations,
} from "../../../src/adapters/app/jobs.js";
import type { ReviewJob } from "../../../src/adapters/app/webhook.js";

const job = (number: number, deliveryId: string, installationId = 1): ReviewJob => ({
  deliveryId,
  installationId,
  owner: "o",
  repo: "r",
  number,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  title: "t",
  body: "",
});

// Jobs that finish only when the test says so, to observe the queue mid-flight.
function controlledRun() {
  const started: string[] = [];
  const finishers = new Map<string, (err?: Error) => void>();
  const run = (j: ReviewJob) =>
    new Promise<void>((resolve, reject) => {
      started.push(j.deliveryId);
      finishers.set(j.deliveryId, (err) => (err ? reject(err) : resolve()));
    });
  const finish = async (id: string, err?: Error) => {
    finishers.get(id)?.(err);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { started, run, finish };
}

function queue(overrides: Partial<JobQueueOptions> & Pick<JobQueueOptions, "run">) {
  const skipped: string[] = [];
  const errors: string[] = [];
  const q = new JobQueue({
    concurrency: 1,
    dailyCap: 50,
    allowedInstallations: new Set([1]),
    onSkipped: (j, reason) => skipped.push(`${j.deliveryId}: ${reason}`),
    onError: (j, err) => errors.push(`${j.deliveryId}: ${(err as Error).message}`),
    ...overrides,
  });
  return { q, skipped, errors };
}

describe("JobQueue", () => {
  it("runs one job at a time by default, in arrival order", async () => {
    const { started, run, finish } = controlledRun();
    const { q } = queue({ run });
    q.enqueue(job(1, "d1"));
    q.enqueue(job(2, "d2"));
    expect(started).toEqual(["d1"]);
    await finish("d1");
    expect(started).toEqual(["d1", "d2"]);
    await finish("d2");
    await q.idle();
  });

  it("a newer push replaces the PR's waiting job; a running one isn't touched", async () => {
    const { started, run, finish } = controlledRun();
    const { q } = queue({ run });
    expect(q.enqueue(job(1, "d1"))).toEqual({ status: "queued" }); // starts
    expect(q.enqueue(job(1, "d2"))).toEqual({ status: "queued" }); // waits behind d1
    expect(q.enqueue(job(1, "d3"))).toEqual({ status: "replaced", replacedDeliveryId: "d2" });
    await finish("d1");
    await finish("d3");
    expect(started).toEqual(["d1", "d3"]);
  });

  it("never reviews the same PR twice at once, even with spare concurrency", async () => {
    const { started, run, finish } = controlledRun();
    const { q } = queue({ run, concurrency: 2 });
    q.enqueue(job(1, "d1"));
    q.enqueue(job(1, "d2"));
    q.enqueue(job(2, "d3"));
    expect(started).toEqual(["d1", "d3"]); // d2 waits for its PR, d3 takes the free slot
    await finish("d1");
    expect(started).toEqual(["d1", "d3", "d2"]);
  });

  it("rejects installations that aren't allowed", () => {
    const { q } = queue({ run: async () => {} });
    expect(q.enqueue(job(1, "d1", 999))).toEqual({
      status: "rejected",
      reason: "installation 999 is not allowed",
    });
  });

  it("skips jobs past the daily cap, and the cap resets at midnight UTC", async () => {
    const clock = { now: Date.UTC(2026, 10, 14, 23, 0) };
    const ran: string[] = [];
    const { q, skipped } = queue({
      run: async (j) => {
        ran.push(j.deliveryId);
      },
      dailyCap: 2,
      now: () => clock.now,
    });
    for (const [n, id] of [
      [1, "d1"],
      [2, "d2"],
      [3, "d3"],
    ] as const) {
      q.enqueue(job(n, id));
      await q.idle();
    }
    expect(ran).toEqual(["d1", "d2"]);
    expect(skipped).toEqual(["d3: daily review cap (2) reached"]);
    clock.now = Date.UTC(2026, 10, 15, 0, 1);
    q.enqueue(job(4, "d4"));
    await q.idle();
    expect(ran).toEqual(["d1", "d2", "d4"]);
  });

  it("a failing job is reported and the queue keeps going", async () => {
    const { started, run, finish } = controlledRun();
    const { q, errors } = queue({ run });
    q.enqueue(job(1, "d1"));
    q.enqueue(job(2, "d2"));
    await finish("d1", new Error("GitHub 502"));
    expect(errors).toEqual(["d1: GitHub 502"]);
    expect(started).toEqual(["d1", "d2"]);
  });
});

describe("parseInstallations", () => {
  it("parses a comma-separated list and refuses an empty or bad one", () => {
    expect(parseInstallations("181424445, 42")).toEqual(new Set([181424445, 42]));
    expect(() => parseInstallations(undefined)).toThrow("ALLOWED_INSTALLATIONS is required");
    expect(() => parseInstallations(" , ")).toThrow("ALLOWED_INSTALLATIONS is required");
    expect(() => parseInstallations("12,abc")).toThrow("non-numeric IDs: abc");
  });
});
