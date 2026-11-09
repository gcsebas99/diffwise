import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { HarnessError, type ModelRequest, type ModelResponse } from "./types.js";

// One recorded model call: the request as hashed (kept to explain a miss) and the response.
export interface CassetteEntry {
  hash: string;
  request: unknown;
  response: ModelResponse;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// Sorted keys at every level, so the same content always serializes to the same bytes.
function canonical(value: unknown): Json {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonical(v)]));
  }
  return value as Json;
}

// [HARNESS:EVAL] Normalize a request before hashing: canonical key order, tool ids renumbered.
// WHY: tool_use ids are random per API call ("toolu_01Ab…"); without renumbering, the same
//      conversation recorded twice would never hash the same. Everything the model actually
//      reads (system, messages, tools, model) stays in, so any real change still misses.
export function normalizeRequest(model: string, request: ModelRequest): Json {
  const ids = new Map<string, string>();
  const renumber = (id: string) => {
    const known = ids.get(id);
    if (known) return known;
    const next = `toolu_${ids.size}`;
    ids.set(id, next);
    return next;
  };
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      const isToolId =
        typeof v === "string" &&
        (key === "tool_use_id" ||
          (key === "id" && (value as { type?: unknown }).type === "tool_use"));
      out[key] = isToolId ? renumber(v) : walk(v);
    }
    return out;
  };
  return canonical({ model, ...(walk(request) as ModelRequest) });
}

export function requestHash(normalized: Json): string {
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}

export async function readCassette(path: string): Promise<CassetteEntry[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new HarnessError(`No cassette at ${path}. Record one first with --mode record.`);
  }
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CassetteEntry);
}

// A recording starts from an empty file, so two runs never end up mixed in one cassette.
export async function clearCassette(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "");
}

// Appends one line per call, so a run that crashes halfway keeps what it already recorded.
export async function appendEntry(path: string, entry: CassetteEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`);
}

// Where two normalized requests first differ, e.g. `system[0].text, char 1840: "…old…" vs "…new…"`.
// Turns "cassette miss" into "you changed the rule text", which is what a reader needs to act.
export function firstDifference(a: unknown, b: unknown, path = "request"): string | undefined {
  if (typeof a === "string" && typeof b === "string") {
    if (a === b) return undefined;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const snippet = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 20), i + 20));
    return `${path}, char ${i}: ${snippet(a)} vs ${snippet(b)}`;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const diff = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return a.length === b.length ? undefined : `${path}: ${a.length} items vs ${b.length}`;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
      const diff = firstDifference(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
      if (diff) return diff;
    }
    return undefined;
  }
  return a === b ? undefined : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}
