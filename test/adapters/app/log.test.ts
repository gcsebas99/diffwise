import { describe, expect, it } from "vitest";
import { jsonLogger, redact } from "../../../src/adapters/app/log.js";

describe("jsonLogger", () => {
  it("writes one JSON object per line with time, level and fields", () => {
    const lines: string[] = [];
    const log = jsonLogger(
      (line) => lines.push(line),
      () => new Date("2026-11-15T12:00:00Z"),
    );
    log("job reviewed", { deliveryId: "d1", pr: "o/r#7", costUsd: 0.0006 });
    log("job failed", { deliveryId: "d2" }, "error");
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      {
        time: "2026-11-15T12:00:00.000Z",
        level: "info",
        message: "job reviewed",
        deliveryId: "d1",
        pr: "o/r#7",
        costUsd: 0.0006,
      },
      { time: "2026-11-15T12:00:00.000Z", level: "error", message: "job failed", deliveryId: "d2" },
    ]);
  });
});

describe("redact", () => {
  it("blanks any field whose name looks secret, whatever its value", () => {
    expect(
      redact({
        token: "ghs_x",
        webhookSecret: "s",
        ANTHROPIC_API_KEY: "sk-ant-x",
        apiKey: "k",
        Authorization: "Bearer x",
        privateKey: "-----BEGIN",
        jwt: "e.y.z",
        deliveryId: "d1",
        installationId: 42,
        costUsd: 0.001,
      }),
    ).toEqual({
      token: "[redacted]",
      webhookSecret: "[redacted]",
      ANTHROPIC_API_KEY: "[redacted]",
      apiKey: "[redacted]",
      Authorization: "[redacted]",
      privateKey: "[redacted]",
      jwt: "[redacted]",
      deliveryId: "d1",
      installationId: 42,
      costUsd: 0.001,
    });
  });
});
