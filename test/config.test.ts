import { describe, expect, it } from "vitest";
import { loadConfig, requireLiveConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies defaults and needs no API key", () => {
    const config = loadConfig({});
    expect(config).toEqual({
      DIFFWISE_MAX_STEPS: 20,
      DIFFWISE_TOKEN_BUDGET: 80_000,
      DIFFWISE_TOOL_OUTPUT_MAX_CHARS: 6_000,
    });
  });

  it("coerces numeric strings", () => {
    const config = loadConfig({ DIFFWISE_MAX_STEPS: "5", DIFFWISE_TOKEN_BUDGET: "1000" });
    expect(config.DIFFWISE_MAX_STEPS).toBe(5);
    expect(config.DIFFWISE_TOKEN_BUDGET).toBe(1000);
  });

  it("treats empty strings as unset", () => {
    const config = loadConfig({ ANTHROPIC_API_KEY: "", DIFFWISE_MAX_STEPS: "" });
    expect(config.ANTHROPIC_API_KEY).toBeUndefined();
    expect(config.DIFFWISE_MAX_STEPS).toBe(20);
  });

  it("fails loudly on bad numbers, naming the variable", () => {
    expect(() => loadConfig({ DIFFWISE_MAX_STEPS: "lots" })).toThrow(/DIFFWISE_MAX_STEPS/);
    expect(() => loadConfig({ DIFFWISE_TOKEN_BUDGET: "-1" })).toThrow(/DIFFWISE_TOKEN_BUDGET/);
  });

  it("never echoes values in errors", () => {
    let message = "";
    try {
      loadConfig({ DIFFWISE_MAX_STEPS: "sk-ant-secret" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("DIFFWISE_MAX_STEPS");
    expect(message).not.toContain("sk-ant-secret");
  });
});

describe("requireLiveConfig", () => {
  it("lists every missing live setting", () => {
    expect(() => requireLiveConfig(loadConfig({}))).toThrow(
      "Live mode requires: ANTHROPIC_API_KEY, DIFFWISE_MODEL",
    );
  });

  it("passes when both are set", () => {
    const config = loadConfig({ ANTHROPIC_API_KEY: "k", DIFFWISE_MODEL: "m" });
    expect(requireLiveConfig(config).DIFFWISE_MODEL).toBe("m");
  });
});
