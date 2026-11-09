import { createServer } from "node:http";
import { createApp } from "./app.ts";
import { logger } from "./logger.ts";
import { toNodeHandler } from "./router.ts";

const port = Number(process.env.PORT ?? 3000);
const secret = process.env.AUTH_SECRET;
if (!secret) throw new Error("AUTH_SECRET is required (see .env.example)");

const { router } = createApp(secret);

createServer((req, res) => {
  toNodeHandler(router, req, res).catch((err: unknown) => {
    logger.error("request failed", { error: String(err) });
    res.writeHead(500).end();
  });
}).listen(port, () => logger.info("listening", { port }));
