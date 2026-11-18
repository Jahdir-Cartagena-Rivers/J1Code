// @effect-diagnostics nodeBuiltinImport:off - materializes native-child image files at the existing attachment boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import {
  ApprovalRequestId,
  CommandId,
  IsoDateTime,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  BotId,
  type ChatAttachment,
} from "@j1code/contracts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { registerBotExecutionContext } from "./ExecutionContext.ts";
import { ServerConfig } from "../config.ts";
import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { nativeDefaultAccount, sharedModelOptions } from "./ExecutionAccounts.ts";

const id = Schema.String.check(Schema.isPattern(/^[\w-]{1,120}$/u));
const start = Schema.Struct({
  action: Schema.Literal("start"),
  botId: id,
  threadId: id,
  turnId: id,
  botName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  instanceId: ProviderInstanceId,
  model: Schema.String,
  effort: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  projectId: Schema.optional(ProjectId),
  cwd: Schema.String,
  text: Schema.String,
  system: Schema.String,
  recoveryText: Schema.optional(Schema.String),
  transcript: Schema.optional(
    Schema.Array(
      Schema.Struct({ role: Schema.Literals(["user", "assistant"]), text: Schema.String }),
    ),
  ),
  sharedContinuation: Schema.Boolean,
  restrictedTools: Schema.Boolean,
  approvalMode: Schema.Literals(["ask", "edits", "auto", "full"]),
  guestConfined: Schema.Boolean,
  images: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      mime: Schema.Literals(["image/png", "image/jpeg", "image/gif", "image/webp"]),
      bytes: Schema.Number,
      source: Schema.optional(Schema.String),
    }),
  ).check(Schema.isMaxLength(100)),
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.optional(Schema.String),
      inputSchema: Schema.Unknown,
    }),
  ),
});
const source = { botId: id, threadId: id };
const invocation = Schema.Union([
  start,
  Schema.Struct({ action: Schema.Literal("catalog") }),
  Schema.Struct({ action: Schema.Literal("watch-catalog") }),
  Schema.Struct({ action: Schema.Literal("projects") }),
  Schema.Struct({ action: Schema.Literal("binding"), ...source }),
  Schema.Struct({ action: Schema.Literal("interrupt"), ...source }),
  Schema.Struct({ action: Schema.Literal("stop"), ...source }),
  Schema.Struct({
    action: Schema.Literal("respond"),
    ...source,
    requestId: Schema.String,
    decision: Schema.Literals(["accept", "decline", "cancel"]),
  }),
  Schema.Struct({
    action: Schema.Literal("answer"),
    ...source,
    requestId: Schema.String,
    answers: Schema.Record(Schema.String, Schema.Unknown),
  }),
  Schema.Struct({
    action: Schema.Literal("tool-result"),
    ...source,
    requestId: Schema.String,
    value: Schema.Unknown,
  }),
]);
type Start = typeof start.Type;
type Emit = (event: unknown) => void;
type Active = {
  readonly owner: string;
  readonly input: Start;
  readonly turnId: string;
  readonly current: () => boolean;
  readonly emit: Emit;
  readonly release: () => void;
  readonly pending: Map<string, { resolve(value: unknown): void; reject(error: Error): void }>;
};
export const botExecutionThreadId = (botId: string, threadId: string) =>
  ThreadId.make(`j1-mausbot:${botId}:${threadId}`);
const now = Clock.currentTimeMillis.pipe(
  Effect.map((ms) => IsoDateTime.make(DateTime.formatIso(DateTime.makeUnsafe(ms)))),
);
const command = () => CommandId.make(`mausbot:${NodeCrypto.randomUUID()}`);

/** Normal orchestration owns execution; the native runtime owns its bot UI and tools. */
export class MausbotExecution extends Context.Service<
  MausbotExecution,
  {
    readonly call: (
      input: unknown,
      current: () => boolean,
      emit: Emit,
      owner: string,
    ) => Promise<unknown>;
    readonly disconnect: (owner: string) => Promise<void>;
  }
>()("@j1code/server/mausbot/Execution/MausbotExecution") {
  static readonly layer = Layer.effect(
    MausbotExecution,
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const query = yield* ProjectionSnapshotQuery;
      const providers = yield* ProviderService;
      const registry = yield* ProviderRegistry;
      const settings = yield* ServerSettingsService;
      const config = yield* ServerConfig;
      const context = yield* Effect.context<never>();
      const run = Effect.runPromiseWith(context);
      const active = new Map<ThreadId, Active>();
      const catalogSubscribers = new Map<string, { current(): boolean; emit: Emit }>();
      const catalogSnapshot = Effect.gen(function* () {
        const catalog = yield* registry.getProviders;
        const configured = yield* settings.getSettings;
        return catalog.map((row) => ({
          ...row,
          nativeDefault: nativeDefaultAccount(
            row,
            configured.providerInstances[row.instanceId] ??
              (String(row.instanceId) === String(row.driver) &&
              Object.hasOwn(configured.providers, row.driver)
                ? {
                    driver: row.driver,
                    config: configured.providers[row.driver as keyof typeof configured.providers],
                  }
                : undefined),
          ),
        }));
      });
      yield* registry.streamChanges.pipe(
        Stream.runForEach(() =>
          catalogSnapshot.pipe(
            Effect.tap((catalog) =>
              Effect.sync(() => {
                for (const [owner, subscriber] of catalogSubscribers) {
                  if (!subscriber.current()) catalogSubscribers.delete(owner);
                  else subscriber.emit({ kind: "catalog", catalog });
                }
              }),
            ),
            Effect.ignore,
          ),
        ),
        Effect.forkScoped,
      );
      const gates = new Map<string, Semaphore.Semaphore>();
      const release = (threadId: ThreadId) => {
        const one = active.get(threadId);
        if (!one) return;
        active.delete(threadId);
        one.release();
        for (const pending of one.pending.values())
          pending.reject(new Error("The bot turn ended."));
        one.pending.clear();
      };
      yield* providers.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            const one = active.get(event.threadId);
            if (!one || !one.current()) return;
            one.emit({
              kind: "runtime",
              botId: one.input.botId,
              threadId: one.input.threadId,
              turnId: one.turnId,
              event,
            });
            if (
              event.type === "turn.completed" ||
              event.type === "turn.aborted" ||
              event.type === "session.exited"
            )
              release(event.threadId);
          }),
        ),
        Effect.forkScoped,
      );

      // Failures before a provider turn starts are domain events, not CLI events.
      const events = yield* engine.subscribeDomainEvents;
      yield* events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type !== "thread.session-set" || event.payload.session.status !== "error")
              return;
            const one = active.get(event.payload.threadId);
            if (!one || !one.current()) return;
            one.emit({
              kind: "failed",
              botId: one.input.botId,
              threadId: one.input.threadId,
              turnId: one.turnId,
              message: event.payload.session.lastError ?? "The shared provider could not start.",
            });
            release(event.payload.threadId);
          }),
        ),
        Effect.forkScoped,
      );

      const handle = Effect.fn("MausbotExecution.call")(function* (
        input: typeof invocation.Type,
        current: () => boolean,
        emit: Emit,
        owner: string,
      ) {
        if (!current()) return yield* Effect.fail("The bot runtime disconnected.");
        if (input.action === "catalog") return yield* catalogSnapshot;
        if (input.action === "watch-catalog") {
          catalogSubscribers.set(owner, { current, emit });
          emit({ kind: "catalog", catalog: yield* catalogSnapshot });
          return {};
        }
        if (input.action === "projects")
          return yield* query.getProjectShells().pipe(
            Effect.map((items) =>
              items
                .filter((item) => !item.id.startsWith("j1-bot:"))
                .map((item) => ({
                  id: item.id,
                  title: item.title,
                  workspaceRoot: item.workspaceRoot,
                })),
            ),
          );
        const threadId = botExecutionThreadId(input.botId, input.threadId);
        if (input.action === "binding") {
          const saved = yield* query.getThreadShellById(threadId);
          return Option.isSome(saved)
            ? { locked: true, projectId: saved.value.projectId }
            : { locked: false };
        }
        const one = active.get(threadId);
        if (one && one.owner !== owner)
          return yield* Effect.fail("This bot turn belongs to another runtime connection.");
        if (input.action === "tool-result") {
          if (!one || !one.current())
            return yield* Effect.fail("This bot turn is no longer active.");
          const pending = one.pending.get(input.requestId);
          if (!pending) return yield* Effect.fail("This bot tool request is no longer active.");
          one.pending.delete(input.requestId);
          pending.resolve(input.value);
          return {};
        }
        if (input.action === "interrupt") {
          yield* providers.interruptTurn({ threadId });
          return {};
        }
        if (input.action === "stop") {
          yield* providers.stopSession({ threadId });
          release(threadId);
          return {};
        }
        if (input.action === "respond") {
          if (!one) return yield* Effect.fail("This bot turn is no longer active.");
          yield* providers.respondToRequest({
            threadId,
            requestId: ApprovalRequestId.make(input.requestId),
            decision: input.decision,
          });
          return {};
        }
        if (input.action === "answer") {
          if (!one) return yield* Effect.fail("This bot turn is no longer active.");
          yield* providers.respondToUserInput({
            threadId,
            requestId: ApprovalRequestId.make(input.requestId),
            answers: input.answers,
          });
          return {};
        }
        if (one) return yield* Effect.fail("This bot thread already has an active turn.");
        // Guests require the native provider's explicit confinement contract. Do
        // not reinterpret that as a general project workspace grant.
        if (input.guestConfined)
          return yield* Effect.fail("Shared execution is not available to guest turns.");
        const available = yield* registry.getProviders;
        const provider = available.find(
          (item) => item.instanceId === input.instanceId && item.enabled,
        );
        if (!provider)
          return yield* Effect.fail("The selected J1 provider account is unavailable.");
        const options = yield* Effect.try({
          try: () => sharedModelOptions(provider, input.model, input.effort, input.variant),
          catch: String,
        });
        const existing = yield* query.getThreadShellById(threadId);
        let projectId = input.projectId;
        let cwd = input.cwd;
        if (projectId) {
          const project = yield* query.getProjectShellById(projectId);
          if (Option.isNone(project))
            return yield* Effect.fail("The selected J1 project is unavailable.");
          cwd = project.value.workspaceRoot;
        } else if (Option.isSome(existing)) {
          projectId = existing.value.projectId;
        } else {
          const projects = yield* query.getProjectShells();
          projectId = projects.find((project) => project.workspaceRoot === cwd)?.id;
        }
        projectId ??= ProjectId.make(`j1-bot:mausbot:${input.botId}:${input.threadId}`);
        if (Option.isSome(existing) && existing.value.projectId !== projectId)
          return yield* Effect.fail(
            "Start a new bot thread to change its project; the existing session is preserved.",
          );
        const runtimeMode =
          input.approvalMode === "full"
            ? "full-access"
            : input.approvalMode === "auto"
              ? "auto"
              : input.approvalMode === "edits"
                ? "auto-accept-edits"
                : "approval-required";
        const modelSelection = {
          instanceId: input.instanceId,
          model: input.model,
          ...(options.length ? { options } : {}),
        };
        if (Option.isNone(existing)) {
          const project = yield* query.getProjectShellById(projectId);
          if (Option.isNone(project))
            yield* engine.dispatch({
              type: "project.create",
              commandId: command(),
              projectId,
              title: input.botName,
              workspaceRoot: cwd,
              createdAt: yield* now,
            });
          yield* engine.dispatch({
            type: "thread.create",
            commandId: command(),
            threadId,
            projectId,
            bot: {
              id: BotId.make(`mausbot:${input.botId}`),
              name: input.botName,
              instructions: "",
            },
            title: input.title,
            modelSelection,
            runtimeMode,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: yield* now,
            ...(input.transcript?.length ? { historyImport: true } : {}),
          });
        }
        if (!input.sharedContinuation && input.transcript?.length) {
          const saved = yield* query.getThreadDetailById(threadId, { activityKinds: [] });
          if (Option.isNone(saved) || saved.value.messages.length === 0) {
            const createdAt = yield* now;
            yield* engine.dispatch({
              type: "thread.history.import",
              commandId: command(),
              threadId,
              messages: input.transcript.map((message) => ({
                messageId: MessageId.make(NodeCrypto.randomUUID()),
                role: message.role,
                text: message.text,
                createdAt,
              })),
            });
          }
        }
        const pending: Active["pending"] = new Map();
        const turnId = input.turnId;
        const attachments = yield* Effect.tryPromise({
          try: async () => {
            const result: ChatAttachment[] = [];
            let total = 0;
            await NodeFSP.mkdir(config.attachmentsDir, { recursive: true });
            for (const image of input.images) {
              const stat = await NodeFSP.stat(image.path);
              total += stat.size;
              if (
                !stat.isFile() ||
                stat.size !== image.bytes ||
                stat.size > 20 * 1024 * 1024 ||
                total > 80 * 1024 * 1024
              )
                throw new Error(
                  "The bot image attachment changed or exceeds the attachment budget.",
                );
              const attachment: ChatAttachment = {
                type: "image",
                id: createAttachmentId(threadId)!,
                name: NodePath.basename(image.path),
                mimeType: image.mime,
                sizeBytes: stat.size,
              };
              const destination = resolveAttachmentPath({
                attachmentsDir: config.attachmentsDir,
                attachment,
              });
              if (!destination) throw new Error("Invalid bot image attachment.");
              await NodeFSP.copyFile(image.path, destination, NodeFSP.constants.COPYFILE_EXCL);
              result.push(attachment);
            }
            return result;
          },
          catch: (error) => String(error),
        });
        const remove = registerBotExecutionContext(threadId, {
          restrictedTools: input.restrictedTools,
          prompt: [
            input.system,
            `J1 execution workspace: ${cwd}. This is the authoritative working directory for the current project.`,
            Option.isNone(existing) && input.recoveryText
              ? `Existing bot conversation (preserve continuity):\n${input.recoveryText}`
              : "",
            "This is the bot's own conversation, running through J1's shared execution services. Use bot_tools and bot_call for its selected team, routine, conversation search and routing tools; those preserve the original bot identity, visibility and delivery receipts. Do not route work elsewhere merely to gain project capabilities.",
          ]
            .filter(Boolean)
            .join("\n\n"),
          tools: input.tools,
          call: (name, arguments_, signal) =>
            new Promise((resolve, reject) => {
              if (!current() || !active.has(threadId) || signal.aborted)
                return reject(new Error("The bot turn ended."));
              const requestId = NodeCrypto.randomUUID();
              const abort = () => {
                pending.delete(requestId);
                if (current())
                  emit({
                    kind: "tool-cancel",
                    botId: input.botId,
                    threadId: input.threadId,
                    requestId,
                  });
                reject(new Error("The bot tool was cancelled."));
              };
              signal.addEventListener("abort", abort, { once: true });
              pending.set(requestId, {
                resolve: (value) => {
                  signal.removeEventListener("abort", abort);
                  resolve(value);
                },
                reject: (error) => {
                  signal.removeEventListener("abort", abort);
                  reject(error);
                },
              });
              emit({
                kind: "tool-call",
                botId: input.botId,
                threadId: input.threadId,
                requestId,
                name,
                arguments: arguments_,
              });
            }),
        });
        active.set(threadId, { owner, input, turnId, pending, current, emit, release: remove });
        yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId: command(),
            threadId,
            message: {
              messageId: MessageId.make(NodeCrypto.randomUUID()),
              role: "user",
              text: input.text,
              attachments,
            },
            modelSelection,
            runtimeMode,
            interactionMode: "default",
            createdAt: yield* now,
          })
          .pipe(Effect.tapError(() => Effect.sync(() => release(threadId))));
        return { turnId };
      });
      const disconnect = (owner?: string) => {
        if (owner) catalogSubscribers.delete(owner);
        else catalogSubscribers.clear();
        return run(
          Effect.forEach(
            [...active].filter(([, one]) => !owner || one.owner === owner).map(([id]) => id),
            (threadId) =>
              providers
                .stopSession({ threadId })
                .pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => release(threadId)))),
            { concurrency: 4, discard: true },
          ),
        );
      };
      yield* Effect.addFinalizer(() => Effect.promise(() => disconnect()));
      return {
        call: (raw, current, emit, owner) =>
          run(
            Effect.gen(function* () {
              const input = yield* Schema.decodeUnknownEffect(invocation)(raw, {
                onExcessProperty: "error",
              });
              if (input.action !== "start") return yield* handle(input, current, emit, owner);
              const key = botExecutionThreadId(input.botId, input.threadId);
              const gate = gates.get(key) ?? Semaphore.makeUnsafe(1);
              gates.set(key, gate);
              return yield* gate.withPermit(handle(input, current, emit, owner));
            }),
          ),
        disconnect,
      };
    }),
  );
}
