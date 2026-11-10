import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { makeDeepAIClient, type DeepAIModel } from "./DeepAIClient.ts";

/** J1 owns admission and approvals; Pi owns the model/tool loop and transcript. */
export async function createDeepAIAgent(input: {
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly sessionFile?: string;
  readonly apiKey: string;
  readonly client?: ReturnType<typeof makeDeepAIClient>;
  readonly models: ReadonlyArray<DeepAIModel>;
  readonly modelId: string;
  readonly systemPrompt: string;
  readonly authorize: (tool: string, args: unknown, signal: AbortSignal) => Promise<boolean>;
  readonly onEvent: (event: AgentSessionEvent) => void;
  readonly mcp?: { readonly endpoint: string; readonly authorizationHeader: string };
}) {
  // SEA can load file-backed ESM through require, but not package imports.
  // Pi exports only an import condition, so resolve its package location first.
  const packageFile = NodeModule.findPackageJSON(
    "@earendil-works/pi-coding-agent",
    import.meta.url,
  );
  if (!packageFile) throw new Error("The bundled Pi runtime is missing.");
  const {
    createAgentSession,
    createMcpExtension,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
  } = NodeModule.createRequire(import.meta.url)(
    NodePath.join(NodePath.dirname(packageFile), "dist", "index.js"),
  ) as typeof import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create({
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async (_provider, update) => update(undefined),
      delete: async () => {},
    },
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const client = input.client ?? makeDeepAIClient();
  runtime.registerProvider("deepai", {
    name: "DeepAI",
    baseUrl: "https://api.deepai.org/deepai_code",
    api: "openai-completions",
    apiKey: input.apiKey,
    authHeader: false,
    headers: { "Api-Key": input.apiKey, ...client.headers },
    models: input.models.map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api ?? "openai-completions",
      reasoning: model.reasoning,
      input: [...model.input],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false },
    })),
  });
  const model = runtime.getModel("deepai", input.modelId);
  if (!model) throw new Error("The selected DeepAI model is unavailable.");
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
  });
  const controller = new AbortController();
  const loader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    systemPrompt: input.systemPrompt,
    extensionFactories: [
      ...(input.mcp
        ? [
            createMcpExtension({
              loadConfig: () => ({
                servers: [
                  {
                    name: "t3",
                    scope: "extension",
                    source: "j1",
                    config: {
                      url: input.mcp!.endpoint,
                      headers: { Authorization: input.mcp!.authorizationHeader },
                      exposure: "direct",
                    },
                  },
                ],
                errors: [],
              }),
            }),
          ]
        : []),
      (api) => {
        api.on("tool_call", async (event) => {
          const allowed = await input.authorize(event.toolName, event.input, controller.signal);
          if (!allowed) return { block: true, reason: "J1 denied this action." };
          return undefined;
        });
      },
    ],
  });
  await loader.reload();
  const manager = input.sessionFile
    ? SessionManager.open(input.sessionFile, input.sessionDir, input.cwd)
    : SessionManager.create(input.cwd, input.sessionDir);
  const { session } = await createAgentSession({
    cwd: input.cwd,
    agentDir: input.agentDir,
    modelRuntime: runtime,
    model,
    settingsManager,
    sessionManager: manager,
    resourceLoader: loader,
  });
  // Extension hook errors are observational in Pi, so enforce admission at the
  // actual stream boundary instead of a before-provider extension callback.
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = async (model, context, options) => {
    const allowance = await client.allowance(input.apiKey, options?.signal ?? controller.signal);
    if (!allowance.enabled) throw new Error("DeepAI is not enabled for this account.");
    return stream(model, context, options);
  };
  const unsubscribe = session.subscribe(input.onEvent);
  try {
    await session.bindExtensions({});
  } catch (error) {
    unsubscribe();
    session.dispose();
    throw error;
  }
  return {
    session,
    sessionFile: manager.getSessionFile(),
    async stop() {
      controller.abort();
      await session.abort();
      unsubscribe();
      session.dispose();
    },
  };
}
