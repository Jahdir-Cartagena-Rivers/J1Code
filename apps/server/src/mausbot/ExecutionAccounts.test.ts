import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@j1code/contracts";
import { nativeDefaultAccount, sharedModelOptions } from "./ExecutionAccounts.ts";
const provider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
} as ServerProvider;
describe("native account compatibility", () => {
  it("uses each provider's real option names and refuses unsupported effort or variants", () => {
    expect(sharedModelOptions(provider, "model", "high")).toEqual([
      { id: "reasoningEffort", value: "high" },
    ]);
    expect(
      sharedModelOptions(
        { ...provider, driver: ProviderDriverKind.make("claudeAgent") },
        "model",
        "high",
      ),
    ).toEqual([{ id: "effort", value: "high" }]);
    expect(() =>
      sharedModelOptions(
        { ...provider, driver: ProviderDriverKind.make("cursor") },
        "model",
        "high",
      ),
    ).toThrow("effort");
    expect(() => sharedModelOptions(provider, "model", undefined, "unknown")).toThrow("variant");
  });
  it("identifies only the unchanged default account without exposing its configuration", () => {
    const entry = {
      driver: provider.driver,
      config: { binaryPath: "codex", homePath: "", shadowHomePath: "", setupMode: "existing" },
    };
    expect(nativeDefaultAccount(provider, entry)).toBe("codex");
    for (const modified of [
      { ...entry, environment: [{ name: "OPENAI_API_KEY", value: "private", sensitive: true }] },
      { ...entry, config: { homePath: "C:/another-account" } },
      { ...entry, config: { binaryPath: "another-cli" } },
      { ...entry, config: { endpoint: "other" } },
    ])
      expect(nativeDefaultAccount(provider, modified as ProviderInstanceConfig)).toBeUndefined();
    expect(
      nativeDefaultAccount({ ...provider, instanceId: ProviderInstanceId.make("work") }, entry),
    ).toBeUndefined();
    expect(nativeDefaultAccount({ ...provider, enabled: false }, entry)).toBeUndefined();
  });
});
