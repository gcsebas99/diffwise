import type { Router } from "../router.ts";

export function registerHealthRoutes(router: Router): void {
  router.get("/health", () => ({ status: 200, body: { ok: true } }));
}
