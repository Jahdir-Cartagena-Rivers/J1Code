import type {
  ProviderInstanceConfig,
  ProviderOptionSelection,
  ServerProvider,
} from "@j1code/contracts";

/** Only an unchanged default account can move without asking someone to select an account. */
export function nativeDefaultAccount(
  provider: ServerProvider,
  entry: ProviderInstanceConfig | undefined,
) {
  if (!entry || !provider.enabled || !provider.installed || entry.environment?.length)
    return undefined;
  if (String(provider.instanceId) !== String(provider.driver) || entry.driver !== provider.driver)
    return undefined;
  const defaults: Record<string, { binary: string; keys: readonly string[] }> = {
    codex: {
      binary: "codex",
      keys: [
        "enabled",
        "binaryPath",
        "homePath",
        "shadowHomePath",
        "setupMode",
        "launchArgs",
        "customModels",
      ],
    },
    claudeAgent: {
      binary: "claude",
      keys: [
        "enabled",
        "binaryPath",
        "homePath",
        "launchArgs",
        "customModels",
        "autoCompactWindow",
      ],
    },
  };
  const spec = defaults[provider.driver];
  if (!spec) return undefined;
  const raw = entry.config ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const config = raw as Record<string, unknown>;
  if (Object.keys(config).some((key) => !spec.keys.includes(key))) return undefined;
  if (config.binaryPath && config.binaryPath !== spec.binary) return undefined;
  if (config.homePath || config.shadowHomePath || config.launchArgs || config.autoCompactWindow)
    return undefined;
  return provider.driver;
}

export function sharedModelOptions(
  provider: ServerProvider,
  model: string,
  effort?: string,
  variant?: string,
): ProviderOptionSelection[] {
  const descriptors = provider.models?.find((row) => row.slug === model)?.capabilities
    ?.optionDescriptors;
  const result: ProviderOptionSelection[] = [];
  if (effort) {
    const key = provider.driver === "claudeAgent" ? "effort" : "reasoningEffort";
    const descriptor = descriptors?.find((option) => option.id === key && option.type === "select");
    if (
      descriptor?.type === "select"
        ? !descriptor.options.some((option) => option.id === effort)
        : !["codex", "grok", "claudeAgent"].includes(provider.driver)
    )
      throw new Error(
        "The selected shared model does not support this effort. Select its default effort or a supported level.",
      );
    result.push({ id: key, value: effort });
  }
  if (variant) {
    const descriptor = descriptors?.find(
      (option) => option.id === "variant" && option.type === "select",
    );
    if (
      descriptor?.type !== "select" ||
      !descriptor.options.some((option) => option.id === variant)
    )
      throw new Error("Select a supported variant from this shared model's catalog.");
    result.push({ id: "variant", value: variant });
  }
  return result;
}
