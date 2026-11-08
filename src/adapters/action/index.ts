import * as core from "@actions/core";
import { AnthropicModel } from "../../model/anthropic.js";
import { OctokitGitHubClient } from "../github/octokit.js";
import { readActionContext } from "./context.js";
import { type ActionIO, run } from "./main.js";

// The action's entry point: real @actions/core, Anthropic and Octokit, nothing else.
// Everything worth testing is in main.ts; this file only connects it to the runner.
const io: ActionIO = {
  getInput: (name) => core.getInput(name),
  info: (message) => core.info(message),
  warning: (message, annotation) => core.warning(message, annotation),
  error: (message, annotation) => core.error(message, annotation),
  setSecret: (value) => core.setSecret(value),
  setOutput: (name, value) => core.setOutput(name, value),
  setFailed: (message) => core.setFailed(message),
  // Appends to the file in GITHUB_STEP_SUMMARY: the markdown shown on the run's summary page.
  writeSummary: async (markdown) => {
    await core.summary.addRaw(markdown, true).write();
  },
};

await run(io, {
  readContext: () => readActionContext(process.env),
  createModel: (apiKey, model) => new AnthropicModel({ apiKey, model }),
  createGitHub: (token) =>
    new OctokitGitHubClient({
      token,
      // GITHUB_API_URL points at GitHub Enterprise Server when the action runs there.
      ...(process.env.GITHUB_API_URL ? { baseUrl: process.env.GITHUB_API_URL } : {}),
    }),
  env: process.env,
});
