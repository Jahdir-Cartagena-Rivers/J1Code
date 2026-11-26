import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { checkpointWorkspace } from "@j1code/provider-testing/replayWorkspace";
import {
  BotId, CommandId, EventId, ProjectId, ProviderDriverKind, ProviderInstanceId, ProviderThreadId, ProviderTurnId,
  RuntimeRequestId, ThreadId, TurnItemId,
  type OrchestrationV2StoredEvent, type ServerProvider,
} from "@j1code/contracts";
import type * as ProviderAdapter from "@j1code/provider-core/server/ProviderAdapter";
import type { ProviderInstance } from "@j1code/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { OrchestrationEffectWorkerV2 } from "../orchestration-v2/EffectWorker.ts";
import { EventSinkStreamError, EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ProviderTurnControlServiceV2 } from "../orchestration-v2/ProviderTurnControlService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { compatibilityMessageId, compatibilityStartCommandId } from "./CompatibilityApproval.ts";
import { MausbotExecutionHost } from "./ExecutionHost.ts";
import { botExecutionThreadIdV2, type ExecutionV2StartInput } from "./ExecutionV2.ts";
import * as ExecutionV2Live from "./ExecutionV2Live.ts";
import { MausbotRuntime } from "./Runtime.ts";
import type { ReadSavedNativeBotEnrollment } from "./NativeBotEnrollment.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const projectId = ProjectId.make("mausbot-host-replay");
const botId = "sqlite-bot";
const hostThread = (id: string) => botExecutionThreadIdV2(botId, id);

const unused = () => Effect.die("Unexpected provider method in bot event replay");
type FinishTurn = (status: "completed" | "interrupted") => Effect.Effect<void>;
const fixtureAdapter = (
  finish: Map<ProviderTurnId, FinishTurn>,
  cwd: string,
  onApproval?: (requestId: RuntimeRequestId, decision: string | undefined) => void,
  onResume?: (nativeThreadId: string) => void,
): ProviderAdapter.ProviderAdapterV2["Service"] => ({
  driver,
  instanceId,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: (input) => Effect.gen(function* () {
    const now = yield* DateTime.now;
    const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    const startTurn = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) => Effect.gen(function* () {
      const providerTurn = {
        id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
        providerThreadId: turn.providerThread.id, nodeId: turn.rootNodeId,
        runAttemptId: turn.attemptId,
        nativeTurnRef: { driver, nativeId: `native-turn:${turn.attemptId}`, strength: "strong" as const },
        ordinal: turn.providerTurnOrdinal, status: "running" as const, startedAt: now, completedAt: null,
      };
      finish.set(providerTurn.id, status => Effect.gen(function* () {
        const completedAt = yield* DateTime.now;
        finish.delete(providerTurn.id);
        yield* Queue.offer(events, {
          type: "provider_turn.updated", driver,
          providerTurn: { ...providerTurn, status, completedAt },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal", driver,
          providerThreadId: providerTurn.providerThreadId, providerTurnId: providerTurn.id,
          runOrdinal: turn.runOrdinal, status, failure: null, threadDisposition: "reusable",
        });
      }));
      yield* Queue.offer(events, { type: "provider_turn.updated", driver, providerTurn });
      if (onApproval && turn.runOrdinal === 1) {
        const requestId = RuntimeRequestId.make(`fixture-approval:${turn.attemptId}`);
        yield* Queue.offer(events, {
          type: "runtime_request.updated", driver, threadId: turn.appThread.id,
          runtimeRequest: {
            id: requestId, providerTurnId: providerTurn.id, nodeId: turn.rootNodeId, kind: "command",
            nativeRequestRef: { driver, nativeId: `native:${requestId}`, strength: "strong" },
            status: "pending", responseCapability: { type: "live", providerSessionId: input.providerSessionId },
            createdAt: now, resolvedAt: null,
          },
        });
        yield* Queue.offer(events, {
          type: "turn_item.updated", driver,
          turnItem: {
            id: TurnItemId.make(`item:${requestId}`), threadId: turn.appThread.id,
            runId: turn.runId, nodeId: turn.rootNodeId, providerThreadId: turn.providerThread.id,
            providerTurnId: providerTurn.id, nativeItemRef: null, parentItemId: null, ordinal: 0,
            status: "pending", title: "Fixture consent", startedAt: now, completedAt: null, updatedAt: now,
            type: "approval_request", requestId, requestKind: "command",
          },
        });
      }
    });
    return {
      instanceId, driver, providerSessionId: input.providerSessionId,
      providerSession: {
        id: input.providerSessionId, driver, providerInstanceId: instanceId,
        status: "ready", cwd: input.runtimePolicy.cwd ?? cwd, model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2, createdAt: now, updatedAt: now, lastError: null,
      },
      events: Stream.fromQueue(events),
      ensureThread: ({ threadId }) => Effect.succeed({
        id: ProviderThreadId.make(`provider-thread:${threadId}`),
        driver, providerInstanceId: instanceId, providerSessionId: input.providerSessionId,
        appThreadId: threadId, ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
        nativeConversationHeadRef: null, status: "idle", firstRunOrdinal: null,
        lastRunOrdinal: null, handoffIds: [], forkedFrom: null, createdAt: now, updatedAt: now,
      }),
      resumeThread: ({ providerThread }) => Effect.sync(() => {
        if (providerThread.nativeThreadRef?.nativeId) onResume?.(providerThread.nativeThreadRef.nativeId);
        return providerThread;
      }),
      startTurn,
      botTurnStart: {
        supportsRestrictedTools: true,
        start: (turn, context) => Effect.gen(function* () {
          assert.isTrue(yield* context.authorizeNativeWrite);
          yield* startTurn(turn);
        }),
      },
      steerTurn: unused,
      respondToRuntimeRequest: onApproval
        ? ({ requestId, decision }) => Effect.sync(() => onApproval(requestId, decision))
        : unused,
      interruptTurn: ({ providerTurnId }) => finish.get(providerTurnId)?.("interrupted") ?? Effect.void,
      readThreadSnapshot: unused, rollbackThread: unused, forkThread: unused,
    };
  }),
});

const fixtureRegistry = (
  finish: Map<ProviderTurnId, FinishTurn>,
  cwd: string,
  onApproval?: (requestId: RuntimeRequestId, decision: string | undefined) => void,
  onResume?: (nativeThreadId: string) => void,
) => Effect.gen(function* () {
  const changes = yield* PubSub.unbounded<void>();
  const snapshot: ServerProvider = {
    instanceId, driver, enabled: true, installed: true, version: null, checkedAt: null,
    status: "ready", auth: { status: "authenticated" }, slashCommands: [], skills: [],
    models: [{ slug: modelSelection.model, name: "Fixture model", isCustom: false, capabilities: null }],
  };
  const instance: ProviderInstance = {
    instanceId, driverKind: driver, enabled: true, displayName: "Fixture account",
    continuationIdentity: { driverKind: driver, continuationKey: "fixture-account" },
    snapshot: {
      getSnapshot: Effect.succeed(snapshot), refresh: Effect.succeed(snapshot),
      streamChanges: Stream.empty, applyUsageLimits: () => Effect.void,
    },
    orchestrationAdapter: fixtureAdapter(finish, cwd, onApproval, onResume),
    textGeneration: {} as ProviderInstance["textGeneration"],
  };
  const instances = ProviderInstanceRegistry.of({
    getInstance: id => Effect.succeed(id === instanceId ? instance : undefined),
    listInstances: Effect.succeed([instance]), listUnavailable: Effect.succeed([]),
    streamChanges: Stream.fromPubSub(changes), subscribeChanges: PubSub.subscribe(changes),
  });
  return { instanceLayer: Layer.succeed(ProviderInstanceRegistry, instances), changes };
});

const isLifecycleEvent = (value: unknown) => {
  const message = value as { event?: { type?: string } };
  return message.event?.type?.startsWith("turn.") === true;
};

const finishAndDrain = (
  finish: FinishTurn,
  sink: EventSinkV2["Service"],
  worker: OrchestrationEffectWorkerV2["Service"],
  threadId: ThreadId,
) => Effect.gen(function* () {
  const afterSequence = yield* sink.latestSequence();
  yield* finish("completed");
  // Native completion queues a checkpoint. This harness drives its effect worker manually.
  yield* sink.stream({ threadId, afterSequence }).pipe(
    Stream.filter(({ event }) => event.type === "run.updated" && event.payload.status === "waiting"),
    Stream.take(1), Stream.runDrain,
  );
  yield* worker.drain();
});

it.live("replays SQLite events across reader failure and continues the imported bot thread after host reopen", () =>
  Effect.gen(function* () {
    const finish = new Map<ProviderTurnId, FinishTurn>();
    const cwd = yield* checkpointWorkspace("mausbot-host-sqlite-replay");
    const { instanceLayer, changes } = yield* fixtureRegistry(finish, cwd);
    const graph = ProviderReplayHarness.layerWithRegistry(
      { name: "mausbot-host-sqlite-replay" },
      ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(Layer.provide(instanceLayer)),
      { runEffectWorker: false },
    );

    yield* Effect.gen(function* () {
      const sink = yield* EventSinkV2;
      const orchestrator = yield* OrchestratorV2;
      const worker = yield* OrchestrationEffectWorkerV2;
      const projects = yield* ProjectStoreV2;
      const control = yield* ProviderTurnControlServiceV2;
      const settings = yield* ServerSettingsService;
      const config = yield* ServerConfig;
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* projects.apply({
        sequence: 0, eventId: EventId.make("fixture-project"), aggregateKind: "project",
        aggregateId: projectId, type: "project.created", occurredAt: at,
        commandId: null, causationEventId: null, correlationId: null, metadata: {},
        payload: { projectId, title: "Fixture project", workspaceRoot: cwd,
          defaultModelSelection: modelSelection, scripts: [], createdAt: at, updatedAt: at },
      });
      yield* settings.insertBotProfileIfAbsent({
        id: BotId.make(`mausbot:${botId}`), name: "Fixture bot", projectId, modelSelection,
        instructions: "", description: "", archived: false, pinned: false, createdAt: at, updatedAt: at,
      });
      const baseline = yield* orchestrator.dispatch({
        type: "thread.create", commandId: CommandId.make("pre-host"), threadId: ThreadId.make("pre-host"),
        projectId, title: "Ordinary J1 thread", modelSelection, branch: null, worktreePath: null,
        interactionMode: "default", runtimeMode: "approval-required", createdBy: "user", creationSource: "web",
      });
      const before = yield* sink.latestSequence();
      assert.equal(before, baseline.sequence);
      assert.isAbove(before, 0);

      const subscribe = yield* Deferred.make<void>();
      const resumed = yield* Deferred.make<number | undefined>();
      const readerClosed = yield* Deferred.make<void>();
      const catalog = yield* Deferred.make<unknown>();
      const cursors: Array<number | undefined> = [];
      const stopped: ThreadId[] = [];
      const coldCommands: string[] = [];
      const isNativeStart = ({ event }: OrchestrationV2StoredEvent) =>
        event.threadId === hostThread("first") && event.type === "provider-turn.updated" &&
        event.payload.status === "running" && event.payload.nativeTurnRef?.nativeId != null;
      const observedSink = EventSinkV2.of({
        ...sink,
        stream: (options) => {
          cursors.push(options?.afterSequence);
          if (cursors.length > 1)
            return Stream.unwrap(Deferred.succeed(resumed, options?.afterSequence).pipe(
              Effect.as(sink.stream(options)),
            )).pipe(Stream.ensuring(Deferred.succeed(readerClosed, undefined)));
          return Stream.unwrap(Deferred.await(subscribe).pipe(Effect.as(Stream.concat(
            sink.stream(options).pipe(Stream.takeUntil(isNativeStart)),
            Stream.fail(new EventSinkStreamError({ afterSequence: options?.afterSequence ?? 0 })),
          ))));
        },
      });
      // Include already committed provider events in the first dispatch receipt.
      // The host must still deliver events only from its ordered store reader.
      const hostOrchestrator = OrchestratorV2.of({
        ...orchestrator,
        dispatch: (command) => Effect.gen(function* () {
          if ("threadId" in command && command.threadId === hostThread("first"))
            coldCommands.push(command.type);
          const receipt = yield* orchestrator.dispatch(command);
          if (command.type === "thread.stop") stopped.push(command.threadId);
          if (command.type !== "message.dispatch" || command.threadId !== hostThread("first"))
            return receipt;
          yield* worker.drain().pipe(Effect.orDie);
          const storedEvents = yield* sink.stream({
            threadId: command.threadId, afterSequence: before,
          }).pipe(Stream.takeUntil(isNativeStart), Stream.runCollect, Effect.orDie);
          assert.isTrue(storedEvents.some(isNativeStart));
          return { ...receipt, storedEvents };
        }),
      });
      const hostLayer = (eventSource: EventSinkV2["Service"], commands: OrchestratorV2["Service"]) =>
        ExecutionV2Live.layer.pipe(Layer.provide(Layer.mergeAll(
          Layer.succeed(EventSinkV2, eventSource), Layer.succeed(OrchestratorV2, commands),
          Layer.succeed(ProjectStoreV2, projects), Layer.succeed(ProviderTurnControlServiceV2, control),
          Layer.succeed(ServerSettingsService, settings), Layer.succeed(ServerConfig, config), instanceLayer,
        )));
      const layer = hostLayer(observedSink, hostOrchestrator);
      const owner = { id: "first-owner" };
      const next = { id: "next-owner" };
      const input = (threadId: string): ExecutionV2StartInput => ({
        action: "start", botId, threadId, turnId: `turn-${threadId}`, botName: "Fixture bot",
        title: "SQLite replay", instanceId, model: modelSelection.model, cwd,
        text: "A new authored prompt", system: "", sharedContinuation: false,
        restrictedTools: true, guestConfined: false, approvalMode: "ask", images: [], tools: [],
      });
      const firstInput = input("first");
      const history = [
        { nativeMessageId: "old-question", role: "user", text: "Saved question",
          createdAt: "2026-01-01T00:00:01.000Z", completedAt: null, attachments: [] },
        { nativeMessageId: "old-answer", role: "assistant", text: "Saved answer",
          createdAt: "2026-01-01T00:00:02.000Z", completedAt: "2026-01-01T00:00:03.000Z", attachments: [] },
      ] as const;
      const readSaved: ReadSavedNativeBotEnrollment = async (id, threadId) => {
        assert.deepEqual([id, threadId], [botId, firstInput.threadId]);
        return {
          botId, threadId, name: "Fixture bot", description: "", instructions: "",
          projectId, threadProjectId: projectId, modelSelection, threadSelection: modelSelection,
          approvalMode: "ask", restrictedTools: true,
          coldHistory: { turnId: firstInput.turnId, anchorMessageId: "cold-anchor",
            promptText: firstInput.text, promptAttachments: [], messages: history },
        };
      };
      const complete = (record: OrchestrationV2StoredEvent) => {
        const finishTurn = record.event.type === "provider-turn.updated" && finish.get(record.event.payload.id);
        return finishTurn
          ? finishAndDrain(finishTurn, sink, worker, record.event.threadId)
          : Effect.die("Missing persisted fixture provider turn");
      };
      const storedStart = (threadId: ThreadId) => sink.stream({ threadId, afterSequence: before }).pipe(
        Stream.filter(({ event }) => event.type === "provider-turn.updated" &&
          event.payload.status === "running" && event.payload.nativeTurnRef?.nativeId != null),
        Stream.take(1),
        Stream.runCollect,
        Effect.map(records => records[0]!),
      );
      const { host, cursor } = yield* Effect.gen(function* () {
        const host = yield* MausbotExecutionHost;
        const inbox = yield* Queue.unbounded<unknown>();
        const nextInbox = yield* Queue.unbounded<unknown>();
        const emitted: unknown[] = [];
        const send = (queue: typeof inbox) => (value: unknown) => {
          if (!isLifecycleEvent(value)) return;
          emitted.push(value);
          Effect.runSync(Queue.offer(queue, value));
        };
        const live = () => true;
        const replacedCatalog: unknown[] = [];
        const watch = (emit: (event: unknown) => void) => Effect.promise(() =>
          host.call({ action: "watch-catalog" }, live, emit, owner),
        );
        yield* watch(event => replacedCatalog.push(event));
        yield* watch(event => { Effect.runSync(Deferred.succeed(catalog, event)); });
        yield* PubSub.publish(changes, undefined);
        assert.nestedPropertyVal(yield* Deferred.await(catalog), "kind", "catalog");
        assert.deepEqual(replacedCatalog, []);
        yield* Effect.promise(() => host.call(
          { ...firstInput, recoveryText: history[0].text }, live, send(inbox), owner, readSaved,
        ));
        const first = yield* storedStart(hostThread("first"));
        assert.isAbove(first.sequence, before);
        assert.deepEqual(emitted, []);
        yield* Deferred.succeed(subscribe, undefined);
        const started = yield* Queue.take(inbox);
        assert.nestedPropertyVal(started, "event.type", "turn.started");
        const cursor = (started as { event?: { payload?: { resumeCursor?: unknown } } }).event?.payload?.resumeCursor;
        if (typeof cursor !== "string") return yield* Effect.die("Expected the live V2 resume cursor");
        const foreignStop = yield* Effect.result(Effect.tryPromise(() => host.call(
          { action: "stop", botId, threadId: "first" }, live, send(nextInbox), next,
        )));
        assert.equal(foreignStop._tag, "Failure");
        assert.deepEqual(emitted, [started]);

        const resumeCursor = yield* Deferred.await(resumed);
        assert.equal(resumeCursor, first.sequence);
        yield* complete(first);
        assert.nestedPropertyVal(yield* Queue.take(inbox), "event.type", "turn.completed");
        assert.lengthOf(emitted, 2);
        yield* Effect.promise(() => host.disconnect(owner));
        const denied = yield* Effect.result(Effect.tryPromise(() =>
          host.call({ action: "watch-catalog" }, live, send(inbox), owner),
        ));
        assert.equal(denied._tag, "Failure");

        yield* Effect.promise(() => host.call(input("neighbor"), live, send(nextInbox), next));
        yield* worker.drain();
        assert.isAbove((yield* storedStart(hostThread("neighbor"))).sequence, first.sequence);
        assert.nestedPropertyVal(yield* Queue.take(nextInbox), "event.type", "turn.started");
        assert.lengthOf(emitted, 3);
        return { host, cursor };
      }).pipe(Effect.provide(layer), Effect.scoped);
      yield* Deferred.await(readerClosed);
      assert.deepEqual(stopped, [hostThread("neighbor")]);
      assert.lengthOf(cursors, 2);
      assert.equal(cursors[0], before);
      assert.isAbove(cursors[1]!, before);
      const denied = yield* Effect.result(Effect.tryPromise(() => host.call(
        { action: "watch-catalog" }, () => true, () => {}, { id: "after-close" },
      )));
      assert.equal(denied._tag, "Failure");

      const threadId = hostThread("first");
      const cold = yield* orchestrator.getThreadRecords(threadId, ["messages", "runs"]);
      const coldTexts = [...history.map(message => message.text), firstInput.text];
      assert.deepEqual(coldCommands, ["thread.bot.create", "thread.bot.history.import", "message.dispatch"]);
      assert.deepEqual(cold.messages.map(message => message.text), coldTexts);
      assert.deepEqual(cold.runs.map(run => run.status), ["completed"]);
      const reopenSequence = yield* sink.latestSequence();
      const warmInput = { ...firstInput, turnId: "warm-turn", text: "A warm authored prompt",
        sharedContinuation: true, recoveryText: history[0].text };
      const warmCommands: string[] = [];
      const warmOrchestrator = OrchestratorV2.of({
        ...orchestrator,
        dispatch: (command) => {
          warmCommands.push(command.type);
          return orchestrator.dispatch(command);
        },
      });
      yield* Effect.gen(function* () {
        const reopened = yield* MausbotExecutionHost;
        assert.notStrictEqual(reopened, host);
        const inbox = yield* Queue.unbounded<unknown>();
        const emitted: unknown[] = [];
        const send = (event: unknown) => {
          if (!isLifecycleEvent(event)) return;
          emitted.push(event);
          Effect.runSync(Queue.offer(inbox, event));
        };
        const owner = { id: "reopened-owner" };
        const resumeTurnId = "restricted-resume";
        const restricted = yield* Effect.result(Effect.tryPromise({
          try: () => reopened.call({
            ...firstInput, sharedContinuation: true, turnId: resumeTurnId, text: "",
          }, () => true, send, owner, async (id, nativeThreadId, request) => {
            assert.deepEqual(request, { resumeTurnId });
            const saved = await readSaved(id, nativeThreadId);
            return saved && { ...saved, savedResumeCursor: cursor };
          }),
          catch: error => String(error),
        }));
        assert.equal(restricted._tag, "Failure");
        if (restricted._tag === "Failure")
          assert.match(restricted.failure, /no exact native continuation|cannot resume this bot run with its selected tool scope/);
        assert.deepEqual(warmCommands, []);
        yield* Effect.promise(() => reopened.call(warmInput, () => true, send, owner,
          () => Promise.reject(new Error("Warm continuation must not reread cold enrollment"))));
        yield* worker.drain();
        const warm = yield* sink.stream({ threadId, afterSequence: reopenSequence }).pipe(
          Stream.filter(isNativeStart), Stream.take(1), Stream.runCollect,
        );
        assert.lengthOf(warm, 1);
        assert.nestedPropertyVal(yield* Queue.take(inbox), "event.type", "turn.started");
        yield* complete(warm[0]!);
        assert.nestedPropertyVal(yield* Queue.take(inbox), "event.type", "turn.completed");
        assert.lengthOf(emitted, 2);
      }).pipe(Effect.provide(hostLayer(sink, warmOrchestrator)), Effect.scoped);
      const saved = yield* orchestrator.getThreadRecords(threadId, ["messages", "runs"]);
      assert.deepEqual(saved.messages.map(message => message.text), [...coldTexts, warmInput.text]);
      assert.deepEqual(saved.messages.slice(0, cold.messages.length), cold.messages);
      assert.deepEqual(saved.runs.map(run => run.status), ["completed", "completed"]);
      assert.deepEqual(warmCommands, ["message.dispatch"]);
      assert.isNull((yield* orchestrator.getThreadShell(threadId))?.deletedAt);
    }).pipe(Effect.provide(graph));
  }).pipe(Effect.provide(NodeServices.layer)),
);

const ipcFixture = `
const http = require("node:http");
const pending = new Map();
const submissions = new Map();
const events = [];
const waiters = new Map();
let next = 0;
let owner = "";
function reply(res, payload, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}
const server = http.createServer((req, res) => {
  if (req.url === "/api/edition") return reply(res, { edition: "oss" });
  if (req.url === "/api/auth/pairing") {
    if (req.headers["x-openmausbot-cli-owner"] !== owner.trim() &&
        req.headers.authorization !== "Bearer fixture-only-token") return reply(res, {}, 403);
    req.resume();
    return reply(res, { code: "fixture-only-code" });
  }
  if (req.url === "/api/auth/pair") {
    req.resume();
    return reply(res, { token: "fixture-only-token" });
  }
  if (req.headers.authorization !== "Bearer fixture-only-token") return reply(res, {}, 401);
  if (req.url === "/api/auth/session") return reply(res, { scope: "admin" });
  if (req.url === "/api/bots/fixture-call" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const requestId = String(++next);
      pending.set(requestId, res);
      const input = JSON.parse(body);
      if (input.action === "start" && input.text) submissions.set(input.threadId, input);
      process.send({ type: "j1:execution-request", requestId, input });
    });
    return;
  }
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/bots/fixture-event") {
    const type = url.searchParams.get("type");
    const event = events.find(row => row.event?.type === type);
    if (event) return reply(res, event);
    const timeout = setTimeout(() => { waiters.delete(type); reply(res, {}, 504); }, 5000);
    waiters.set(type, value => { clearTimeout(timeout); reply(res, value); });
    return;
  }
  reply(res, {}, 404);
});
process.on("message", message => {
  if (message.type === "j1:execution-result") {
    const res = pending.get(message.requestId);
    if (res) reply(res, message, message.error ? 409 : 200);
    pending.delete(message.requestId);
  }
  if (message.type === "j1:execution-event") {
    events.push(message.event);
    const waiter = waiters.get(message.event.event?.type);
    if (waiter) {
      waiters.delete(message.event.event.type);
      waiter(message.event);
    }
  }
  if (message.type === "j1:saved-bot-enrollment-query") {
    const input = submissions.get(message.threadId);
    let value = null;
    if (input && input.botId === message.botId && !message.resumeTurnId &&
        (!message.turnId || message.turnId === input.turnId)) {
      const selection = { instanceId: input.instanceId, model: input.model };
      value = { botId: input.botId, threadId: input.threadId, name: input.botName, description: "",
        instructions: "", projectId: input.projectId, threadProjectId: input.projectId,
        modelSelection: selection, threadSelection: selection,
        approvalMode: input.approvalMode, restrictedTools: input.restrictedTools };
      if (message.turnId) value.nativeHistory = {
        turnId: input.turnId, anchorMessageId: "saved-authored-input", workspaceRoot: input.cwd,
        promptText: input.text, promptAttachments: [], messages: [],
      };
    }
    process.send({ type: "j1:saved-bot-enrollment-result", requestId: message.requestId, value });
  }
  if (message.type === "j1:browser")
    process.send({ type: "j1:browser-applied", requestId: message.requestId });
  if (message.type === "j1:shutdown") server.close(() => process.exit(0));
});
process.once("disconnect", () => server.close(() => process.exit(0)));
process.stdin.setEncoding("utf8");
process.stdin.on("data", value => { owner += value; });
process.stdin.on("end", () => server.listen(Number(process.env.OMB_PORT), "127.0.0.1", () =>
  console.log("openmausbot server on http://127.0.0.1:" + process.env.OMB_PORT)));
`;

const startIpcFixture = (resources: string, dataDir: string, host: MausbotExecutionHost["Service"]) =>
  Effect.acquireRelease(
    Effect.sync(() => new MausbotRuntime({ platform: "linux", resources, dataDir, execution: host })),
    (runtime) => Effect.promise(() => runtime.stop()),
  ).pipe(Effect.tap(runtime => Effect.promise(() => runtime.start())));

const ipcCall = (runtime: MausbotRuntime, input: unknown) =>
  Effect.promise(async () => {
    const response = await runtime.forward("/api/bots/fixture-call", "POST", "application/json",
      new TextEncoder().encode(JSON.stringify(input)));
    return { status: response.status, result: await response.json() as {
      value?: unknown; error?: string;
    } };
  });

const ipcEvent = (runtime: MausbotRuntime, type: string) =>
  Effect.promise(async () => {
    const response = await runtime.forward("/api/bots/fixture-event?type=" + type, "GET");
    assert.equal(response.status, 200);
    return await response.json() as { event: { type: string; requestId?: string } };
  });

it.live("completes ordinary bot turns through managed IPC and reopens saved state", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const resources = path.join(directory, "resources");
    const dataDir = path.join(directory, "mausbot");
    yield* fs.makeDirectory(path.join(resources, "server"), { recursive: true });
    yield* fs.writeFileString(path.join(resources, "server", "index.js"), ipcFixture);
    const db = SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite")).pipe(Layer.provide(NodeServices.layer));
    const finish = new Map<ProviderTurnId, FinishTurn>();
    const approvals: Array<{ requestId: RuntimeRequestId; decision: string | undefined }> = [];
    const cwd = yield* checkpointWorkspace("mausbot-compatibility-submission");
    const resumedNativeThreads: string[] = [];
    const { instanceLayer } = yield* fixtureRegistry(
      finish, cwd,
      (requestId, decision) => approvals.push({ requestId, decision }),
      (nativeThreadId) => resumedNativeThreads.push(nativeThreadId),
    );
    const graph = ProviderReplayHarness.layerWithRegistry(
      { name: "mausbot-compatibility-submission" },
      ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(Layer.provide(instanceLayer)),
      { databaseLayer: db, runEffectWorker: false },
    );
    const ownership = { botId, nativeThreadId: "compat-submission", nativeTurnId: "new-turn" };
    const threadId = hostThread(ownership.nativeThreadId);
    const messageId = compatibilityMessageId(ownership);
    const at = DateTime.formatIso(yield* DateTime.now);
    const input: ExecutionV2StartInput = {
      action: "start", botId, threadId: ownership.nativeThreadId, turnId: ownership.nativeTurnId,
      botName: "Fixture bot", title: "Compatibility submission", projectId, instanceId, model: modelSelection.model,
      cwd, text: "Persist the ordinary submission", system: "", sharedContinuation: false,
      restrictedTools: true, guestConfined: false, approvalMode: "ask", images: [], tools: [],
    };
    const hostLayer = ExecutionV2Live.layer.pipe(Layer.provideMerge(Layer.mergeAll(graph, instanceLayer)));
    const committed = yield* Effect.gen(function* () {
      const projects = yield* ProjectStoreV2;
      const settings = yield* ServerSettingsService;
      const host = yield* MausbotExecutionHost;
      const orchestrator = yield* OrchestratorV2;
      yield* projects.apply({
        sequence: 0, eventId: EventId.make("compat-project"), aggregateKind: "project",
        aggregateId: projectId, type: "project.created", occurredAt: at,
        commandId: null, causationEventId: null, correlationId: null, metadata: {},
        payload: { projectId, title: "Fixture project", workspaceRoot: cwd,
          defaultModelSelection: modelSelection, scripts: [], createdAt: at, updatedAt: at },
      });
      yield* settings.insertBotProfileIfAbsent({
        id: BotId.make(`mausbot:${botId}`), name: input.botName, projectId, modelSelection,
        instructions: "", description: "", archived: false, pinned: false, createdAt: at, updatedAt: at,
      });
      const spoof = yield* Effect.result(orchestrator.dispatch({
        type: "message.dispatch", commandId: compatibilityStartCommandId(ownership),
        threadId, messageId, text: "Unscoped", attachments: [], modelSelection,
        dispatchMode: { type: "start_immediately" }, createdBy: "user", creationSource: "server",
      }));
      assert.equal(spoof._tag, "Failure");
      const runtime = yield* startIpcFixture(resources, dataDir, host);
      const catalog = yield* ipcCall(runtime, { action: "catalog" });
      assert.equal(catalog.status, 200);
      assert.include((catalog.result.value as Array<ServerProvider>).map(row => row.instanceId), instanceId);
      const sink = yield* EventSinkV2;
      const worker = yield* OrchestrationEffectWorkerV2;
      const submission = yield* ipcCall(runtime, input);
      assert.equal(submission.status, 200, submission.result.error);
      yield* worker.drain();
      const requestId = (yield* ipcEvent(runtime, "request.opened")).event.requestId;
      if (!requestId) throw new Error("Missing owned approval request");
      const respond = {
        action: "respond", botId, threadId: ownership.nativeThreadId, requestId, decision: "decline",
      };
      const foreign = yield* Effect.result(Effect.tryPromise({
        try: () => host.call(respond, () => true, () => {}, { id: "foreign-host" }),
        catch: String,
      }));
      assert.equal(foreign._tag, "Failure");
      assert.equal((yield* ipcCall(runtime, respond)).status, 200);
      yield* worker.drain();
      assert.deepEqual(approvals, [{ requestId: RuntimeRequestId.make(requestId), decision: "decline" }]);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(projection.messages.map(({ id, text }) => ({ id, text })), [{ id: messageId, text: input.text }]);
      assert.lengthOf(projection.runs, 1);
      const run = projection.runs[0]!;
      assert.equal(run.userMessageId, messageId);
      assert.isNotNull(run.activeAttemptId);
      assert.include(projection.attempts.map(row => row.id), run.activeAttemptId);
      const providerTurn = projection.providerTurns.find(row => row.runAttemptId === run.activeAttemptId);
      const finishTurn = providerTurn && finish.get(providerTurn.id);
      if (!finishTurn) throw new Error("The owned fixture provider turn did not start.");
      yield* finishAndDrain(finishTurn, sink, worker, threadId);
      yield* ipcEvent(runtime, "turn.completed");
      return { runId: run.id, attemptId: run.activeAttemptId, requestId };
    }).pipe(Effect.provide(hostLayer), Effect.scoped);

    yield* Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(projection.messages.map(({ id, text }) => ({ id, text })), [{ id: messageId, text: input.text }]);
      assert.lengthOf(projection.runs, 1);
      assert.equal(projection.runs[0]?.id, committed.runId);
      assert.equal(projection.runs[0]?.status, "completed");
      assert.equal(projection.runs[0]?.userMessageId, messageId);
      assert.equal(projection.attempts.find(row => row.id === committed.attemptId)?.runId, committed.runId);
      assert.equal(projection.runtimeRequests.find(row => row.id === committed.requestId)?.decision, "decline");
      const host = yield* MausbotExecutionHost;
      const runtime = yield* startIpcFixture(resources, dataDir, host);
      const stale = yield* ipcCall(runtime, {
        action: "respond", botId, threadId: ownership.nativeThreadId, requestId: committed.requestId, decision: "accept",
      });
      assert.equal(stale.status, 409);
      const recovery = yield* ipcCall(runtime, {
        ...input, turnId: "promptless-recovery", text: "", sharedContinuation: true,
      });
      assert.equal(recovery.status, 409);
      assert.include(recovery.result.error, "no exact native continuation to resume");

      const nativeThreadId = projection.providerThreads.find(row =>
        row.id === projection.thread.activeProviderThreadId)?.nativeThreadRef?.nativeId;
      assert.isString(nativeThreadId);
      const sink = yield* EventSinkV2;
      const worker = yield* OrchestrationEffectWorkerV2;
      const afterSequence = yield* sink.latestSequence();
      const nextInput = { ...input, turnId: "reopened-turn", text: "Continue the saved thread", sharedContinuation: true };
      const submission = yield* ipcCall(runtime, nextInput);
      assert.equal(submission.status, 200, submission.result.error);
      yield* worker.drain();
      const started = yield* sink.stream({ threadId, afterSequence }).pipe(
        Stream.filter(({ event }) => event.type === "provider-turn.updated" && event.payload.status === "running"),
        Stream.take(1), Stream.runCollect,
      );
      const event = started[0]?.event;
      const finishTurn = event?.type === "provider-turn.updated" && finish.get(event.payload.id);
      if (!finishTurn) throw new Error("The reopened fixture provider turn did not start.");
      yield* finishAndDrain(finishTurn, sink, worker, threadId);
      yield* ipcEvent(runtime, "turn.completed");
      assert.deepEqual(resumedNativeThreads, [nativeThreadId]);
      const reopened = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(reopened.runs.map(run => run.status), ["completed", "completed"]);
      assert.deepEqual(reopened.messages.map(message => message.text), [input.text, nextInput.text]);
    }).pipe(Effect.provide(hostLayer), Effect.scoped);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
