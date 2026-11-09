import { createApp } from "../src/app.ts";
import { signToken } from "../src/auth.ts";

export const SECRET = "test-secret";

export function setup() {
  const { router, db } = createApp(SECRET);
  const call = (method: string, path: string, opts: { body?: unknown; userId?: string } = {}) => {
    const url = new URL(path, "http://localhost");
    return router.handle({
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: opts.userId ? { authorization: `Bearer ${signToken(opts.userId, SECRET)}` } : {},
      body: opts.body,
    });
  };
  return { db, call };
}
