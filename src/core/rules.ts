import { readFile } from "node:fs/promises";
import picomatch from "picomatch";
import { parse, YAMLParseError } from "yaml";
import { z } from "zod";

// Phase 3 replaces this list with the deterministic checks registry.
export const DETERMINISTIC_CHECKS = ["secrets", "env-documented"] as const;
export type DeterministicCheck = (typeof DETERMINISTIC_CHECKS)[number];

export type RuleCheck = { kind: "llm" } | { kind: "deterministic"; name: DeterministicCheck };

const DETERMINISTIC_PREFIX = "deterministic:";

// Parse "llm" | "deterministic:<name>" into a tagged union, so callers switch on `kind`
// instead of re-parsing strings. Unknown names fail here, not when the check would run.
const CheckSchema = z.string().transform((value, ctx): RuleCheck => {
  if (value === "llm") return { kind: "llm" };
  if (value.startsWith(DETERMINISTIC_PREFIX)) {
    const name = value.slice(DETERMINISTIC_PREFIX.length);
    if ((DETERMINISTIC_CHECKS as readonly string[]).includes(name)) {
      return { kind: "deterministic", name: name as DeterministicCheck };
    }
    ctx.addIssue({
      code: "custom",
      input: value,
      message: `unknown deterministic check '${name}', expected one of ${DETERMINISTIC_CHECKS.join("|")}`,
    });
    return z.NEVER;
  }
  ctx.addIssue({
    code: "custom",
    input: value,
    message: `unknown check '${value}', expected llm|deterministic:<name>`,
  });
  return z.NEVER;
});

const RuleSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be kebab-case, e.g. route-needs-test"),
    title: z.string().trim().min(1),
    severity: z.enum(["blocking", "advisory"]),
    applies_to: z.array(z.string().min(1)).min(1),
    check: CheckSchema,
    instructions: z.string().trim().min(1).optional(),
  })
  .superRefine((rule, ctx) => {
    if (rule.check.kind === "llm" && !rule.instructions) {
      ctx.addIssue({
        code: "custom",
        path: ["instructions"],
        message: "is required when check is llm (it tells the reviewer what to look for)",
      });
    }
  });

export const RulesFileSchema = z
  .strictObject({
    version: z.literal(1),
    rules: z.array(RuleSchema).min(1),
  })
  .superRefine((file, ctx) => {
    // Finding ids are keyed by rule id; a duplicate would make findings ambiguous.
    const seen = new Set<string>();
    file.rules.forEach((rule, i) => {
      if (seen.has(rule.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["rules", i, "id"],
          message: `duplicate id '${rule.id}'`,
        });
      }
      seen.add(rule.id);
    });
  });

export type Rule = z.infer<typeof RuleSchema>;
export type Severity = Rule["severity"];

export class RulesError extends Error {
  readonly source: string;
  readonly problems: string[];

  constructor(source: string, problems: string[]) {
    super(`Problems in rules file ${source}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "RulesError";
    this.source = source;
    this.problems = problems;
  }
}

const show = (value: unknown) => (typeof value === "string" ? `'${value}'` : String(value));
const isPrimitive = (value: unknown) => value === null || typeof value !== "object";

// One actionable line per issue: "rule 'x': severity: expected blocking|advisory, got 'high'".
function formatIssue(issue: z.core.$ZodIssue, raw: unknown): string {
  const [first, index, ...rest] = issue.path;
  let label = "";
  let fieldPath = issue.path;
  if (first === "rules" && typeof index === "number") {
    // Authors think in rule ids, not array positions; fall back to the index if id is missing.
    const id = (raw as { rules?: { id?: unknown }[] }).rules?.[index]?.id;
    label = typeof id === "string" ? `rule '${id}'` : `rules[${index}]`;
    fieldPath = rest;
  }
  const field = fieldPath.map(String).join(".");

  let detail: string;
  if (issue.code === "invalid_value") {
    detail = `${field}: expected ${issue.values.map(String).join("|")}, got ${show(issue.input)}`;
  } else if (issue.code === "unrecognized_keys") {
    detail = `unknown key ${issue.keys.map((k) => `'${k}'`).join(", ")}`;
  } else if (issue.code === "invalid_type" && issue.input === undefined) {
    detail = `${field}: is required`;
  } else {
    const got =
      issue.code !== "custom" && isPrimitive(issue.input) ? ` (got ${show(issue.input)})` : "";
    detail = `${field ? `${field}: ` : ""}${issue.message}${got}`;
  }
  return label ? `${label}: ${detail}` : detail;
}

export function parseRules(text: string, source = "<inline>"): RuleSet {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    if (err instanceof YAMLParseError) {
      // The first line already carries "at line N, column M".
      const where = err.message.split("\n")[0]?.replace(/:$/, "");
      throw new RulesError(source, [`YAML syntax error: ${where}`]);
    }
    throw err;
  }
  if (raw == null) throw new RulesError(source, ["file is empty"]);

  // [HARNESS:GUARD] Validate the rules file at the boundary and fail loudly, listing every problem.
  // WHY: it's external input from the target repo, and a bad rule can't be fixed mid-review.
  //      Stop before any model call, with errors the author can act on.
  // INTERVIEW: "Config errors vs tool errors?" → config: fail fast at startup (a human fixes it);
  //            tool args: return the error to the model (it can correct itself in the loop).
  const result = RulesFileSchema.safeParse(raw, { reportInput: true });
  if (!result.success) {
    throw new RulesError(
      source,
      result.error.issues.map((issue) => formatIssue(issue, raw)),
    );
  }
  return createRuleSet(result.data.rules);
}

export async function loadRules(path: string): Promise<RuleSet> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RulesError(path, ["file not found; add .review-rules.yaml at the repo root"]);
    }
    throw err;
  }
  return parseRules(text, path);
}

export interface RuleSet {
  readonly rules: readonly Rule[];
  // Keyed by rule id (unique, enforced by the schema). Compiled once at load time.
  readonly matchers: ReadonlyMap<string, (path: string) => boolean>;
}

export function createRuleSet(rules: readonly Rule[]): RuleSet {
  // dot: true so "**/*" also covers dotfiles like .env.example and .github/; without it
  // picomatch skips them and no-secrets-in-diff would silently miss them.
  const matchers = new Map(
    rules.map((rule) => [rule.id, picomatch([...rule.applies_to], { dot: true })] as const),
  );
  return { rules, matchers };
}

// `path` is repo-relative with forward slashes, as git reports it.
export function rulesForFile(ruleSet: RuleSet, path: string): Rule[] {
  // A leading "./" (easy for a model to send as a tool argument) would match nothing.
  const normalized = path.replace(/^\.\//, "");
  return ruleSet.rules.filter((rule) => ruleSet.matchers.get(rule.id)?.(normalized) === true);
}
