import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createServer } from "../../../src/adapters/app/server.js";
import { DeliveryLog, type ReviewJob } from "../../../src/adapters/app/webhook.js";

const SECRET = "test-webhook-secret";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const prEvent = (action = "opened") => ({
  action,
  number: 7,
  pull_request: {
    number: 7,
    title: "Filter orders by status",
    body: null,
    head: { sha: HEAD },
    base: { sha: BASE },
  },
  repository: { name: "diffwise-demo", owner: { login: "gcsebas99" } },
  installation: { id: 181424445 },
  sender: { login: "someone" }, // extra fields are ignored
});

function setup() {
  const jobs: ReviewJob[] = [];
  const logs: { message: string; fields: Record<string, unknown> }[] = [];
  const app = createServer({
    webhookSecret: SECRET,
    deliveries: new DeliveryLog(),
    enqueue: (job) => jobs.push(job),
    log: (message, fields = {}) => logs.push({ message, fields }),
  });
  const deliver = (
    payload: unknown,
    opts: { event?: string; id?: string; signature?: string | null; raw?: string } = {},
  ) => {
    const raw = opts.raw ?? JSON.stringify(payload);
    const signature =
      opts.signature === undefined
        ? `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`
        : opts.signature;
    return app.request("/webhooks/github", {
      method: "POST",
      body: raw,
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": opts.event ?? "pull_request",
        "X-GitHub-Delivery": opts.id ?? "delivery-1",
        ...(signature === null ? {} : { "X-Hub-Signature-256": signature }),
      },
    });
  };
  return { app, jobs, logs, deliver };
}

describe("POST /webhooks/github", () => {
  it("a signed PR event is acknowledged with 202 and queued once", async () => {
    const { jobs, deliver } = setup();
    const res = await deliver(prEvent());
    expect(res.status).toBe(202);
    expect(jobs).toEqual([
      {
        deliveryId: "delivery-1",
        installationId: 181424445,
        owner: "gcsebas99",
        repo: "diffwise-demo",
        number: 7,
        headSha: HEAD,
        baseSha: BASE,
        title: "Filter orders by status",
        body: "",
      },
    ]);
  });

  it("a tampered body or a missing signature gets 401, logged without the secret", async () => {
    const { jobs, logs, deliver } = setup();
    const signed = JSON.stringify(prEvent());
    const sig = `sha256=${createHmac("sha256", SECRET).update(signed).digest("hex")}`;
    const tampered = await deliver(null, {
      raw: signed.replace("opened", "reopened"),
      signature: sig,
    });
    expect(tampered.status).toBe(401);
    expect((await deliver(prEvent(), { signature: null })).status).toBe(401);
    expect(jobs).toHaveLength(0);
    expect(logs.map((l) => l.message)).toEqual([
      "webhook rejected: bad signature",
      "webhook rejected: bad signature",
    ]);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    expect(JSON.stringify(logs)).not.toContain(sig);
  });

  it("a redelivery (same delivery ID) gets 200 and isn't queued again", async () => {
    const { jobs, deliver } = setup();
    await deliver(prEvent());
    const again = await deliver(prEvent());
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ duplicate: true });
    expect(jobs).toHaveLength(1);
    expect((await deliver(prEvent("synchronize"), { id: "delivery-2" })).status).toBe(202);
    expect(jobs).toHaveLength(2);
  });

  it("other events and other PR actions get 204 and nothing is queued", async () => {
    const { jobs, deliver } = setup();
    expect((await deliver({ zen: "Keep it simple." }, { event: "ping" })).status).toBe(204);
    expect((await deliver({ action: "opened" }, { event: "issues" })).status).toBe(204);
    expect((await deliver(prEvent("closed"))).status).toBe(204);
    expect((await deliver(prEvent("labeled"))).status).toBe(204);
    expect(jobs).toHaveLength(0);
  });

  it("a signed body that isn't the expected payload gets 400, naming fields only", async () => {
    const { jobs, deliver } = setup();
    expect((await deliver(null, { raw: "not json" })).status).toBe(400);
    const { installation: _, ...noInstallation } = prEvent();
    const res = await deliver(noInstallation);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unexpected payload", fields: ["installation"] });
    expect(jobs).toHaveLength(0);
  });

  it("a body over 1 MB is refused with 413 before it's verified", async () => {
    const { deliver } = setup();
    const res = await deliver(null, { raw: "x".repeat(1024 * 1024 + 1), signature: "sha256=00" });
    expect(res.status).toBe(413);
  });
});

describe("GET /healthz", () => {
  it("returns 200", async () => {
    const res = await setup().app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
