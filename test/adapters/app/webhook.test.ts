import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DeliveryLog, verifySignature } from "../../../src/adapters/app/webhook.js";

const SECRET = "test-webhook-secret";
const body = Buffer.from('{"action":"opened"}');
const sign = (bytes: Uint8Array, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}`;

describe("verifySignature", () => {
  it("accepts GitHub's signature of the exact bytes", () => {
    expect(verifySignature(SECRET, body, sign(body))).toBe(true);
  });

  it("rejects a tampered body, a wrong secret, or a missing header", () => {
    expect(verifySignature(SECRET, Buffer.from('{"action":"closed"}'), sign(body))).toBe(false);
    expect(verifySignature(SECRET, body, sign(body, "other-secret"))).toBe(false);
    expect(verifySignature(SECRET, body, undefined)).toBe(false);
  });

  it("the same JSON re-serialized is different bytes, so it fails", () => {
    const reformatted = Buffer.from(JSON.stringify(JSON.parse('{ "action": "opened" }')));
    const original = Buffer.from('{ "action": "opened" }');
    expect(verifySignature(SECRET, reformatted, sign(original))).toBe(false);
  });

  it("a wrong-length or SHA-1 signature is rejected, not thrown", () => {
    expect(verifySignature(SECRET, body, "sha256=abc")).toBe(false);
    const sha1 = `sha1=${createHmac("sha1", SECRET).update(body).digest("hex")}`;
    expect(verifySignature(SECRET, body, sha1)).toBe(false);
  });
});

describe("DeliveryLog", () => {
  it("remembers a delivery ID until its TTL passes", () => {
    const clock = { now: 0 };
    const log = new DeliveryLog({ ttlMs: 1000, now: () => clock.now });
    expect(log.firstTime("a")).toBe(true);
    expect(log.firstTime("a")).toBe(false);
    clock.now = 999;
    expect(log.firstTime("a")).toBe(false);
    clock.now = 1000;
    expect(log.firstTime("a")).toBe(true);
  });

  it("drops the oldest IDs past maxEntries, so memory stays bounded", () => {
    const log = new DeliveryLog({ maxEntries: 2 });
    log.firstTime("a");
    log.firstTime("b");
    log.firstTime("c"); // evicts a
    expect(log.firstTime("b")).toBe(false);
    expect(log.firstTime("c")).toBe(false);
    expect(log.firstTime("a")).toBe(true);
  });
});
