import { z } from "zod";

// Env vars arrive as strings; coerce + bound them so a typo fails at startup, not mid-review.
const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

export const ConfigSchema = z.object({
  // Optional: replay mode and tests never touch the real API. Live mode checks for it explicitly.
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  // Never hardcoded; required only for live runs, so optional here.
  DIFFWISE_MODEL: z.string().min(1).optional(),
  DIFFWISE_MAX_STEPS: positiveInt(20),
  DIFFWISE_TOKEN_BUDGET: positiveInt(80_000),
  DIFFWISE_TOOL_OUTPUT_MAX_CHARS: positiveInt(6_000),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat `FOO=` (empty) as unset, which is how .env files usually express "not configured".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ""));
  const result = ConfigSchema.safeParse(cleaned);
  if (!result.success) {
    // Report variable names and problems only. Never echo values: they may be secrets.
    const problems = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return result.data;
}

export function requireLiveConfig(config: Config): Config & {
  ANTHROPIC_API_KEY: string;
  DIFFWISE_MODEL: string;
} {
  const missing = (["ANTHROPIC_API_KEY", "DIFFWISE_MODEL"] as const).filter((k) => !config[k]);
  if (missing.length > 0) {
    throw new Error(`Live mode requires: ${missing.join(", ")} (see .env.example)`);
  }
  return config as Config & { ANTHROPIC_API_KEY: string; DIFFWISE_MODEL: string };
}
