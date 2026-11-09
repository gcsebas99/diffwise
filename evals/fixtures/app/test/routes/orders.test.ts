import assert from "node:assert/strict";
import { test } from "node:test";
import { setup } from "../helpers.ts";

test("POST /orders creates a pending order for the caller", async () => {
  const { call } = setup();
  const res = await call("POST", "/orders", { userId: "usr_1", body: { totalCents: 1299 } });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { id: "ord_1", userId: "usr_1", totalCents: 1299, status: "pending" });
});

test("POST /orders rejects non-positive totals", async () => {
  const { call } = setup();
  const res = await call("POST", "/orders", { userId: "usr_1", body: { totalCents: 0 } });
  assert.equal(res.status, 400);
});

test("GET /orders only returns the caller's orders", async () => {
  const { call } = setup();
  await call("POST", "/orders", { userId: "usr_1", body: { totalCents: 100 } });
  await call("POST", "/orders", { userId: "usr_2", body: { totalCents: 200 } });
  const res = await call("GET", "/orders", { userId: "usr_1" });
  assert.equal(res.status, 200);
  assert.equal((res.body as { orders: unknown[] }).orders.length, 1);
});

test("GET /health is public", async () => {
  const { call } = setup();
  const res = await call("GET", "/health");
  assert.equal(res.status, 200);
});
