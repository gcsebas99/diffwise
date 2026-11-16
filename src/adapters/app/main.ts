// The App's entry point: `pnpm app:dev` locally (forward a smee channel to it); in the Docker
// image on Render it runs as the bundled app.mjs.
import { serve } from "@hono/node-server";
import { loadConfig } from "../../config.js";
import { AnthropicModel } from "../../model/anthropic.js";
import { OctokitGitHubClient } from "../github/octokit.js";
import { InstallationTokens, loadAppCredentials } from "./auth.js";
import { JobQueue, parseInstallations } from "./jobs.js";
import { jsonLogger } from "./log.js";
import { type ReviewJobDeps, reportSkipped, runReviewJob } from "./review-job.js";
import { createServer } from "./server.js";
import { DeliveryLog } from "./webhook.js";

const log = jsonLogger();
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

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

const deps: ReviewJobDeps = {
  tokens,
  createGitHub: (token) => new OctokitGitHubClient({ token }),
  config,
  reviewedHeads: new Map(),
  ...(model ? { model } : {}),
};
const queue = new JobQueue({
  concurrency: config.APP_CONCURRENCY,
  dailyCap: config.DAILY_REVIEW_CAP,
  allowedInstallations,
  run: async (job) => {
    const started = Date.now();
    const result = await runReviewJob(job, deps);
    log(`job ${result.status}`, {
      deliveryId: job.deliveryId,
      installationId: job.installationId,
      pr: `${job.owner}/${job.repo}#${job.number}`,
      ...result,
      ms: Date.now() - started,
    });
  },
  onSkipped: (job, reason) => {
    log("job skipped", { deliveryId: job.deliveryId, reason });
    reportSkipped(job, reason, deps).catch((err: unknown) =>
      log(
        "could not report the skip",
        { deliveryId: job.deliveryId, error: errorText(err) },
        "error",
      ),
    );
  },
  onError: (job, err) =>
    log(
      "job failed",
      {
        deliveryId: job.deliveryId,
        installationId: job.installationId,
        pr: `${job.owner}/${job.repo}#${job.number}`,
        error: errorText(err),
      },
      "error",
    ),
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

// 0.0.0.0, not localhost: inside a container, localhost is unreachable from Render's proxy.
const server = serve({ fetch: app.fetch, port: config.PORT, hostname: "0.0.0.0" }, (info) =>
  log("listening", { port: info.port, allowedInstallations: [...allowedInstallations] }),
);

// A bug that escapes every handler: log it as JSON so Render shows why, then exit and let
// Render restart a clean process rather than run on in an unknown state.
process.on("unhandledRejection", (err) => {
  log("unhandled rejection", { error: errorText(err) }, "error");
  process.exit(1);
});

// Render sends SIGTERM before replacing the instance: stop taking webhooks, let running
// reviews finish (up to 25 s, inside Render's 30 s before SIGKILL), then exit. Waiting jobs
// are lost: they already got a 202, so GitHub won't retry them; redeliver from App settings.
process.on("SIGTERM", () => {
  log("shutting down", queue.size);
  server.close();
  const timeout = new Promise((resolve) => setTimeout(resolve, 25_000).unref());
  void Promise.race([queue.idle(), timeout]).then(() => process.exit(0));
});
