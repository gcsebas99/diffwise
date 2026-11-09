import type { Db } from "../db.ts";
import type { Router } from "../router.ts";

export function registerUserRoutes(router: Router, db: Db): void {
  router.get("/users/:id", (req) => {
    const user = db.users.get(req.params.id ?? "");
    if (!user) return { status: 404, body: { error: "user not found" } };
    return { status: 200, body: user };
  });

  router.post("/users", (req) => {
    const input = req.body as { email?: unknown; name?: unknown } | undefined;
    if (typeof input?.email !== "string" || !input.email.includes("@")) {
      return { status: 400, body: { error: "email is required" } };
    }
    if (typeof input.name !== "string" || input.name.trim() === "") {
      return { status: 400, body: { error: "name is required" } };
    }
    const user = { id: db.nextId("usr"), email: input.email, name: input.name.trim() };
    db.users.set(user.id, user);
    return { status: 201, body: user };
  });
}
