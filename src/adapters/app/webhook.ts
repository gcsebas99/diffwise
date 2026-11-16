import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// [GH:WEBHOOK] Verify X-Hub-Signature-256: HMAC-SHA256 of the raw bytes, constant-time compare.
// WHY: the URL is public, so anyone can POST a fake "PR opened"; only GitHub knows the secret.
//      The HMAC covers the exact bytes sent: JSON.parse + stringify changes spacing and escapes,
//      so verify before parsing. `===` stops at the first differing char, and timing that
//      lets an attacker guess a valid signature byte by byte; timingSafeEqual always reads all.
export function verifySignature(
  secret: string,
  rawBody: Uint8Array,
  header: string | undefined,
): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
  );
  const received = Buffer.from(header);
  // timingSafeEqual throws on different lengths; the length of a hex digest isn't a secret.
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export const REVIEWED_ACTIONS = ["opened", "synchronize", "reopened"] as const;

// Only the fields the review uses. Everything else in the payload is ignored, not trusted.
export const PullRequestEventSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable(),
    head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
    base: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
  }),
  repository: z.object({
    name: z.string().min(1),
    owner: z.object({ login: z.string().min(1) }),
  }),
  installation: z.object({ id: z.number().int().positive() }),
});

export interface ReviewJob {
  deliveryId: string;
  installationId: number;
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  baseSha: string;
  title: string;
  body: string;
}

export function toReviewJob(
  deliveryId: string,
  event: z.infer<typeof PullRequestEventSchema>,
): ReviewJob {
  const pr = event.pull_request;
  return {
    deliveryId,
    installationId: event.installation.id,
    owner: event.repository.owner.login,
    repo: event.repository.name,
    number: pr.number,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    title: pr.title,
    body: pr.body ?? "",
  };
}

export interface DeliveryLogOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number; // tests pass a fake clock
}

// [GH:WEBHOOK] Idempotency on X-GitHub-Delivery: a redelivery is the same event, not a new one.
// WHY: GitHub retries and humans hit "Redeliver"; both reuse the delivery ID, and without this
//      each one is another paid review and another comment on the PR.
//      In memory: a restart forgets, so a redelivery after a restart reviews again. Redis (or
//      any shared store with TTL) fixes that, and is needed once there are two instances.
export class DeliveryLog {
  private readonly seen = new Map<string, number>(); // id → expiry; Map keeps insertion order
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: DeliveryLogOptions = {}) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60_000;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  // true the first time an ID is offered within the TTL; false for a repeat.
  firstTime(id: string): boolean {
    const now = this.now();
    const expiry = this.seen.get(id);
    if (expiry !== undefined && expiry > now) return false;
    this.seen.delete(id); // re-insert at the end so eviction order stays oldest-first
    this.seen.set(id, now + this.ttlMs);
    this.evict(now);
    return true;
  }

  private evict(now: number): void {
    for (const [id, expiry] of this.seen) {
      if (expiry > now && this.seen.size <= this.maxEntries) break;
      this.seen.delete(id);
    }
  }
}
