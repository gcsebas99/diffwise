import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "./logger.ts";
import type { Middleware } from "./router.ts";

const PUBLIC_PATHS = new Set(["/health"]);

// Tokens are "<userId>.<hmac(userId)>" signed with AUTH_SECRET. Good enough for a demo.
export function signToken(userId: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(userId).digest("hex");
  return `${userId}.${sig}`;
}

export function verifyToken(token: string, secret: string): string | undefined {
  const [userId, sig] = token.split(".");
  if (!userId || !sig) return undefined;
  const expected = Buffer.from(signToken(userId, secret).split(".")[1] ?? "", "hex");
  const actual = Buffer.from(sig, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  return userId;
}

export function requireAuth(secret: string): Middleware {
  return (req) => {
    if (PUBLIC_PATHS.has(req.path)) return undefined;

    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const userId = token ? verifyToken(token, secret) : undefined;
    if (!userId) {
      logger.warn("auth rejected", { path: req.path });
      return { status: 401, body: { error: "unauthorized" } };
    }
    req.user = { id: userId };
    return undefined;
  };
}
