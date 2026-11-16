export type Level = "info" | "error";
export type LogFields = Record<string, unknown>;
export type Log = (message: string, fields?: LogFields, level?: Level) => void;

// Field names that must never carry a value into the logs, whatever a caller passes.
const SECRET_NAME = /token|secret|password|authorization|api_?key|private_?key|credential|jwt/i;

// [HARNESS:OBS] One JSON object per line, with the IDs that tie a review back to its webhook.
// WHY: Render (and any log tool) can filter JSON by field: deliveryId matches GitHub's
//      "Recent deliveries", pr finds every job for a PR, costUsd sums spend. The redaction is
//      a backstop: a later change that logs the wrong object prints "[redacted]", not a key.
// INTERVIEW: "How do you debug an agent in production?" → structured logs keyed by request
//            ID, outcome and cost per run, and secrets redacted by name before anything prints.
export function redact(fields: LogFields): LogFields {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, SECRET_NAME.test(k) ? "[redacted]" : v]),
  );
}

export function jsonLogger(
  write: (line: string) => void = (line) => console.log(line),
  now: () => Date = () => new Date(),
): Log {
  return (message, fields = {}, level = "info") =>
    write(JSON.stringify({ time: now().toISOString(), level, message, ...redact(fields) }));
}
