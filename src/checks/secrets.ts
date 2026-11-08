import { addedLines, type Check, type CheckHit } from "./types.js";

interface SecretPattern {
  kind: string;
  regex: RegExp; // global, so one line can hold several matches
  shownPrefix: string; // the public part of the format, safe to print
  valueGroup?: number; // capture group holding the secret when it isn't the whole match
  headerOnly?: boolean; // the match is a marker (BEGIN ... KEY), so its length means nothing
}

const PATTERNS: SecretPattern[] = [
  { kind: "AWS access key ID", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, shownPrefix: "AKIA" },
  {
    kind: "GitHub token",
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g,
    shownPrefix: "gh",
  },
  { kind: "Anthropic API key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, shownPrefix: "sk-ant-" },
  {
    kind: "private key",
    regex: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g,
    shownPrefix: "",
    headerOnly: true,
  },
  {
    kind: "hardcoded password",
    regex: /\b(?:password|passwd|pwd)\s*[:=]\s*(["'])([^"'\s]{4,})\1/gi,
    shownPrefix: "",
    valueGroup: 2,
  },
];

// Docs and examples are full of fake keys; flagging them would teach people to ignore the check.
const PLACEHOLDER =
  /x{4,}|\*{4,}|<[^>]*>|\$\{|example|placeholder|changeme|dummy|redacted|your[-_]/i;

// [HARNESS:GUARD] Redact: say what kind of secret and how long, never the value itself.
// WHY: this message is published as a PR comment, an annotation, a job summary and log lines;
//      quoting the key would re-publish the leak in five more places.
function describe(pattern: SecretPattern, value: string): string {
  if (pattern.headerOnly) return pattern.kind;
  const shown = pattern.shownPrefix ? `${pattern.shownPrefix}…, ` : "";
  return `${pattern.kind} (${shown}${value.length} chars)`;
}

const LOG_CALL = /\b(?:logger|log|console)\s*\.\s*(?:trace|debug|info|warn|error|log|fatal)\s*\(/;
const SENSITIVE_NAME =
  /\b\w*(?:token|secret|password|passwd|authorization|api_?key|credential|cookie)\w*\b/i;
// Strings are the log message, not the data: "auth token refreshed" isn't a leak.
const STRING_LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

// A secret-looking identifier passed to a logger. Name-based, so it errs both ways
// (`tokenCount` is flagged, `log(h)` isn't); the evals measure how often.
function loggedSecret(content: string): string | undefined {
  const call = LOG_CALL.exec(content);
  if (!call) return undefined;
  const args = content.slice(call.index + call[0].length).replace(STRING_LITERAL, '""');
  return SENSITIVE_NAME.exec(args)?.[0];
}

export const secretsCheck: Check = {
  name: "secrets",
  async run({ files }) {
    const hits: CheckHit[] = [];
    for (const { path, line, content } of addedLines(files)) {
      const before = hits.length;
      for (const pattern of PATTERNS) {
        for (const match of content.matchAll(pattern.regex)) {
          const value = match[pattern.valueGroup ?? 0] ?? match[0];
          if (PLACEHOLDER.test(value)) continue;
          hits.push({
            path,
            line,
            message: `Possible secret: ${describe(pattern, value)}. Anything committed stays in git history.`,
            suggestion:
              "Remove it, rotate the credential, and load it from a secret store or env var.",
          });
        }
      }
      if (hits.length > before) continue; // a literal secret on the line already says enough

      const name = loggedSecret(content);
      if (name) {
        hits.push({
          path,
          line,
          message: `\`${name}\` looks like a credential and is passed to a logger. Logs are kept and shipped to other tools, so the value leaks there.`,
          suggestion:
            "Drop the field, or log something safe instead (e.g. whether it was present).",
        });
      }
    }
    return hits;
  },
};
