import { describe, expect, it } from "vite-plus/test";
import { deepAIBridgeConfig } from "./deepai-driver-config.ts";

describe("J1 DeepAI bot bridge capability", () => {
  it("accepts only an ephemeral loopback capability", () => {
    expect(
      deepAIBridgeConfig({
        OMB_J1_DEEPAI_URL: "http://127.0.0.1:49001/v1",
        OMB_J1_DEEPAI_TOKEN: "a".repeat(43),
      }),
    ).toEqual({ url: "http://127.0.0.1:49001/v1", token: "a".repeat(43) });
  });

  it.each([
    {},
    { OMB_J1_DEEPAI_URL: "https://deepai.org/v1", OMB_J1_DEEPAI_TOKEN: "a".repeat(43) },
    { OMB_J1_DEEPAI_URL: "http://127.0.0.1:49001/v1", OMB_J1_DEEPAI_TOKEN: "short" },
  ])("rejects a missing or non-loopback capability", (environment) => {
    expect(() => deepAIBridgeConfig(environment)).toThrow("J1 DeepAI is unavailable");
  });
});
