// Copied into the captured OSS runtime as server/drivers/j1-deepai.ts.
// The bearer is a short-lived parent capability, not a DeepAI account credential.
import type { ProviderDriver } from "../contracts.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { deepAIBridgeConfig } from "../j1/deepai-driver-config.ts";

const bridge = () => deepAIBridgeConfig();

async function bridgeCatalogReady(url: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/models`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return false;
    const payload: unknown = await response.json();
    return Boolean(
      payload &&
      typeof payload === "object" &&
      "data" in payload &&
      Array.isArray(payload.data) &&
      payload.data.some(
        (model) =>
          model &&
          typeof model === "object" &&
          "id" in model &&
          typeof model.id === "string" &&
          model.id,
      ),
    );
  } catch {
    return false;
  }
}

export const J1DeepAIDriver: ProviderDriver<Record<string, never>> = {
  driverKind: "j1-deepai",
  metadata: { displayName: "DeepAI", supportsMultipleInstances: false, access: "subscription" },
  models: { default: "", options: [] },
  decodeConfig(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length)
      throw new Error("J1 DeepAI has no saved bot configuration.");
    return {};
  },
  defaultConfig: () => ({}),
  async create(input) {
    const { url, token } = bridge();
    const instance = await OpenAICompatDriver.create({
      ...input,
      config: OpenAICompatDriver.decodeConfig({
        url,
        apiKeyEnv: "OMB_J1_DEEPAI_TOKEN",
      }),
      environment: { ...input.environment, OMB_J1_DEEPAI_TOKEN: token },
    });
    return {
      ...instance,
      driverKind: "j1-deepai",
      snapshot: async () => {
        if (!(await bridgeCatalogReady(url, token))) {
          return {
            state: "unavailable",
            authenticated: false,
            reason: "J1 DeepAI is unavailable. Connect the parent server, then refresh providers.",
          };
        }
        const snapshot = await instance.snapshot();
        return { ...snapshot, driverKind: "j1-deepai" };
      },
    };
  },
};
