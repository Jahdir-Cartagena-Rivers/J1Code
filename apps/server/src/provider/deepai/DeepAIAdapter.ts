import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { DEEPAI_EFFORTS } from "./DeepAIModelCapabilities.ts";
import * as NodePath from "node:path";
import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
  type CanonicalRequestType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import { ProviderAdapterRequestError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import type { createDeepAIAgent } from "./DeepAIAgent.ts";
import type { makeDeepAIClient, DeepAIModel } from "./DeepAIClient.ts";
import { readMcpProviderSession } from "../../mcp/McpProviderSession.ts";

const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const provider = ProviderDriverKind.make("deepai");
type Agent = Awaited<ReturnType<typeof createDeepAIAgent>>;
type Session = {
  model: DeepAIModel;
  view: ProviderSession;
  agent: Agent;
  active?: TurnId;
  controller?: AbortController;
  cancelled: boolean;
};

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
}) {
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const scope = yield* Scope.Scope;
  const context = yield* Effect.context<never>();
  const run = Effect.runPromiseWith(context);
  const sessions = new Map<ThreadId, Session>();
  const pending = new Map<
    string,
    { thread: ThreadId; requestType: CanonicalRequestType; resolve: (allowed: boolean) => void }
  >();
  const emit = (event: ProviderRuntimeEvent) => run(PubSub.publish(events, event)).then(() => {});
  const stamp = (threadId: ThreadId, turnId?: TurnId) => ({
    eventId: EventId.make(NodeCrypto.randomUUID()),
    provider,
    providerInstanceId: options.instanceId,
    threadId,
    createdAt: new Date().toISOString(),
    ...(turnId ? { turnId } : {}),
  });
  const failure = (operation: string, detail = `DeepAI could not complete ${operation}.`) =>
    new ProviderAdapterRequestError({
      provider,
      method: operation,
      detail,
    });
  const task = <A>(operation: string, work: () => Promise<A>) =>
    Effect.tryPromise({
      try: work,
      catch: () => failure(operation),
    });
  const requireSession = (id: ThreadId) => {
    const state = sessions.get(id);
    if (!state) throw new Error("DeepAI session is not active.");
    return state;
  };
  const stop = async (id: ThreadId) => {
    const state = sessions.get(id);
    if (!state) return;
    state.cancelled = true;
    state.controller?.abort();
    for (const [key, request] of pending)
      if (request.thread === id) {
        pending.delete(key);
        request.resolve(false);
      }
    await state.agent.stop();
    sessions.delete(id);
  };
  const adapter: ProviderAdapterShape<ProviderAdapterRequestError> = {
    provider,
    capabilities: { sessionModelSwitch: "unsupported", supportsConversationRollback: false },
    startSession: (input) =>
      task("start session", async () => {
        if (sessions.has(input.threadId)) throw new Error("Session already exists.");
        const catalog = await options.catalog();
        const apiKey = await options.credentials();
        const directory = NodePath.join(
          options.directory,
          NodeCrypto.createHash("sha256").update(input.threadId).digest("hex"),
        );
        let sessionFile: string | undefined;
        if (
          !input.freshSession &&
          typeof input.resumeCursor === "object" &&
          input.resumeCursor !== null &&
          "sessionFile" in input.resumeCursor
        ) {
          const value = input.resumeCursor.sessionFile;
          if (
            typeof value !== "string" ||
            NodePath.dirname(NodePath.resolve(value)) !== NodePath.resolve(directory)
          )
            throw new Error("Invalid resume cursor.");
          sessionFile = value;
        }
        const modelId = input.modelSelection?.model ?? catalog.default;
        const selectedModel = catalog.models.find((model) => model.id === modelId);
        if (!selectedModel) throw new Error("Selected model is unavailable.");
        const mcp = readMcpProviderSession(input.threadId);
        const { createDeepAIAgent: create } = await import("./DeepAIAgent.ts");
        const agent = await create({
          ...(options.client ? { client: options.client } : {}),
          cwd: input.cwd ?? process.cwd(),
          agentDir: NodePath.join(directory, "config"),
          sessionDir: directory,
          ...(sessionFile ? { sessionFile } : {}),
          apiKey,
          models: catalog.models,
          modelId,
          ...(mcp ? { mcp } : {}),
          systemPrompt: buildRuntimeInstructions({ harness: "DeepAI", model: modelId }),
          authorize: async (tool, args, signal) => {
            const state = requireSession(input.threadId);
            if (state.cancelled || signal.aborted) return false;
            if (state.view.runtimeMode === "full-access") return true;
            const requestId = RuntimeRequestId.make(NodeCrypto.randomUUID());
            const requestType =
              tool === "read"
                ? "file_read_approval"
                : tool === "edit" || tool === "write"
                  ? "file_change_approval"
                  : "exec_command_approval";
            return new Promise<boolean>((resolve) => {
              const finish = (allowed: boolean) => {
                signal.removeEventListener("abort", abort);
                resolve(allowed);
              };
              const abort = () => {
                pending.delete(requestId);
                finish(false);
              };
              pending.set(requestId, { thread: input.threadId, requestType, resolve: finish });
              signal.addEventListener("abort", abort, { once: true });
              void emit({
                ...stamp(input.threadId, state.active),
                requestId,
                type: "request.opened",
                payload: { requestType, detail: `DeepAI requests ${tool}`, args },
              }).catch(abort);
            });
          },
          onEvent: (event) => {
            const state = sessions.get(input.threadId);
            if (!state?.active) return;
            if (event.type === "message_update") {
              const delta = event.assistantMessageEvent;
              if (delta.type === "text_delta" || delta.type === "thinking_delta")
                void emit({
                  ...stamp(input.threadId, state.active),
                  itemId: RuntimeItemId.make(`${state.active}:assistant`),
                  type: "content.delta",
                  payload: {
                    streamKind: delta.type === "text_delta" ? "assistant_text" : "reasoning_text",
                    delta: delta.delta,
                  },
                });
            }
          },
        });
        const initialEffort = getModelSelectionStringOptionValue(
          input.modelSelection,
          "reasoningEffort",
        );
        if (initialEffort) {
          const effort = DEEPAI_EFFORTS.find((value) => value === initialEffort);
          if (!effort || !agent.session.getAvailableThinkingLevels().includes(effort)) {
            await agent.stop();
            throw new Error("Unsupported reasoning effort.");
          }
          agent.session.setThinkingLevel(effort);
        }
        const now = new Date().toISOString();
        const view: ProviderSession = {
          provider,
          providerInstanceId: options.instanceId,
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          status: "ready",
          model: modelId,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          createdAt: now,
          updatedAt: now,
          resumeCursor: { sessionFile: agent.sessionFile },
        };
        sessions.set(input.threadId, { model: selectedModel, view, agent, cancelled: false });
        await emit({
          ...stamp(input.threadId),
          type: "session.started",
          payload: { resume: view.resumeCursor },
        });
        return view;
      }),
    sendTurn: (input) =>
      Effect.gen(function* () {
        const state = sessions.get(input.threadId);
        if (!state)
          return yield* Effect.fail(
            failure("send turn", "DeepAI session is not active. Retry the turn to reconnect."),
          );
        if (state.active)
          return yield* Effect.fail(
            failure(
              "send turn",
              "DeepAI is already running a turn. Stop it or wait for completion.",
            ),
          );
        if (input.interactionMode === "plan")
          return yield* Effect.fail(
            failure(
              "send turn",
              "DeepAI Plan mode is not implemented. Select the default interaction mode.",
            ),
          );
        if (input.modelSelection && input.modelSelection.model !== state.view.model)
          return yield* Effect.fail(failure("switch model"));
        state.cancelled = false;
        const model = state.model;
        const images: NonNullable<Parameters<Agent["session"]["prompt"]>[1]>["images"] = [];
        const fileReferences: string[] = [];
        for (const attachment of input.attachments ?? []) {
          const path =
            options.attachmentsDir &&
            resolveAttachmentPath({ attachmentsDir: options.attachmentsDir, attachment });
          if (!path)
            return yield* Effect.fail(
              failure("send turn", "The attachment is unavailable. Remove it and attach it again."),
            );
          if (attachment.type === "image") {
            if (!model.input.includes("image"))
              return yield* Effect.fail(
                failure(
                  "send turn",
                  "The selected DeepAI model does not accept images. Choose an image-capable model.",
                ),
              );
            const data = yield* Effect.tryPromise({
              try: () => NodeFSP.readFile(path),
              catch: () =>
                failure("send turn", "The attached image could not be read. Attach it again."),
            });
            images.push({
              type: "image",
              mimeType: attachment.mimeType,
              data: data.toString("base64"),
            });
          } else if (attachment.type === "file") {
            fileReferences.push(
              `Attached file ${encodeString(attachment.name)}: ${encodeString(path)}`,
            );
          } else {
            return yield* Effect.fail(
              failure("send turn", "This attachment type is not supported by DeepAI."),
            );
          }
        }
        // Attachment reads yield; another request may have started or stopped the session.
        if (sessions.get(input.threadId) !== state || state.active || state.cancelled)
          return yield* Effect.fail(
            failure(
              "send turn",
              "DeepAI session changed while preparing the turn. Retry after the current turn finishes.",
            ),
          );
        const selectedEffort = getModelSelectionStringOptionValue(
          input.modelSelection,
          "reasoningEffort",
        );
        if (selectedEffort) {
          const effort = DEEPAI_EFFORTS.find((value) => value === selectedEffort);
          if (!effort || !state.agent.session.getAvailableThinkingLevels().includes(effort))
            return yield* Effect.fail(
              failure(
                "send turn",
                "The selected reasoning effort is not supported by this DeepAI model.",
              ),
            );
          state.agent.session.setThinkingLevel(effort);
        }
        const prompt = [input.input ?? "Continue.", ...fileReferences].join("\n\n");
        const turnId = TurnId.make(NodeCrypto.randomUUID());
        state.active = turnId;
        state.controller = new AbortController();
        state.cancelled = false;
        state.view = { ...state.view, status: "running", activeTurnId: turnId };
        yield* Effect.promise(() =>
          emit({
            ...stamp(input.threadId, turnId),
            type: "turn.started",
            payload: { model: state.view.model },
          }),
        );
        yield* Effect.promise(() =>
          emit({
            ...stamp(input.threadId, turnId),
            itemId: RuntimeItemId.make(`${turnId}:assistant`),
            type: "item.started",
            payload: { itemType: "assistant_message", status: "inProgress" },
          }),
        );
        yield* Effect.promise(async () => {
          let failed = false;
          let errorMessage = "DeepAI could not complete the turn. Check provider status and retry.";
          const classifyError = (message: string) => {
            if (/multimodal processing is not enabled/i.test(message))
              return "DeepAI advertised image support, but its server has image processing disabled for this model. Try another image-capable model or send text only.";
            if (/Codex/i.test(message))
              return "Codex vision could not complete. Check Codex sign-in and allowance on the server.";
            if (/too many restarts|daily reset/i.test(message))
              return "DeepAI's daily connection restart limit was reached. Wait for its daily reset; signing in again will not clear the limit.";
            return errorMessage;
          };
          try {
            const restore = state.agent.checkpoint();
            const originalMessageCount = state.agent.session.messages.length;
            let nativeError: string | undefined;
            try {
              await state.agent.session.prompt(prompt, { images });
              const response = state.agent.session.messages.at(-1);
              if (response?.role === "assistant" && response.stopReason === "error")
                nativeError = response.errorMessage;
            } catch (error) {
              if (!(error instanceof Error)) throw error;
              nativeError = error.message;
            }
            const imageRejected =
              nativeError &&
              /multimodal processing is not enabled|(?:image|vision|multimodal).{0,60}(?:not supported|unsupported|not enabled)/i.test(
                nativeError,
              );
            if (
              images.length &&
              imageRejected &&
              options.describeImages &&
              !state.cancelled &&
              !state.agent.session.messages
                .slice(originalMessageCount)
                .some((message) => message.role === "toolResult")
            ) {
              restore();
              await emit({
                ...stamp(input.threadId, turnId),
                itemId: RuntimeItemId.make(`${turnId}:assistant`),
                type: "content.delta",
                payload: {
                  streamKind: "assistant_text",
                  delta: `DeepAI rejected the image; using ${options.visionLabel ?? "the configured vision interpreter"}.\n\n`,
                },
              });
              const report = await options.describeImages(
                input.input ?? "Describe the images.",
                images,
                state.controller?.signal,
              );
              if (state.cancelled) return;
              await state.agent.session.prompt(prompt + "\n\n" + report);
            } else if (nativeError) {
              throw new Error(nativeError);
            }
            const last = state.agent.session.messages.at(-1);
            failed = last?.role === "assistant" && last.stopReason === "error";
            if (last?.role === "assistant" && last.errorMessage)
              errorMessage = classifyError(last.errorMessage);
          } catch (error) {
            failed = true;
            if (error instanceof Error) errorMessage = classifyError(error.message);
          } finally {
            if (failed && !state.cancelled)
              await emit({
                ...stamp(input.threadId, turnId),
                type: "runtime.error",
                payload: { message: errorMessage },
              });
            await emit({
              ...stamp(input.threadId, turnId),
              itemId: RuntimeItemId.make(`${turnId}:assistant`),
              type: "item.completed",
              payload: { itemType: "assistant_message", status: failed ? "failed" : "completed" },
            });
            await emit({
              ...stamp(input.threadId, turnId),
              type: "turn.completed",
              payload: { state: state.cancelled ? "interrupted" : failed ? "failed" : "completed" },
            });
            delete state.active;
            delete state.controller;
            const { activeTurnId: _active, ...rest } = state.view;
            state.view = { ...rest, status: "ready" };
          }
        }).pipe(Effect.forkIn(scope));
        return { threadId: input.threadId, turnId, resumeCursor: state.view.resumeCursor };
      }),
    interruptTurn: (threadId) =>
      task("interrupt", async () => {
        const state = requireSession(threadId);
        state.cancelled = true;
        state.controller?.abort();
        for (const [id, request] of pending)
          if (request.thread === threadId) {
            pending.delete(id);
            request.resolve(false);
          }
        await state.agent.session.abort();
      }),
    respondToRequest: (threadId, requestId, decision) =>
      task("approval", async () => {
        const request = pending.get(requestId);
        if (!request || request.thread !== threadId) throw new Error("Unknown request.");
        pending.delete(requestId);
        await emit({
          ...stamp(threadId, requireSession(threadId).active),
          requestId: RuntimeRequestId.make(requestId),
          type: "request.resolved",
          payload: { requestType: request.requestType, decision },
        });
        request.resolve(decision === "accept" || decision === "acceptForSession");
      }),
    respondToUserInput: () => Effect.fail(failure("user input")),
    stopSession: (id) => task("stop session", () => stop(id)),
    stopAll: () =>
      task("stop sessions", async () => {
        await Promise.all([...sessions.keys()].map(stop));
      }),
    listSessions: () => Effect.sync(() => [...sessions.values()].map((state) => state.view)),
    hasSession: (id) => Effect.sync(() => sessions.has(id)),
    readThread: () => Effect.fail(failure("read native transcript")),
    rollbackThread: () => Effect.fail(failure("rollback")),
    streamEvents: Stream.fromPubSub(events),
  };
  yield* Effect.addFinalizer(() =>
    adapter.stopAll().pipe(Effect.ignore, Effect.ensuring(PubSub.shutdown(events))),
  );
  return adapter;
});
