import { describe, expect, it } from "vite-plus/test";
import { deepAIModelCapabilities } from "./DeepAIModelCapabilities.ts";
const model = {
  id: "fixture",
  name: "Fixture",
  reasoning: true,
  input: ["text"] as const,
  contextWindow: 4096,
  maxTokens: 512,
};
describe("DeepAI capability discovery", () => {
  it("advertises portable effort choices only for reasoning models", () => {
    expect(deepAIModelCapabilities(model).optionDescriptors?.[0]).toMatchObject({
      id: "reasoningEffort",
      options: [{ id: "low" }, { id: "medium" }, { id: "high" }],
    });
    expect(deepAIModelCapabilities({ ...model, reasoning: false }).optionDescriptors).toEqual([]);
  });
});
