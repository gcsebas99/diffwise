// The App's entry point: `pnpm app:dev` locally (forward a smee channel to it), Render in 4.6.
import { serve } from "@hono/node-server";
import { loadConfig } from "../../config.js";
import { AnthropicModel } from "../../model/anthropic.js";
import { OctokitGitHubClient } from "../github/octokit.js";
import { InstallationTokens, loadAppCredentials } from "./auth.js";
import { JobQueue, parseInstallations } from "./jobs.js";
import { runReviewJob } from "./review-job.js";
import { createServer, type Log } from "./server.js";
import { DeliveryLog } from "./webhook.js";

const log: Log = (message, fields = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), message, ...fields }));

// Everything is checked before the port opens: a misconfigured App fails at boot, not on a PR.
const config = loadConfig();
const webhookSecret = config.GITHUB_WEBHOOK_SECRET;
if (!webhookSecret) throw new Error("The App requires GITHUB_WEBHOOK_SECRET (see .env.example)");
const allowedInstallations = parseInstallations(config.ALLOWED_INSTALLATIONS);
const tokens = new InstallationTokens({ credentials: await loadAppCredentials(config) });

const { ANTHROPIC_API_KEY: apiKey, DIFFWISE_MODEL: modelName } = config;
const model =
  apiKey && modelName
    ? { name: modelName, client: () => new AnthropicModel({ apiKey, model: modelName }) }
    : undefined;
if (!model) log("no ANTHROPIC_API_KEY or DIFFWISE_MODEL: deterministic checks only");

const reviewedHeads = new Map<string, string>();
const queue = new JobQueue({
  concurrency: config.APP_CONCURRENCY,
  dailyCap: config.DAILY_REVIEW_CAP,
  allowedInstallations,
  run: async (job) => {
    const started = Date.now();
    const result = await runReviewJob(job, {
      tokens,
      createGitHub: (token) => new OctokitGitHubClient({ token }),
      config,
      reviewedHeads,
      ...(model ? { model } : {}),
    });
    log(`job ${result.status}`, {
      deliveryId: job.deliveryId,
      pr: `${job.owner}/${job.repo}#${job.number}`,
      ...result,
      ms: Date.now() - started,
    });
  },
  onSkipped: (job, reason) => log("job skipped", { deliveryId: job.deliveryId, reason }),
  onError: (job, err) =>
    log("job failed", {
      deliveryId: job.deliveryId,
      pr: `${job.owner}/${job.repo}#${job.number}`,
      error: err instanceof Error ? err.message : String(err),
    }),
});

const app = createServer({
  webhookSecret,
  deliveries: new DeliveryLog(),
  enqueue: (job) => {
    const admission = queue.enqueue(job);
    log(`job ${admission.status}`, { deliveryId: job.deliveryId, ...admission, ...queue.size });
  },
  log,
});

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) =>
  log("listening", { port: info.port, allowedInstallations: [...allowedInstallations] }),
);

// Render sends SIGTERM before replacing the instance: stop taking webhooks, let running
// reviews finish (up to 30 s), then exit. Waiting jobs are lost: they already got a 202, so
// GitHub won't retry them; redeliver from the App settings.
process.on("SIGTERM", () => {
  log("shutting down", queue.size);
  server.close();
  const timeout = new Promise((resolve) => setTimeout(resolve, 30_000).unref());
  void Promise.race([queue.idle(), timeout]).then(() => process.exit(0));
});
