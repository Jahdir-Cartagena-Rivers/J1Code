import { hashTelemetryId as hashUtf8Sha256 } from "@j1code/shared/telemetryId";
import {
  MessageId, NodeId, ProviderDriverKind, ProviderThreadId, ProviderTurnId, RuntimeRequestId, TurnItemId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession, type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn, type OrchestrationV2RuntimeRequest,
  type ProviderInstanceId, type ThreadId,
} from "@j1code/contracts";
import { layerSecureRandom } from "@effect/platform-node/NodeCrypto";
import * as Adapter from "@j1code/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@j1code/provider-core/server/failure";
import { getModelSelectionStringOptionValue } from "@j1code/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as McpProviderSessions from "@j1code/provider-core/server/McpProviderSessions";
import type { McpProviderSessionConfig } from "@j1code/provider-core/server/mcpSession";
import { readNativeComputerDescriptor } from "../../mausbot/NativeComputer.ts";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { ProviderSessionRuntimeRepositoryError } from "../../persistence/Errors.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import { withDeepAIInvocation } from "./DeepAIMcpInvocation.ts";
import { DEEPAI_EFFORTS } from "./DeepAIModelCapabilities.ts";
import { isDeepAIImageRejection } from "./DeepAIImageHistory.ts";
import type { createDeepAIAgent } from "./DeepAIAgent.ts";
import type { makeDeepAIClient, DeepAIModel } from "./DeepAIClient.ts";

const provider = ProviderDriverKind.make("deepai");
type SdkAgent = Awaited<ReturnType<typeof createDeepAIAgent>>;
type Agent = Omit<SdkAgent, "session"> & {
  readonly session: Pick<SdkAgent["session"],
    "getAvailableThinkingLevels" | "setThinkingLevel" | "messages" | "prompt" | "abort">;
};
const encodeAttachmentString = Schema.encodeEffect(Schema.fromJsonString(Schema.String));
type ActiveTurn = {
  readonly input: Adapter.ProviderAdapterV2TurnInput;
  readonly turn: OrchestrationV2ProviderTurn;
  readonly controller: AbortController;
  cancelled: boolean;
  finished: boolean;
  text: string;
  reasoning: string;
  nextOrdinal: number;
  readonly tools: Map<string, { ordinal: number; name: string }>;
};

// The session owns the turn until its terminal event. Stop must still be able
// to abort SDK work after the Effect that starts the turn has returned.
function createActiveTurn(input: Adapter.ProviderAdapterV2TurnInput, turn: OrchestrationV2ProviderTurn): ActiveTurn {
  return {
    input, turn, controller: new AbortController(),
    cancelled: false, finished: false, text: "", reasoning: "",
    nextOrdinal: input.providerTurnOrdinal * 100 + 3, tools: new Map(),
  };
}

const capabilities = {
  runtimePolicy: { enforcement: "native" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: false,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "none",
    nativeRequestIds: "none",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export const makeDeepAIAdapter = Effect.fn("makeDeepAIAdapter")(function* (options: {
  instanceId: ProviderInstanceId;
  directory: string;
  attachmentsDir?: string;
  visionLabel?: string;
  describeImages?: (
    question: string,
    images: ReadonlyArray<{ data: string; mimeType: string }>,
    signal?: AbortSignal,
  ) => Promise<string>;
  credentials: () => Promise<string>;
  client?: ReturnType<typeof makeDeepAIClient>;
  catalog: () => Promise<{ models: ReadonlyArray<DeepAIModel>; default: string }>;
  createAgent?: (input: Parameters<typeof createDeepAIAgent>[0]) => Promise<Agent>;
  legacyHistory?: (threadId: ThreadId) => Effect.Effect<{
    threadId: ThreadId;
    providerName: string;
    providerInstanceId: ProviderInstanceId | null;
    sessionFile: string;
  } | undefined, ProviderSessionRuntimeRepositoryError>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const mcpSessions = yield* Effect.serviceOption(McpProviderSessions.McpProviderSessions);
  const random = yield* SecureRandom.SecureRandom.pipe(Effect.provide(layerSecureRandom));
  const owners = new Set<string>();
  const run = Effect.runPromiseWith(yield* Effect.context<never>());
  const failure = (detail: string) => new Adapter.ProviderAdapterProtocolError({ driver: provider, detail });
  const allowedPolicy = (policy: Adapter.ProviderAdapterV2RuntimePolicy) =>
    policy.interactionMode === "default" && policy.nativeToolPolicy === undefined;
  const task = <A>(detail: string, work: () => Promise<A>) =>
    Effect.tryPromise({ try: work, catch: () => failure(detail) });

  return Adapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: provider,
    getCapabilities: Effect.fn("DeepAIAdapter.getCapabilities")(() => Effect.succeed(capabilities)),
    planSelectionTransition: Effect.fn("DeepAIAdapter.planSelectionTransition")(({ current, target }) =>
      Effect.succeed(current.model === target.model
        ? { type: "apply_on_next_turn" }
        : { type: "reject", reason: "DeepAI requires a new thread to change models." })),
    openSession: Effect.fn("DeepAIAdapter.openSession")(function* (open) {
      if (open.modelSelection.instanceId !== options.instanceId || !allowedPolicy(open.runtimePolicy))
        return yield* failure("DeepAI does not support this account or runtime policy");
      const scope = yield* Effect.scope;
      const queue = yield* Queue.unbounded<Adapter.ProviderAdapterV2Event>();
      const emit = (event: Adapter.ProviderAdapterV2Event) => Queue.offer(queue, event);
      const now = yield* DateTime.now;
      const session: OrchestrationV2ProviderSession = {
        id: open.providerSessionId, driver: provider, providerInstanceId: options.instanceId,
        status: "ready", model: open.modelSelection.model, cwd: open.runtimePolicy.cwd ?? process.cwd(),
        capabilities, createdAt: now, updatedAt: now, lastError: null,
      };
      let loaded: {
        thread: OrchestrationV2ProviderThread;
        agent: Agent;
        model: DeepAIModel;
        mcp: McpProviderSessionConfig | undefined;
      } | undefined;
      let active: ActiveTurn | undefined;
      let opening = false;
      let closed = false;
      const requests = new Map<RuntimeRequestId, (allowed: boolean) => void>();
      const jobs = new Map<string, ActiveTurn>();
      const nativeDirectory = paths.join(options.directory,
        hashUtf8Sha256(open.threadId));
      const owns = (thread: OrchestrationV2ProviderThread) =>
        thread.appThreadId === open.threadId && thread.driver === provider &&
        thread.providerInstanceId === options.instanceId;
      const matches = (thread: OrchestrationV2ProviderThread) =>
        owns(thread) && loaded?.thread.id === thread.id &&
        loaded.thread.nativeThreadRef?.nativeId === thread.nativeThreadRef?.nativeId;

      const publishText = Effect.fn("DeepAIAdapter.publishText")(function* (
        turn: ActiveTurn, streaming: boolean,
      ) {
        if (closed || active !== turn || (streaming && turn.finished)) return;
        const time = yield* DateTime.now;
        if (closed || active !== turn || (streaming && turn.finished)) return;
        const base = {
          threadId: turn.input.threadId, runId: turn.input.runId, nodeId: turn.input.rootNodeId,
          providerThreadId: turn.turn.providerThreadId, providerTurnId: turn.turn.id,
          nativeItemRef: null, parentItemId: null, startedAt: turn.turn.startedAt,
          updatedAt: time, completedAt: streaming ? null : time,
          status: streaming ? "running" as const : turn.cancelled ? "interrupted" as const : "completed" as const,
          title: null,
        };
        const messageId = MessageId.make(`${turn.turn.id}:assistant`);
        yield* emit({ type: "message.updated", driver: provider, message: {
          id: messageId, threadId: base.threadId, runId: base.runId, nodeId: base.nodeId,
          role: "assistant", text: turn.text, attachments: [], streaming,
          createdAt: base.startedAt!, updatedAt: time, createdBy: "agent", creationSource: "provider",
        } });
        yield* emit({ type: "turn_item.updated", driver: provider, turnItem: {
          ...base, id: TurnItemId.make(`${turn.turn.id}:assistant`), type: "assistant_message", messageId,
          ordinal: turn.input.providerTurnOrdinal * 100 + 1, text: turn.text, streaming,
        } });
        if (turn.reasoning) yield* emit({ type: "turn_item.updated", driver: provider, turnItem: {
          ...base, id: TurnItemId.make(`${turn.turn.id}:reasoning`), type: "reasoning",
          ordinal: turn.input.providerTurnOrdinal * 100 + 2, text: turn.reasoning, streaming,
        } });
      });

      const authorize = async (tool: string, _args: unknown, signal: AbortSignal) => {
        const turn = active;
        if (closed || !turn || turn.cancelled || signal.aborted) return false;
        const policy = turn.input.runtimePolicy;
        if (!allowedPolicy(policy)) return false;
        if (tool === "command_status") return true;
        if (policy.runtimeMode === "full-access" &&
            policy.approvalPolicy === undefined && policy.sandboxPolicy === undefined) return true;
        // An approval cannot override an independent sandbox or administrator constraint.
        if (policy.sandboxPolicy !== undefined) return false;
        const id = RuntimeRequestId.make(await run(random.uuidV4()));
        const nodeId = NodeId.make(`${id}:node`);
        const kind = tool === "read" ? "file-read" as const :
          tool === "edit" || tool === "write" ? "file-change" as const : "command" as const;
        const createdAt = await run(DateTime.now);
        if (closed || active !== turn || turn.cancelled || signal.aborted) return false;
        const request: OrchestrationV2RuntimeRequest = {
          id, nodeId, providerTurnId: turn.turn.id, nativeRequestRef: null, kind, status: "pending",
          responseCapability: { type: "live", providerSessionId: open.providerSessionId },
          createdAt, resolvedAt: null,
        };
        return new Promise<boolean>((resolve) => {
          const finish = (accept: boolean) => {
            requests.delete(id);
            signal.removeEventListener("abort", abort);
            resolve(accept && active === turn && !turn.cancelled && !closed);
          };
          const abort = () => finish(false);
          requests.set(id, finish);
          signal.addEventListener("abort", abort, { once: true });
          const ordinal = turn.nextOrdinal++;
          void run(Effect.gen(function* () {
            yield* emit({ type: "node.updated", driver: provider, node: {
              id: nodeId, threadId: turn.input.threadId, runId: turn.input.runId,
              parentNodeId: turn.input.rootNodeId, rootNodeId: turn.input.rootNodeId,
              kind: "approval_request", status: "waiting", countsForRun: false,
              providerThreadId: turn.turn.providerThreadId, providerTurnId: turn.turn.id,
              nativeItemRef: null, runtimeRequestId: id, checkpointScopeId: null,
              startedAt: createdAt, completedAt: null,
            } });
            yield* emit({ type: "runtime_request.updated", driver: provider, threadId: turn.input.threadId, runtimeRequest: request });
            yield* emit({ type: "turn_item.updated", driver: provider, turnItem: {
              id: TurnItemId.make(`${id}:approval`), type: "approval_request", requestId: id,
              requestKind: kind, threadId: turn.input.threadId, runId: turn.input.runId,
              nodeId, providerThreadId: turn.turn.providerThreadId, providerTurnId: turn.turn.id,
              nativeItemRef: null, parentItemId: null, ordinal, status: "waiting",
              title: `DeepAI requests ${tool}`, startedAt: createdAt, updatedAt: createdAt, completedAt: null,
            } });
          })).catch(abort);
        });
      };

      const load = Effect.fn("DeepAIAdapter.load")(function* (
        previous?: OrchestrationV2ProviderThread,
        sessionFile?: string,
        restoreLegacy = false,
      ) {
        if (closed || opening || loaded || owners.has(open.threadId) ||
            (previous !== undefined && !owns(previous)))
          return yield* failure("DeepAI session already owns a thread or the requested thread is foreign");
        opening = true;
        owners.add(open.threadId);
        return yield* Effect.gen(function* () {
          const legacy = sessionFile === undefined && restoreLegacy && options.legacyHistory
            ? yield* options.legacyHistory(open.threadId).pipe(
                Effect.mapError(() => failure("DeepAI could not verify its saved history")),
              )
            : undefined;
          if (legacy && (legacy.threadId !== open.threadId || legacy.providerName !== provider ||
              legacy.providerInstanceId !== options.instanceId))
            return yield* failure("DeepAI history belongs to another thread or account");
          const file = sessionFile ?? legacy?.sessionFile;
          const source = file === undefined ? undefined : yield* fs.realPath(file).pipe(
            Effect.filterOrFail((resolved) => paths.dirname(resolved) === paths.resolve(nativeDirectory),
              () => failure("DeepAI history belongs to another thread or account")),
            Effect.mapError(() => failure("DeepAI history is unavailable or belongs to another thread")),
          );
          const catalog = yield* task("DeepAI catalog is unavailable", options.catalog);
          const model = catalog.models.find((candidate) => candidate.id === open.modelSelection.model);
          if (!model) return yield* failure("Selected DeepAI model is unavailable");
          const apiKey = yield* task("Sign in to DeepAI on this server first", options.credentials);
          const credential = Option.isSome(mcpSessions)
            ? yield* mcpSessions.value.read(open.threadId)
            : undefined;
          const mcp = credential?.threadId === open.threadId &&
            credential.providerInstanceId === options.instanceId ? credential : undefined;
          const computer = readNativeComputerDescriptor();
          const agent = yield* task("DeepAI could not open its conversation", async () => {
            const create = options.createAgent ?? (await import("./DeepAIAgent.ts")).createDeepAIAgent;
            return create({
              ...(options.client ? { client: options.client } : {}),
              cwd: open.runtimePolicy.cwd ?? process.cwd(), sessionDir: nativeDirectory,
              agentDir: paths.join(nativeDirectory, "config"), ...(source ? { sessionFile: source } : {}),
              apiKey, modelId: model.id, models: catalog.models,
              ...(options.describeImages ? { interpretToolImages: options.describeImages } : {}),
              systemPrompt: buildRuntimeInstructions({ harness: "DeepAI", model: model.id }),
              authorize,
              ...(mcp === undefined ? {} : { mcp }),
              ...(computer ? { computer } : {}),
              onCommandJob: (job, backgrounded) => {
                const owner = jobs.get(job.id) ?? active;
                if (!owner || closed) return;
                if (backgrounded && job.state === "running") {
                  if (!jobs.has(job.id)) {
                    jobs.set(job.id, owner);
                    void run(emit({ type: "background_work.updated", driver: provider,
                      providerTurnId: owner.turn.id, pending: true })).catch(() => {});
                  }
                } else if (jobs.delete(job.id) && ![...jobs.values()].includes(owner)) {
                  void run(emit({ type: "background_work.updated", driver: provider,
                    providerTurnId: owner.turn.id, pending: false })).catch(() => {});
                }
              },
              onEvent: (event) => {
                const turn = active;
                if (!turn || turn.cancelled || turn.finished || closed) return;
                if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
                  const started = event.type === "tool_execution_start";
                  const tool = turn.tools.get(event.toolCallId) ?? {
                    ordinal: turn.nextOrdinal++, name: event.toolName,
                  };
                  turn.tools.set(event.toolCallId, tool);
                  void run(Effect.gen(function* () {
                    if (closed || active !== turn || turn.cancelled) return;
                    const time = yield* DateTime.now;
                    yield* emit({ type: "turn_item.updated", driver: provider, turnItem: {
                      id: TurnItemId.make(`${turn.turn.id}:tool:${event.toolCallId}`),
                      threadId: turn.input.threadId, runId: turn.input.runId, nodeId: turn.input.rootNodeId,
                      providerThreadId: turn.turn.providerThreadId, providerTurnId: turn.turn.id,
                      nativeItemRef: null, parentItemId: null, ordinal: tool.ordinal, title: null,
                      type: "dynamic_tool", toolName: tool.name, input: null,
                      status: started ? "running" : event.isError ? "failed" : "completed",
                      startedAt: turn.turn.startedAt, completedAt: started ? null : time, updatedAt: time,
                    } });
                  })).catch(() => {});
                  return;
                }
                if (event.type !== "message_update") return;
                const delta = event.assistantMessageEvent;
                if (delta.type !== "text_delta" && delta.type !== "thinking_delta") return;
                if (delta.type === "text_delta") turn.text += delta.delta;
                else turn.reasoning += delta.delta;
                void run(publishText(turn, true)).catch(() => {});
              },
            });
          });
          const nativeId = agent.sessionFile;
          if (closed || !nativeId || paths.dirname(paths.resolve(nativeId)) !== paths.resolve(nativeDirectory) ||
              (source !== undefined && paths.resolve(nativeId) !== source)) {
            yield* task("DeepAI could not close its conversation", () => agent.stop()).pipe(Effect.ignore);
            return yield* failure("DeepAI did not reopen the owned conversation");
          }
          const thread: OrchestrationV2ProviderThread = {
            id: previous?.id ?? ProviderThreadId.make(`deepai:${hashUtf8Sha256(nativeId)}`),
            appThreadId: open.threadId, providerSessionId: open.providerSessionId,
            providerInstanceId: options.instanceId, driver: provider, ownerNodeId: null,
            nativeThreadRef: { driver: provider, nativeId, strength: "strong" },
            nativeConversationHeadRef: null, status: "idle", firstRunOrdinal: previous?.firstRunOrdinal ?? null,
            lastRunOrdinal: previous?.lastRunOrdinal ?? null, handoffIds: previous?.handoffIds ?? [],
            forkedFrom: previous?.forkedFrom ?? null, createdAt: previous?.createdAt ?? now,
            updatedAt: yield* DateTime.now,
          };
          loaded = { thread, agent, model, mcp };
          return thread;
        }).pipe(Effect.ensuring(Effect.sync(() => {
          opening = false;
          if (!loaded) owners.delete(open.threadId);
        })));
      });

      const stop = () => {
        if (active) {
          active.cancelled = true;
          active.controller.abort();
        }
        for (const finish of requests.values()) finish(false);
        loaded?.agent.interruptCommands();
      };
      yield* Effect.addFinalizer(() => Effect.gen(function* () {
        closed = true;
        stop();
        if (loaded) {
          yield* task("DeepAI could not close its conversation", () => loaded!.agent.stop()).pipe(
            Effect.ignore,
            Effect.ensuring(Effect.sync(() => { owners.delete(open.threadId); })),
          );
        }
        yield* Queue.shutdown(queue);
      }));
      const unsupported = () => Effect.fail(failure("This operation is not supported by DeepAI"));
      return {
        instanceId: options.instanceId, driver: provider, providerSessionId: open.providerSessionId,
        providerSession: session, canResumeAfterRestart: false,
        events: Stream.fromQueue(queue), backgroundTasksEndWithProcess: true,
        hasPendingBackgroundWork: Effect.sync(() => jobs.size > 0),
        ensureThread: (input) =>
          input.threadId !== open.threadId || input.modelSelection.instanceId !== options.instanceId ||
          input.modelSelection.model !== open.modelSelection.model || !allowedPolicy(input.runtimePolicy) ||
          input.runtimePolicy.cwd !== open.runtimePolicy.cwd
            ? unsupported()
            : loaded && !input.forceNewNativeThread && (!input.existingProviderThread || matches(input.existingProviderThread))
              ? Effect.succeed(loaded.thread)
              : load(input.existingProviderThread,
                  input.forceNewNativeThread ? undefined : input.existingProviderThread?.nativeThreadRef?.nativeId ?? open.initialNativeThreadId,
                  !input.forceNewNativeThread && input.existingProviderThread?.nativeThreadRef == null),
        resumeThread: ({ threadId, providerThread, modelSelection, runtimePolicy }) =>
          (threadId !== undefined && threadId !== open.threadId) || !owns(providerThread) ||
          (runtimePolicy !== undefined && (!allowedPolicy(runtimePolicy) || runtimePolicy.cwd !== open.runtimePolicy.cwd)) ||
          (modelSelection !== undefined &&
            (modelSelection.instanceId !== options.instanceId || modelSelection.model !== open.modelSelection.model)) ||
          providerThread.nativeThreadRef?.strength !== "strong" || providerThread.nativeThreadRef.driver !== provider ||
          providerThread.nativeThreadRef.nativeId === null
            ? unsupported()
            : matches(providerThread) ? Effect.succeed(loaded!.thread)
              : load(providerThread, providerThread.nativeThreadRef.nativeId),
        startTurn: Effect.fn("DeepAIAdapter.startTurn")(function* (input) {
          const entry = loaded;
          if (closed || !entry || active || input.resume || input.threadId !== open.threadId ||
              !matches(input.providerThread) || input.modelSelection.instanceId !== options.instanceId ||
              input.modelSelection.model !== entry.model.id || !allowedPolicy(input.runtimePolicy) ||
              input.runtimePolicy.cwd !== open.runtimePolicy.cwd)
            return yield* failure("DeepAI turn is busy, unsupported, or belongs to another thread");
          const { agent, model, mcp } = entry;
          const images: NonNullable<Parameters<Agent["session"]["prompt"]>[1]>["images"] = [];
          const fileReferences: string[] = [];
          for (const attachment of input.message.attachments) {
            const path = options.attachmentsDir &&
              resolveAttachmentPath({ attachmentsDir: options.attachmentsDir, attachment });
            if (!path) return yield* failure("The attachment is unavailable. Attach it again");
            if (attachment.type === "image") {
              if (!model.input.includes("image"))
                return yield* failure("The selected DeepAI model does not accept images");
              const data = yield* fs.readFile(path).pipe(
                Effect.mapError(() => failure("The attached image could not be read")),
              );
              images.push({ type: "image", mimeType: attachment.mimeType, data: Buffer.from(data).toString("base64") });
            } else if (attachment.type === "file") {
              const [name, quotedPath] = yield* Effect.all([
                encodeAttachmentString(attachment.name), encodeAttachmentString(path),
              ]).pipe(Effect.mapError(() => failure("The attached file reference could not be encoded")));
              fileReferences.push(`Attached file ${name}: ${quotedPath}`);
            } else return yield* failure("This attachment type is not supported by DeepAI");
          }
          const nativeTurnId = yield* random.uuidV4();
          const startedAt = yield* DateTime.now;
          if (closed || active || loaded !== entry) return yield* failure("DeepAI ownership changed while preparing the turn");
          const requestedEffort = getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort");
          if (requestedEffort) {
            const effort = DEEPAI_EFFORTS.find((value) => value === requestedEffort);
            if (!effort || !agent.session.getAvailableThinkingLevels().includes(effort))
              return yield* failure("The selected reasoning effort is not supported by this DeepAI model");
            agent.session.setThinkingLevel(effort);
          }
          const turn = createActiveTurn(input, {
            id: ProviderTurnId.make(`deepai:${nativeTurnId}`),
            providerThreadId: input.providerThread.id, nodeId: input.rootNodeId, runAttemptId: input.attemptId,
            nativeTurnRef: { driver: provider, nativeId: nativeTurnId, strength: "strong" },
            ordinal: input.providerTurnOrdinal, status: "running", startedAt, completedAt: null,
          });
          active = turn;
          yield* emit({ type: "provider_turn.updated", driver: provider, providerTurn: turn.turn });
          const prompt = [input.message.text, ...fileReferences].join("\n\n");
          const intake = input.routingIntake;
          const runPrompt = <A>(execute: () => Promise<A>) => intake && mcp && intake.environmentId === mcp.environmentId
            ? withDeepAIInvocation({
                ...intake,
                threadId: input.threadId,
                messageId: input.message.messageId,
                projectId: input.appThread.projectId,
                runId: input.runId,
                providerSessionId: mcp.providerSessionId,
              }, turn.controller.signal, execute)
            : execute();
          yield* Effect.promise(async () => {
            let failed = false;
            let errorMessage = "DeepAI could not complete the turn. Check provider status and retry.";
            const classifyError = (message: string) => {
              if (/multimodal processing is not enabled/i.test(message))
                return "DeepAI advertised image support, but its server has image processing disabled for this model. Try another image-capable model or send text only.";
              if (/Codex/i.test(message))
                return "Codex vision could not complete. Check Codex sign-in and allowance on the server.";
              if (/connection check-in|too many restarts|daily reset/i.test(message))
                return "DeepAI refused the app connection check-in. Check provider status before retrying; the reset time is unverified.";
              return errorMessage;
            };
            try {
              const restore = agent.checkpoint();
              const originalMessageCount = agent.session.messages.length;
              let nativeError: string | undefined;
              try {
                await runPrompt(() => agent.session.prompt(prompt, { images }));
                const response = agent.session.messages.at(-1);
                if (response?.role === "assistant" && response.stopReason === "error")
                  nativeError = response.errorMessage;
              } catch (error) {
                if (!(error instanceof Error)) throw error;
                nativeError = error.message;
              }
              const imageRejected = nativeError && isDeepAIImageRejection(nativeError);
              const safeToRetry =
                imageRejected &&
                turn.tools.size === 0 &&
                !agent.session.messages
                  .slice(originalMessageCount)
                  .some((message) => message.role === "toolResult");
              if (safeToRetry) restore();
              if (
                images.length &&
                safeToRetry &&
                options.describeImages &&
                !turn.cancelled
              ) {
                turn.text += `DeepAI rejected the image; using ${options.visionLabel ?? "the configured vision interpreter"}.\n\n`;
                await run(publishText(turn, true));
                if (!turn.cancelled) {
                  const report = await options.describeImages(
                    input.message.text || "Describe the images.",
                    images,
                    turn.controller.signal,
                  );
                  if (!turn.cancelled) await runPrompt(() => agent.session.prompt(prompt + "\n\n" + report));
                }
              } else if (nativeError) {
                throw new Error(nativeError);
              }
              const last = agent.session.messages.at(-1);
              failed = last?.role === "assistant" && last.stopReason === "error";
              if (last?.role === "assistant" && last.errorMessage)
                errorMessage = classifyError(last.errorMessage);
            } catch (error) {
              failed = true;
              if (error instanceof Error) errorMessage = classifyError(error.message);
            }
            if (closed || active !== turn) return;
            turn.finished = true;
            await run(Effect.gen(function* () {
              yield* publishText(turn, false);
              const status = turn.cancelled ? "interrupted" as const : failed ? "failed" as const : "completed" as const;
              const completedAt = yield* DateTime.now;
              yield* emit({ type: "provider_turn.updated", driver: provider,
                providerTurn: { ...turn.turn, completedAt, status } });
              const base = { type: "turn.terminal" as const, driver: provider,
                providerThreadId: input.providerThread.id, providerTurnId: turn.turn.id,
                runOrdinal: input.runOrdinal, threadDisposition: "reusable" as const };
              active = undefined;
              yield* emit(status === "failed"
                ? { ...base, status, failureItemOrdinal: turn.nextOrdinal,
                    failure: makeProviderFailure({ class: "provider_error", message: errorMessage }) }
                : { ...base, status, failure: null });
            }));
          }).pipe(Effect.forkIn(scope), Effect.asVoid);
        }),
        interruptTurn: Effect.fn("DeepAIAdapter.interruptTurn")(function* ({ providerThread, providerTurnId }) {
          if (!matches(providerThread) || active?.turn.id !== providerTurnId)
            return yield* failure("DeepAI does not own this active turn");
          stop();
          yield* task("DeepAI could not interrupt its turn", () => loaded!.agent.session.abort());
        }),
        respondToRuntimeRequest: Effect.fn("DeepAIAdapter.respondToRuntimeRequest")(function* ({ requestId, decision }) {
          const finish = requests.get(requestId);
          if (!finish || decision === undefined) return yield* failure("DeepAI does not own this approval");
          finish(decision === "accept" || decision === "acceptForSession");
        }),
        steerTurn: unsupported, readThreadSnapshot: unsupported, rollbackThread: unsupported, forkThread: unsupported,
      } satisfies Adapter.ProviderAdapterV2SessionRuntime;
    }),
  });
});
