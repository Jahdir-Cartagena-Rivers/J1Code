import type { InstanceConfigMap, ModelSelection } from "./contracts.ts";
import type { SharedCatalogRow } from "./drivers/j1-shared-client.ts";

export const encodeSharedModel = (instanceId: string, model: string) =>
  `${encodeURIComponent(instanceId)}:${encodeURIComponent(model)}`;

/** Keep custom accounts, models, native restrictions and their cursors untouched. */
export function sharedSelection(
  selection: ModelSelection,
  configs: InstanceConfigMap,
  catalog: readonly SharedCatalogRow[],
  mode?: string,
  scope?: { allow?: string[]; deny?: string[] },
): ModelSelection {
  if (
    selection.instanceId === "j1-shared" ||
    selection.variant ||
    mode === "custom" ||
    [...(scope?.allow ?? []), ...(scope?.deny ?? [])].some((key) => key.startsWith("native:"))
  )
    return selection;
  const entry = configs[selection.instanceId];
  const defaultId: Record<string, string> = { codex: "codex", claudeAgent: "claude" };
  if (
    !entry ||
    entry.enabled === false ||
    selection.instanceId !== defaultId[entry.driver] ||
    Object.keys(entry.environment ?? {}).length
  )
    return selection;
  if (
    entry.config !== undefined &&
    (!entry.config || typeof entry.config !== "object" || Array.isArray(entry.config))
  )
    return selection;
  const raw = (entry.config ?? {}) as Record<string, unknown>;
  const safe: Record<string, readonly string[]> = {
    codex: ["cli", "fullAuto"],
    claudeAgent: ["cli", "permissionMode"],
  };
  const keys = safe[entry.driver];
  const binary: Record<string, string> = { codex: "codex", claudeAgent: "claude" };
  if (
    !keys ||
    Object.keys(raw).some((key) => !keys.includes(key)) ||
    (raw.cli && raw.cli !== binary[entry.driver])
  )
    return selection;
  const account = catalog.find(
    (row) =>
      row.nativeDefault === entry.driver &&
      row.enabled &&
      row.installed &&
      row.models.some((model) => model.slug === selection.model),
  );
  return account
    ? {
        ...selection,
        instanceId: "j1-shared",
        model: encodeSharedModel(account.instanceId, selection.model),
      }
    : selection;
}

export function sharedAccountLinks(
  configs: InstanceConfigMap,
  catalog: readonly SharedCatalogRow[],
) {
  return Object.entries(configs).flatMap(([nativeId, entry]) => {
    const account = catalog.find((row) => row.nativeDefault === entry.driver && row.models.length);
    if (!account) return [];
    const before = { instanceId: nativeId, model: account.models[0]!.slug };
    return sharedSelection(before, configs, catalog) === before
      ? []
      : [{ nativeId, accountId: account.instanceId }];
  });
}
