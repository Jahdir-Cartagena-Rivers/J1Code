import { recoverDeepAIImageHistory } from "./DeepAIImageHistory.ts";
import type { NativeComputerDescriptor } from "../../mausbot/NativeComputer.ts";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeStringDecoder from "node:string_decoder";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { makeDeepAIClient, type DeepAIModel } from "./DeepAIClient.ts";
import { CommandJobs, type CommandJobResult } from "./CommandJobs.ts";

/** J1 owns admission and approvals; Pi owns the model/tool loop and transcript. */
export async function createDeepAIAgent(input: {
  readonly computer?: NativeComputerDescriptor;
  readonly interpretToolImages?: (
    question: string,
    images: ReadonlyArray<{ data: string; mimeType: string }>,
    signal?: AbortSignal,
  ) => Promise<string>;
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
  readonly onCommandJob?: (job: CommandJobResult, backgrounded: boolean) => void;
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
    createBashToolDefinition,
    createLocalBashOperations,
    createPowerShellToolDefinition,
    createLocalPowerShellOperations,
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
  const jobs = new CommandJobs({
    signal: controller.signal,
    onChange: (job) => input.onCommandJob?.(job, false),
    onBackgrounded: (job) => input.onCommandJob?.(job, true),
  });
  const loader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    systemPrompt: input.systemPrompt,
    extensionFactories: [
      ...(input.mcp || input.computer
        ? [
            createMcpExtension({
              loadConfig: () => ({
                servers: [
                  ...(input.computer
                    ? [
                        {
                          name: "j1-desktop",
                          scope: "extension" as const,
                          source: "j1",
                          config: {
                            command: input.computer.mcpCommand,
                            args: input.computer.mcpArgs,
                            env: input.computer.mcpEnv,
                            exposure: "direct" as const,
                          },
                        },
                      ]
                    : []),
                  ...(input.mcp
                    ? [
                        {
                          name: "t3",
                          scope: "extension" as const,
                          source: "j1",
                          config: {
                            url: input.mcp!.endpoint,
                            headers: { Authorization: input.mcp!.authorizationHeader },
                            exposure: "direct" as const,
                          },
                        },
                      ]
                    : []),
                ],
                errors: [],
              }),
            }),
          ]
        : []),
      (api) => {
        const shells = [
          [createBashToolDefinition(input.cwd), createLocalBashOperations()],
          [createPowerShellToolDefinition(input.cwd), createLocalPowerShellOperations()],
        ] as const;
        for (const [shell, operations] of shells) {
          const { outputSchema: _output, promptGuidelines: _guidelines, ...definition } = shell;
          api.registerTool({
            ...definition,
            description: `Execute a ${shell.name} command in the current working directory. Returns JSON with state, exitCode, output (bounded tail), elapsed time and an owned job ID. Commands still running after 10 seconds continue in this session. Inspect/wait with command_status; never resubmit a running command. Optional timeout in seconds.`,
            async execute(_id, params, signal) {
              signal?.throwIfAborted();
              const result = await jobs.start(
                `${shell.name}: ${params.command}`,
                async (signal, output) => {
                  const decoder = new NodeStringDecoder.StringDecoder("utf8");
                  const { exitCode } = await operations.exec(params.command, input.cwd, {
                    signal,
                    onData: (data) => output(decoder.write(data)),
                    ...(params.timeout === undefined ? {} : { timeout: params.timeout }),
                  });
                  return { output: decoder.end(), exitCode: exitCode ?? 1 };
                },
              );
              if (result.state === "failed" || result.state === "cancelled")
                throw new Error(JSON.stringify(result));
              return {
                content: [{ type: "text", text: JSON.stringify(result) }],
                details: undefined,
              };
            },
          });
        }
        const parameters = {
          type: "object",
          properties: {
            jobId: { type: "string" },
            waitSeconds: {
              type: "number",
              minimum: 0,
              maximum: 20,
              description: "Seconds to wait, default 20. Use 0 for an immediate snapshot.",
            },
          },
          required: ["jobId"],
          additionalProperties: false,
        } as const;
        api.registerTool({
          name: "command_status",
          label: "Command status",
          description:
            "Inspect an owned shell job. Wait up to 20 seconds for its completion receipt. Running is not success. Reuse its ID; do not restart or repeatedly poll a quiet job.",
          parameters,
          async execute(_id, params) {
            const result = await jobs.wait(
              params.jobId,
              Math.min(20, Math.max(0, params.waitSeconds ?? 20)) * 1000,
            );
            input.onCommandJob?.(result, false);
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
          },
        });
        api.registerTool({
          name: "command_cancel",
          label: "Cancel command",
          description:
            "Request cancellation of one shell job owned by this session. Wait for its terminal status to confirm it stopped.",
          parameters: { ...parameters, properties: { jobId: parameters.properties.jobId } },
          async execute(_id, params) {
            return {
              content: [{ type: "text", text: JSON.stringify(jobs.cancel(params.jobId)) }],
              details: {},
            };
          },
        });
        api.on("tool_result", async (event) => {
          const images = event.content.filter((part) => part.type === "image");
          if (!images.length || !input.interpretToolImages) return;
          try {
            const report = await input.interpretToolImages(
              "Describe the visual result of " + event.toolName,
              images,
              controller.signal,
            );
            return {
              content: [
                ...event.content.filter((part) => part.type !== "image"),
                { type: "text" as const, text: report },
              ],
            };
          } catch {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "The tool returned an image, but the configured vision interpreter failed. Do not claim to have seen it.",
                },
              ],
              isError: true,
            };
          }
        });
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
  const transformContext = session.agent.transformContext;
  session.agent.transformContext = async (messages, signal) =>
    recoverDeepAIImageHistory(
      transformContext ? await transformContext(messages, signal) : messages,
    );
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
    await jobs.dispose();
    unsubscribe();
    session.dispose();
    throw error;
  }
  return {
    session,
    sessionFile: manager.getSessionFile(),
    interruptCommands() {
      jobs.cancelAll();
    },
    checkpoint() {
      const messages = [...session.messages];
      const leaf = manager.getLeafId();
      return () => {
        if (leaf) manager.branch(leaf);
        else manager.resetLeaf();
        session.agent.state.messages = messages;
      };
    },
    async stop() {
      controller.abort();
      await jobs.dispose();
      await session.abort();
      try {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        unsubscribe();
        session.dispose();
      }
    },
  };
}
