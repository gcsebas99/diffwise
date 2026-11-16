import type { ReviewJob } from "./webhook.js";

export type Admission =
  | { status: "queued" }
  | { status: "replaced"; replacedDeliveryId: string }
  | { status: "rejected"; reason: string };

export interface JobQueueOptions {
  run: (job: ReviewJob) => Promise<void>;
  concurrency: number;
  dailyCap: number;
  allowedInstallations: ReadonlySet<number>;
  onSkipped?: (job: ReviewJob, reason: string) => void; // 4.5 reports it on the check run
  onError?: (job: ReviewJob, err: unknown) => void;
  now?: () => number; // tests pass a fake clock
}

const prKey = (job: ReviewJob) => `${job.owner}/${job.repo}#${job.number}`;

// "181424445, 42" → {181424445, 42}. Unset or empty fails: an App with no allowlist would
// review (and pay for) any account that installs it.
export function parseInstallations(value: string | undefined): Set<number> {
  const ids = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error("ALLOWED_INSTALLATIONS is required: comma-separated installation IDs");
  }
  const bad = ids.filter((id) => !/^\d+$/.test(id));
  if (bad.length > 0)
    throw new Error(`ALLOWED_INSTALLATIONS has non-numeric IDs: ${bad.join(", ")}`);
  return new Set(ids.map(Number));
}

// [HARNESS:ORCH] In-process review queue: bounded concurrency, one job per PR, a daily cap.
// WHY: webhooks arrive in bursts (a force-push, a rebase of a stack), and each review is a
//      paid model call. One waiting job per PR: a newer push replaces the older job, since only
//      the latest head is worth reviewing. A PR never runs twice at once. The cap bounds spend
//      however many PRs arrive, and the allowlist decides who gets reviewed at all.
export class JobQueue {
  private readonly waiting: ReviewJob[] = [];
  private readonly running = new Set<string>(); // PR keys
  private readonly idleWaiters: (() => void)[] = [];
  private readonly now: () => number;
  private day = "";
  private startedToday = 0;

  constructor(private readonly options: JobQueueOptions) {
    this.now = options.now ?? Date.now;
  }

  enqueue(job: ReviewJob): Admission {
    if (!this.options.allowedInstallations.has(job.installationId)) {
      return { status: "rejected", reason: `installation ${job.installationId} is not allowed` };
    }
    const index = this.waiting.findIndex((w) => prKey(w) === prKey(job));
    const replaced = index >= 0 ? this.waiting.splice(index, 1, job)[0] : undefined;
    if (!replaced) this.waiting.push(job);
    this.pump();
    return replaced
      ? { status: "replaced", replacedDeliveryId: replaced.deliveryId }
      : { status: "queued" };
  }

  // Resolves when nothing is running or waiting: for tests and a graceful shutdown.
  idle(): Promise<void> {
    if (this.running.size === 0 && this.waiting.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  get size(): { waiting: number; running: number } {
    return { waiting: this.waiting.length, running: this.running.size };
  }

  private pump(): void {
    while (this.running.size < this.options.concurrency) {
      // The first waiting job whose PR isn't already being reviewed.
      const index = this.waiting.findIndex((w) => !this.running.has(prKey(w)));
      if (index < 0) break;
      const [job] = this.waiting.splice(index, 1);
      if (!job) break;
      if (!this.takeDailySlot()) {
        this.options.onSkipped?.(job, `daily review cap (${this.options.dailyCap}) reached`);
        continue;
      }
      const key = prKey(job);
      this.running.add(key);
      this.options
        .run(job)
        .catch((err: unknown) => this.options.onError?.(job, err))
        .finally(() => {
          this.running.delete(key);
          this.pump();
        });
    }
    if (this.running.size === 0 && this.waiting.length === 0) {
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  // The cap resets at midnight UTC: one fixed day for every installation.
  private takeDailySlot(): boolean {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.startedToday = 0;
    }
    if (this.startedToday >= this.options.dailyCap) return false;
    this.startedToday += 1;
    return true;
  }
}
