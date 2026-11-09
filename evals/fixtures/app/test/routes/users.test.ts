import assert from "node:assert/strict";
import { test } from "node:test";
import { setup } from "../helpers.ts";

test("POST /users creates a user", async () => {
  const { call } = setup();
  const res = await call("POST", "/users", {
    userId: "admin",
    body: { email: "ada@example.com", name: " Ada " },
  });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { id: "usr_1", email: "ada@example.com", name: "Ada" });
});

test("POST /users rejects a missing email", async () => {
  const { call } = setup();
  const res = await call("POST", "/users", { userId: "admin", body: { name: "Ada" } });
  assert.equal(res.status, 400);
});

test("GET /users/:id returns 404 for unknown users", async () => {
  const { call } = setup();
  const res = await call("GET", "/users/usr_404", { userId: "admin" });
  assert.equal(res.status, 404);
});

test("requests without a token are rejected", async () => {
  const { call } = setup();
  const res = await call("GET", "/users/usr_1");
  assert.equal(res.status, 401);
});
