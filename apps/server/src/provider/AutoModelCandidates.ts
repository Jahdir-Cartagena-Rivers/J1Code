import type { AutoModelPolicy, ModelSelection, ServerProvider } from "@t3tools/contracts";
import type { AutoModelCandidate, AutoModelRef } from "@t3tools/shared/autoModel";

/** Only admin capability declarations and exact live instance descriptors are trusted. */
export function autoModelCandidates(
  policy: Extract<AutoModelPolicy, { mode: "auto" }>,
  providers: readonly ServerProvider[],
): readonly AutoModelCandidate[] {
  return (["fast", "deep"] as const)
    .map((tier) => {
      const selection = policy[tier];
      const matches = providers.filter((entry) => entry.instanceId === selection.instanceId);
      const provider = matches.length === 1 ? matches[0] : undefined;
      const models = provider?.models.filter((entry) => entry.slug === selection.model) ?? [];
      const model = models.length === 1 ? models[0] : undefined;
      const descriptors = model?.capabilities?.optionDescriptors ?? [];
      const options = selection.options ?? [];
      const validOptions =
        new Set(options.map((option) => option.id)).size === options.length &&
        options.every((option) => {
          const descriptor = descriptors.find((entry) => entry.id === option.id);
          return descriptor?.type === "boolean"
            ? typeof option.value === "boolean"
            : descriptor?.type === "select" &&
                descriptor.options.some((entry) => entry.id === option.value);
        });
      const capabilities = policy.capabilities?.[tier];
      return {
        ref: {
          provider: provider?.driver ?? "unknown",
          instanceId: selection.instanceId,
          modelId: selection.model,
          ...(selection.options ? { options: selection.options } : {}),
        },
        available:
          !!provider &&
          provider.enabled &&
          provider.installed &&
          provider.availability !== "unavailable" &&
          provider.status === "ready" &&
          provider.auth.status !== "unauthenticated" &&
          !!model &&
          validOptions,
        tools: capabilities?.tools ?? "unknown",
        images: capabilities?.images ?? "unknown",
        contextWindow: capabilities?.contextWindow ?? "unknown",
      };
    })
    .filter(
      (candidate, index, all) =>
        all.findIndex(
          (entry) =>
            entry.ref.instanceId === candidate.ref.instanceId &&
            entry.ref.modelId === candidate.ref.modelId &&
            entry.tools === candidate.tools &&
            entry.images === candidate.images &&
            entry.contextWindow === candidate.contextWindow &&
            (entry.ref.options?.length ?? 0) === (candidate.ref.options?.length ?? 0) &&
            (entry.ref.options ?? []).every((option) =>
              candidate.ref.options?.some(
                (other) => option.id === other.id && option.value === other.value,
              ),
            ),
        ) === index,
    );
}
export function autoModelSelection(
  ref: AutoModelRef,
  policy: Extract<AutoModelPolicy, { mode: "auto" }>,
): ModelSelection {
  const selection = [policy.fast, policy.deep].find(
    (entry) => entry.instanceId === ref.instanceId && entry.model === ref.modelId,
  );
  if (!selection) throw new Error("Auto selection is outside the configured policy");
  return {
    instanceId: selection.instanceId,
    model: ref.modelId,
    ...(ref.options ? { options: ref.options } : {}),
  };
}
