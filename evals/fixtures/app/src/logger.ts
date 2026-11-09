type Level = "debug" | "info" | "warn" | "error";

function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  if (process.env.NODE_ENV === "test") return;
  console.log(JSON.stringify({ level, message, time: new Date().toISOString(), ...fields }));
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => log("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => log("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => log("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => log("error", message, fields),
};
