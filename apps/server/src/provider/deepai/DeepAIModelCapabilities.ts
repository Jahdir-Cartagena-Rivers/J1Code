import type { DeepAIModel } from "./DeepAIClient.ts";
import { createModelCapabilities } from "@t3tools/shared/model";

export const DEEPAI_EFFORTS = ["low", "medium", "high"] as const;

/** Pi forwards these portable thinking levels to the selected model transport. */
export function deepAIModelCapabilities(model: DeepAIModel) {
  return createModelCapabilities({
    optionDescriptors: model.reasoning
      ? [
          {
            id: "reasoningEffort",
            label: "Reasoning effort",
            type: "select",
            options: DEEPAI_EFFORTS.map((id) => ({
              id,
              label: id[0]!.toUpperCase() + id.slice(1),
              ...(id === "medium" ? { isDefault: true } : {}),
            })),
          },
        ]
      : [],
  });
}
