import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
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
import { deepAIToolEvent } from "./DeepAIToolEvents.ts";

const provider = ProviderDriverKind.make("deepai");
type Agent = Awaited<ReturnType<typeof createDeepAIAgent>>;
type Session = { view: ProviderSession; agent: Agent; active?: TurnId; cancelled: boolean };

export const makeDeepAIAdapter = Effect.fn("makeDeepAIAdapter")(function* (options: {
  instanceId: ProviderInstanceId;
  directory: string;
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
  const failure = (operation: string) =>
    new ProviderAdapterRequestError({
      provider,
      method: operation,
      detail: `DeepAI could not complete ${operation}.`,
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
        const mcp = readMcpProviderSession(input.threadId);
        const { createDeepAIAgent: create } = await import("./DeepAIAgent.ts");
        const lastToolUpdate = new Map<string, number>();
        const toolCommands = new Map<string, string>();
        const commandTurns = new Map<string, TurnId>();
        const backgroundCommands = new Set<string>();
        const lastCommandUpdate = new Map<string, number>();
        let owned: Session | undefined;
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
            if (state !== owned || state.cancelled || signal.aborted) return false;
            if (tool === "command_status") return true;
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
            if (state !== owned || !state?.active) return;
            const tool = deepAIToolEvent(
              event,
              "toolCallId" in event ? toolCommands.get(event.toolCallId) : undefined,
            );
            if (
              tool &&
              (tool.type !== "item.updated" ||
                NodePerfHooks.performance.now() - (lastToolUpdate.get(tool.callId) ?? -Infinity) >=
                  1000)
            ) {
              if (tool.type === "item.completed") {
                lastToolUpdate.delete(tool.callId);
                toolCommands.delete(tool.callId);
              } else {
                lastToolUpdate.set(tool.callId, NodePerfHooks.performance.now());
                if (tool.payload.itemType === "command_execution" && tool.payload.detail)
                  toolCommands.set(tool.callId, tool.payload.detail);
              }
              void emit({
                ...stamp(input.threadId, state.active),
                itemId: RuntimeItemId.make(`${state.active}:tool:${tool.callId}`),
                type: tool.type,
                payload: tool.payload,
              });
            }
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
          onCommandJob: (job, backgrounded) => {
            const state = sessions.get(input.threadId);
            if (state !== owned || !state) return;
            if (!commandTurns.has(job.id) && state.active) commandTurns.set(job.id, state.active);
            const turnId = commandTurns.get(job.id);
            if (!turnId) return;
            const taskId = RuntimeTaskId.make(`deepai:command:${job.id}`);
            if (backgrounded && !backgroundCommands.has(job.id)) {
              backgroundCommands.add(job.id);
              void emit({
                ...stamp(input.threadId, turnId),
                type: "task.started",
                payload: { taskId, description: `Shell job: ${job.key.slice(0, 512)}` },
              });
            }
            if (backgroundCommands.has(job.id)) {
              const summary = (job.error ?? job.output).trim().slice(-4000);
              if (job.state !== "running") {
                void emit({
                  ...stamp(input.threadId, turnId),
                  type: "task.completed",
                  payload: {
                    taskId,
                    status: job.state === "cancelled" ? "stopped" : job.state,
                    ...(summary ? { summary } : {}),
                  },
                });
                backgroundCommands.delete(job.id);
              } else if (
                NodePerfHooks.performance.now() - (lastCommandUpdate.get(job.id) ?? -Infinity) >=
                1000
              ) {
                lastCommandUpdate.set(job.id, NodePerfHooks.performance.now());
                void emit({
                  ...stamp(input.threadId, turnId),
                  type: "task.progress",
                  payload: {
                    taskId,
                    description: `${job.cancelRequested ? "Cancellation requested" : "Running"}; ${Math.floor(job.elapsedMs / 1000)}s elapsed; ${job.outputChars} output characters`,
                    status: "running",
                    ...(summary ? { summary } : {}),
                  },
                });
              }
            }
            if (job.state !== "running") {
              commandTurns.delete(job.id);
              lastCommandUpdate.delete(job.id);
            }
          },
        });
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
        owned = { view, agent, cancelled: false };
        sessions.set(input.threadId, owned);
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
        if (!state || state.active || input.attachments?.length || input.interactionMode === "plan")
          return yield* Effect.fail(failure("send turn"));
        if (input.modelSelection && input.modelSelection.model !== state.view.model)
          return yield* Effect.fail(failure("switch model"));
        const turnId = TurnId.make(NodeCrypto.randomUUID());
        state.active = turnId;
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
          try {
            await state.agent.session.prompt(input.input ?? "Continue.");
            const last = state.agent.session.messages.at(-1);
            failed = last?.role === "assistant" && last.stopReason === "error";
          } catch {
            failed = true;
          } finally {
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
        for (const [id, request] of pending)
          if (request.thread === threadId) {
            pending.delete(id);
            request.resolve(false);
          }
        state.agent.interruptCommands();
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
