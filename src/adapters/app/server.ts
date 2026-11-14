import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  type DeliveryLog,
  PullRequestEventSchema,
  REVIEWED_ACTIONS,
  type ReviewJob,
  toReviewJob,
  verifySignature,
} from "./webhook.js";

export type Log = (message: string, fields?: Record<string, unknown>) => void;

export interface ServerOptions {
  webhookSecret: string;
  deliveries: DeliveryLog;
  enqueue: (job: ReviewJob) => void; // must not block: the review runs after we reply
  log?: Log;
}

// PR payloads are tens of KB; GitHub's own cap is 25 MB. Reject big bodies before hashing them.
const MAX_BODY_BYTES = 1024 * 1024;
const reviewed: ReadonlySet<string> = new Set(REVIEWED_ACTIONS);

export function createServer(options: ServerOptions): Hono {
  const log = options.log ?? (() => {});
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.post(
    "/webhooks/github",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: "body too large" }, 413),
    }),
    async (c) => {
      const deliveryId = c.req.header("X-GitHub-Delivery");
      const event = c.req.header("X-GitHub-Event");
      const raw = new Uint8Array(await c.req.arrayBuffer());

      // Logged with the delivery ID only: never the secret, the received or expected signature.
      if (!verifySignature(options.webhookSecret, raw, c.req.header("X-Hub-Signature-256"))) {
        log("webhook rejected: bad signature", { deliveryId });
        return c.json({ error: "invalid signature" }, 401);
      }
      if (!deliveryId) return c.json({ error: "missing X-GitHub-Delivery" }, 400);
      // ping (sent when the webhook is created) and any other event: acknowledged, not handled.
      if (event !== "pull_request") return c.body(null, 204);

      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        return c.json({ error: "body is not JSON" }, 400);
      }
      const action = (payload as { action?: unknown })?.action;
      if (typeof action !== "string" || !reviewed.has(action)) return c.body(null, 204);
      const parsed = PullRequestEventSchema.safeParse(payload);
      if (!parsed.success) {
        const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
        log("webhook rejected: unexpected payload", { deliveryId, fields });
        return c.json({ error: "unexpected payload", fields }, 400);
      }

      if (!options.deliveries.firstTime(deliveryId)) {
        log("webhook duplicate", { deliveryId });
        return c.json({ duplicate: true }, 200);
      }

      // [GH:WEBHOOK] Acknowledge in milliseconds, review afterwards: 202 Accepted.
      // WHY: GitHub waits 10 seconds for a reply, then marks the delivery failed; a review takes
      //      5-60 seconds. The tradeoff: once we've said 202, GitHub won't retry, so a crash
      //      mid-review loses it (redeliver by hand; a durable queue fixes that).
      // INTERVIEW: "Why 202 before the work?" → webhook timeouts; then ask what happens if the
      //            process dies after the 202 (lost job, stuck check) and how you'd recover.
      const job = toReviewJob(deliveryId, parsed.data);
      options.enqueue(job);
      log("webhook accepted", {
        deliveryId,
        installationId: job.installationId,
        pr: `${job.owner}/${job.repo}#${job.number}`,
        action,
      });
      return c.json({ accepted: true }, 202);
    },
  );

  return app;
}
