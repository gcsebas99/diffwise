// Local webhook server for trying real deliveries before 4.4 wires in reviews:
// `pnpm app:dev`, then forward your smee channel to http://localhost:$PORT/webhooks/github.
import { serve } from "@hono/node-server";
import { loadConfig } from "../../config.js";
import { createServer, type Log } from "./server.js";
import { DeliveryLog } from "./webhook.js";

const config = loadConfig();
const webhookSecret = config.GITHUB_WEBHOOK_SECRET;
if (!webhookSecret) throw new Error("app:dev requires GITHUB_WEBHOOK_SECRET (see .env.example)");

const log: Log = (message, fields = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), message, ...fields }));

const app = createServer({
  webhookSecret,
  deliveries: new DeliveryLog(),
  enqueue: (job) =>
    log("would review", {
      pr: `${job.owner}/${job.repo}#${job.number}`,
      head: job.headSha.slice(0, 7),
      deliveryId: job.deliveryId,
    }),
  log,
});

serve({ fetch: app.fetch, port: config.PORT }, (info) =>
  log("listening", { url: `http://localhost:${info.port}/webhooks/github` }),
);
