import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type AgentSessionSource,
  type ServerSettingsError,
  BotId,
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  MessageId,
  NodeId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type ApplicationStoredEvent,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
} from "@j1code/contracts";
import * as IdAllocator from "@j1code/provider-core/server/IdAllocator";
import * as AcpRegistryRuntimeCoordinator from "@j1code/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as ProviderAdapter from "@j1code/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import {
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
} from "../orchestration-v2/testkit/fixtures/shared.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const timestamp = "2026-09-01T10:00:00.000Z";
const now = DateTime.makeUnsafe(timestamp);
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const persistence = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  IdAllocator.layer,
);

function candidate(
  modelSelection: typeof CODEX_MODEL_SELECTION,
  providerSessionId: string,
  provider: AgentSessionSource = "codex",
) {
  const providerInstanceId = modelSelection.instanceId;
  return {
    _tag: "Importable" as const,
    source: {
      provider,
      providerInstanceId,
      providerSessionId,
      filePath: `/tmp/${providerInstanceId}/${providerSessionId}.jsonl`,
      size: 100,
      mtimeMs: 2,
      device: 3,
      inode: 4,
      birthtimeMs: 1,
    },
    thread: {
      source: provider,
      providerInstanceId,
      providerSessionId,
      title: "Imported thread",
      model: modelSelection.model,
      createdAt: timestamp,
      updatedAt: timestamp,
      omittedMessageCount: 0,
      messages: [
        { role: "user" as const, text: "Fix it", createdAt: timestamp },
        { role: "assistant" as const, text: "Fixed", createdAt: timestamp },
      ],
    },
    worktree: null as { path: string; branch: string | null } | null,
  } satisfies AgentSessionScanner.AgentSessionRecentThread;
}

const PI_MODEL_SELECTION = { instanceId: ProviderInstanceId.make("pi"), model: "default" };

// Pi threads are owned by their session file path, not the session UUID.
const nativeId = ({ source }: ReturnType<typeof candidate>) =>
  source.provider === "pi" ? source.filePath : source.providerSessionId;

function importId(source: ReturnType<typeof candidate>) {
  return ThreadId.make(
    `import:${source.source.providerInstanceId}:${source.source.providerSessionId}`,
  );
}

const seedOwner = Effect.fn(function* (
  source: ReturnType<typeof candidate>,
  lifecycle: "active" | "archived" | "deleted" = "active",
  identity: Partial<Pick<OrchestrationV2AppThread, "id" | "projectId" | "bot">> = {},
) {
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const { providerInstanceId, providerSessionId, provider } = source.source;
  const nativeThreadId = nativeId(source);
  const threadId = identity.id ?? ThreadId.make(`owner:${providerInstanceId}:${providerSessionId}`);
  const driver = ProviderDriverKind.make(provider);
  const providerThread: OrchestrationV2ProviderThread = {
    id: ids.derive.providerThread({ driver, nativeThreadId }),
    driver,
    providerInstanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: nativeThreadId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Native thread",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: source.thread.model },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: lifecycle === "archived" ? now : null,
    deletedAt: lifecycle === "deleted" ? now : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    ...identity,
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make(`${threadId}:created`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
      {
        id: EventId.make(`${threadId}:provider`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: providerThread,
      },
    ],
  });
  return threadId;
});

const makeImporter = Effect.fn(function* (
  candidates: ReadonlyArray<AgentSessionScanner.AgentSessionRecentThread>,
  beforeTransaction: Effect.Effect<void> = Effect.void,
  getAdapter?: ProviderAdapterRegistry.ProviderAdapterRegistryV2Shape["get"],
  threadCommands?: ThreadCommandExecutor.ThreadCommandExecutor["Service"],
  settings: Layer.Layer<
    ServerSettings.ServerSettingsService,
    ServerSettingsError
  > = ServerSettings.layerTest(),
  realScan?: {
    readonly workspaceRoot: string;
    readonly scanner: AgentSessionScanner.AgentSessionScanner["Service"];
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* EventStore.EventStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const published: Array<ApplicationStoredEvent> = [];
  const withTransaction: typeof sql.withTransaction = (effect) =>
    beforeTransaction.pipe(Effect.andThen(sql.withTransaction(effect)));
  const importSql = new Proxy(sql, {
    get: (target, key, receiver) =>
      key === "withTransaction" ? withTransaction : Reflect.get(target, key, receiver),
  });
  const sinkLayer = Layer.fresh(EventSink.layer).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SqlClient.SqlClient, importSql),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
        Layer.succeed(EventStore.EventStoreV2, {
          ...events,
          publishCommitted: (batch) =>
            events.publishCommitted(batch).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  published.push(...batch);
                }),
              ),
            ),
        }),
      ),
    ),
  );
  const context = yield* Layer.build(
    AgentSessionImporter.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          sinkLayer,
          Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
          settings,
          Layer.succeed(IdAllocator.IdAllocatorV2, yield* IdAllocator.IdAllocatorV2),
          Layer.succeed(
            ProviderSessionRuntime.ProviderSessionRuntimeRepository,
            yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository,
          ),
          realScan === undefined
            ? Layer.mock(AgentSessionScanner.AgentSessionScanner)({
                recentThreads: () => Stream.fromIterable(candidates),
              })
            : Layer.succeed(AgentSessionScanner.AgentSessionScanner, realScan.scanner),
          Layer.mock(ProjectService.ProjectService)({
            getById: (id) =>
              Effect.succeedSome({
                id,
                title: "Project",
                workspaceRoot: realScan?.workspaceRoot ?? "/workspace/project",
                defaultModelSelection: null,
                scripts: [],
                createdAt: timestamp,
                updatedAt: timestamp,
                deletedAt: null,
              }),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: (threadId, fields) =>
              projections
                .getThreadRecords(threadId, fields)
                .pipe(
                  Effect.mapError(
                    (cause) => new Orchestrator.OrchestratorProjectionError({ threadId, cause }),
                  ),
                ),
          }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)(
            getAdapter === undefined ? {} : { get: getAdapter },
          ),
          Layer.succeed(
            ThreadCommandExecutor.ThreadCommandExecutor,
            threadCommands ?? (yield* ThreadCommandExecutor.make),
          ),
        ),
      ),
    ),
  );
  const importer = Context.get(context, AgentSessionImporter.AgentSessionImporter);
  return {
    run: importer.importRecentAgentThreads({ projectId }),
    runForProject: (target: ProjectId) => importer.importRecentAgentThreads({ projectId: target }),
    runForWorkspace: (expectedWorkspaceRoot: string) =>
      importer.importRecentAgentThreads({ projectId, expectedWorkspaceRoot }),
    importNativeHistory: importer.importNativeHistory,
    refreshBeforeFirstPrompt: importer.refreshBeforeFirstPrompt,
    published,
  };
});

const home = Orchestrator.HOME_PROJECT_ID;
const homeAdmissionHarness = ProviderReplayHarness.layerWithRegistry(
  { name: "home-import-admission" },
  ProviderAdapterRegistry.layerFromAdapters([{
    instanceId: CODEX_MODEL_SELECTION.instanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("Home admission does not open a provider session"),
  }]),
  { databaseLayer: SqlitePersistence.layerMemory, runEffectWorker: false },
);

it.effect("admits only one general Home across fresh import and standard creation", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const source = candidate(CODEX_MODEL_SELECTION, "home-import-race");
    const threadId = importId(source);
    const importer = yield* makeImporter([source], Effect.void, undefined, executor);
    const create = {
      type: "thread.create" as const,
      commandId: CommandId.make("home-create-race"),
      threadId: ThreadId.make("home-create-race"),
      projectId: home,
      title: "Home",
      modelSelection: CODEX_MODEL_SELECTION,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      createdBy: "user" as const,
      creationSource: "web" as const,
    };
    const [native, ordinary] = yield* Effect.all([
      importer.runForProject(home),
      orchestrator.dispatch(create).pipe(Effect.result),
    ], { concurrency: "unbounded" });
    const runtime = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    if (ordinary._tag === "Success") {
      expect(native).toEqual({ importedCount: 0, skippedCount: 1 });
      expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
      expect(yield* runtime.getByThreadId({ threadId })).toEqual(Option.none());
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
      expect(importer.published).toEqual([]);
      expect(yield* orchestrator.dispatch(create)).toEqual({ ...ordinary.success, replayed: true });
      const created = yield* projections.getThread(create.threadId);
      expect(created.historyOrigin).toBeUndefined();
      expect(created.settledAt).toBeNull();
    } else {
      expect(ordinary.failure._tag).toBe("OrchestratorHomeThreadAlreadyExistsError");
      expect(native).toEqual({ importedCount: 1, skippedCount: 0 });
      expect((yield* projections.getThread(threadId)).projectId).toBe(home);
      expect(Option.isSome(yield* runtime.getByThreadId({ threadId }))).toBe(true);
      expect(yield* orchestrator.getThreadShell(create.threadId)).toBeNull();
    }
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(
    persistence, homeAdmissionHarness, ThreadCommandExecutor.layer,
  ))),
);

it.effect("rolls back a failed fresh Home import and can still refresh the admitted history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const source = candidate(CODEX_MODEL_SELECTION, "home-import-rollback");
    const threadId = importId(source);
    const importer = yield* makeImporter([source]);
    yield* sql`CREATE TEMP TRIGGER fail_home_runtime BEFORE INSERT ON provider_session_runtime BEGIN SELECT RAISE(ABORT, 'test Home runtime failure'); END`;
    expect(yield* importer.runForProject(home)).toEqual({ importedCount: 0, skippedCount: 1 });
    expect(yield* projections.hasUndeletedListedProjectThread(home)).toBe(false);
    expect(yield* runtimes.getByThreadId({ threadId })).toEqual(Option.none());
    expect(importer.published).toEqual([]);
    yield* sql`DROP TRIGGER fail_home_runtime`;
    expect(yield* importer.runForProject(home)).toEqual({ importedCount: 1, skippedCount: 0 });

    const continued = {
      ...source,
      source: { ...source.source, size: 200, mtimeMs: 3 },
      thread: {
        ...source.thread,
        messages: [...source.thread.messages, { role: "user" as const, text: "Follow-up", createdAt: timestamp }],
      },
    };
    const refresh = yield* makeImporter([continued]);
    expect(yield* refresh.runForProject(home)).toEqual({ importedCount: 0, skippedCount: 0 });
    expect((yield* projections.getThreadRecords(threadId, ["messages"])).messages.map(({ text }) => text))
      .toEqual(["Fix it", "Fixed", "Follow-up"]);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("rejects a stale project root before scanning or writing", () =>
  Effect.gen(function* () {
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const importer = yield* makeImporter([], Effect.void, undefined, undefined, undefined, {
      workspaceRoot: "/workspace/project",
      scanner: AgentSessionScanner.AgentSessionScanner.of({
        scan: Effect.die("unexpected browse"),
        recentThreads: () => Stream.die("unexpected import scan"),
      }),
    });
    expect((yield* Effect.flip(importer.runForWorkspace("/workspace/moved")))._tag).toBe(
      "AgentSessionImportProjectChangedError",
    );
    expect(importer.published).toEqual([]);
    expect(yield* runtimes.list()).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("leaves a foreign project bot and invalid Claude transcript untouched", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const collision = candidate(CODEX_MODEL_SELECTION, "foreign-bot-collision");
    const invalid = candidate(CLAUDE_MODEL_SELECTION, "invalid-native-id", "claudeAgent");
    const ordinary = candidate(CODEX_MODEL_SELECTION, "ordinary-neighbor");
    const threadId = yield* seedOwner(candidate(CODEX_MODEL_SELECTION, "saved-bot-native"), "active", {
      id: importId(collision),
      projectId: ProjectId.make("foreign-project"),
      bot: { id: BotId.make("saved-bot"), name: "Saved bot", instructions: "Keep this identity." },
    });
    const before = yield* projections.getThreadRecords(threadId, ["messages", "providerThreads"]);
    expect(before.thread.bot?.id).toBe(BotId.make("saved-bot"));
    const importer = yield* makeImporter([collision, invalid, { _tag: "Skipped" }, ordinary]);
    expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 3 });
    expect(yield* projections.getThreadRecords(threadId, ["messages", "providerThreads"])).toEqual(
      before,
    );
    expect(yield* Effect.option(projections.getThread(importId(invalid)))).toEqual(Option.none());
    expect(yield* runtimes.getByThreadId({ threadId })).toEqual(Option.none());
    expect(yield* runtimes.getByThreadId({ threadId: importId(invalid) })).toEqual(Option.none());
    expect(
      (yield* projections.getThreadRecords(importId(ordinary), ["messages"])).messages.map(
        ({ text }) => text,
      ),
    ).toEqual(["Fix it", "Fixed"]);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("refreshes only the owned idle first-prompt source without replaying saved messages", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const source = candidate(CODEX_MODEL_SELECTION, "first-prompt");
    const threadId = importId(source);
    yield* (yield* makeImporter([source])).run;
    const fields = ["messages", "providerThreads"] as const;
    const before = yield* projections.getThreadRecords(threadId, fields);
    const suffix = { role: "assistant" as const, text: "Native update", createdAt: timestamp };
    const updated = {
      ...source,
      source: { ...source.source, size: 200, mtimeMs: 3 },
      thread: { ...source.thread, messages: [...source.thread.messages, suffix] },
    };
    const importer = yield* makeImporter([updated]);
    yield* importer.refreshBeforeFirstPrompt({ threadId: ThreadId.make("ordinary-neighbor") });
    const foreign = yield* Effect.flip(importer.refreshBeforeFirstPrompt({
      threadId,
      providerInstanceId: CLAUDE_MODEL_SELECTION.instanceId,
    }));
    expect(foreign._tag).toBe("AgentSessionFirstPromptError");
    expect(yield* projections.getThreadRecords(threadId, fields)).toEqual(before);

    const provider = before.providerThreads[0]!;
    const setProvider = (active: boolean) => sink.write({
      events: [{
        id: EventId.make(`first-prompt-provider-${active}`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: { ...provider, status: active ? "active" : "idle" },
      }],
    });
    yield* setProvider(true);
    const busy = yield* Effect.flip(importer.refreshBeforeFirstPrompt({ threadId }));
    expect(busy._tag).toBe("AgentSessionFirstPromptError");
    expect((yield* projections.getThreadRecords(threadId, fields)).messages).toEqual(before.messages);
    yield* setProvider(false);

    yield* importer.refreshBeforeFirstPrompt({ threadId });
    yield* importer.refreshBeforeFirstPrompt({ threadId });
    const after = yield* projections.getThreadRecords(threadId, fields);
    expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
    expect(after.messages.map(({ id }) => id)).toEqual(
      updated.thread.messages.map((_, index) => `${threadId}:${String(index).padStart(6, "0")}`),
    );
    expect(after.messages.slice(before.messages.length).map(({ text }) => text)).toEqual([suffix.text]);
    expect(after.providerThreads[0]?.nativeThreadRef).toEqual(provider.nativeThreadRef);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect.each(["conversation", "user-only"] as const)(
  "settles a fresh %s import at the last absolute message timestamp without starting a run",
  (kind) => Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const fixture = candidate(CODEX_MODEL_SELECTION, `j1-settle-${kind}`);
    const first = "2026-08-24T10:30:00.000+02:00";
    const last = "2026-08-24T09:00:00.000Z";
    const messages = [
      { ...fixture.thread.messages[0]!, createdAt: first },
      ...(kind === "conversation" ? [{ ...fixture.thread.messages[1]!, createdAt: last }] : []),
    ];
    const source = {
      ...fixture,
      thread: { ...fixture.thread, createdAt: first, messages },
    };
    const threadId = importId(source);
    expect((yield* (yield* makeImporter([source])).run).importedCount).toBe(1);

    const records = yield* projections.getThreadRecords(threadId, [
      "messages", "turnItems", "runs", "providerThreads", "providerTurns", "runtimeRequests",
    ]);
    const expectedSettlement = DateTime.makeUnsafe(kind === "conversation" ? last : first);
    expect(records.thread).toMatchObject({
      historyOrigin: "v1_import",
      settledOverride: "settled",
      settledAt: expectedSettlement,
      updatedAt: expectedSettlement,
      unsettledAt: null,
    });
    expect(records.messages.map(({ role, text, runId, streaming }) => ({
      role, text, runId, streaming,
    }))).toEqual(messages.map(({ role, text }) => ({
      role, text, runId: null, streaming: false,
    })));
    expect(records.turnItems.map(({ runId, status }) => ({ runId, status }))).toEqual(
      messages.map(() => ({ runId: null, status: "completed" })),
    );
    expect(records.runs).toEqual([]);
    expect(records.providerTurns).toEqual([]);
    expect(records.runtimeRequests).toEqual([]);
    expect(records.providerThreads).toMatchObject([{
      id: records.thread.activeProviderThreadId,
      status: "idle",
      providerSessionId: null,
      nativeThreadRef: { nativeId: nativeId(source), strength: "strong" },
    }]);
    expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
      status: "stopped",
      lastSeenAt: fixture.thread.updatedAt,
      providerInstanceId: source.source.providerInstanceId,
      resumeCursor: { threadId: nativeId(source) },
      runtimePayload: { importedTranscripts: [source.source] },
    });

    if (kind === "user-only") {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const result = yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle:imported-user-only"),
        threadId,
      });
      expect(result.storedEvents.map(({ event }) => event.type)).toContain("thread.settled");
      const settled = yield* projections.getThreadRecords(threadId, ["messages", "runs"]);
      expect(settled.thread.settledAt).toEqual(expectedSettlement);
      expect(settled.messages).toEqual(records.messages);
      expect(settled.runs).toEqual([]);
    }
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(
    persistence, homeAdmissionHarness, ThreadCommandExecutor.layer,
  ))),
);

it.effect("appends an intact saved transcript once without changing its native identity", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const sink = yield* EventSink.EventSinkV2;
    const source = candidate(CODEX_MODEL_SELECTION, "j1-append-only");
    const threadId = importId(source);
    expect(yield* (yield* makeImporter([source])).run).toEqual({ importedCount: 1, skippedCount: 0 });
    const fields = ["messages", "providerThreads"] as const;
    const before = yield* projections.getThreadRecords(threadId, fields);
    const runtime = Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }));
    const continued = {
      ...source,
      source: { ...source.source, size: 200, mtimeMs: 3 },
      thread: {
        ...source.thread,
        messages: [
          { ...source.thread.messages[0]!, createdAt: "2026-09-01T12:00:00.000+02:00" },
          ...source.thread.messages.slice(1),
          { role: "user" as const, text: "External follow-up", createdAt: timestamp },
          { role: "assistant" as const, text: "External answer", createdAt: timestamp },
        ],
      },
    };
    yield* sql`CREATE TEMP TRIGGER fail_append_fingerprint BEFORE UPDATE ON provider_session_runtime BEGIN SELECT RAISE(ABORT, 'test append fingerprint failure'); END`;
    expect((yield* (yield* makeImporter([continued])).run).skippedCount).toBe(1);
    expect((yield* projections.getThreadRecords(threadId, fields)).messages).toEqual(before.messages);
    expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toEqual(runtime);
    yield* sql`DROP TRIGGER fail_append_fingerprint`;
    expect((yield* (yield* makeImporter([continued])).run).skippedCount).toBe(0);
    yield* (yield* makeImporter([continued])).run;
    const after = yield* projections.getThreadRecords(threadId, fields);
    expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
    expect(after.messages.length).toBeGreaterThan(before.messages.length);
    expect(after.messages.every(({ id }) => id.startsWith(`${threadId}:`))).toBe(true);
    expect(after.messages.map(({ role, text }) => ({ role, text }))).toEqual(
      continued.thread.messages.map(({ role, text }) => ({ role, text })),
    );
    expect(after.thread.settledAt).toEqual(before.thread.settledAt);
    expect(after.thread.activeProviderThreadId).toEqual(before.thread.activeProviderThreadId);
    expect(after.providerThreads.map(({ nativeThreadRef }) => nativeThreadRef)).toEqual(
      before.providerThreads.map(({ nativeThreadRef }) => nativeThreadRef),
    );
    expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
      providerInstanceId: runtime.providerInstanceId,
      resumeCursor: runtime.resumeCursor,
      runtimePayload: { importedTranscripts: [continued.source] },
    });

    for (const [index, rewrite] of [
      { text: "Rewritten external history" },
      { createdAt: "2026-09-01T12:00:01.000+02:00" },
    ].entries()) {
      const rewritten = {
        ...continued,
        source: { ...continued.source, mtimeMs: 4 + index },
        thread: {
          ...continued.thread,
          messages: continued.thread.messages.map((message, ordinal) =>
            ordinal === 0 ? { ...message, ...rewrite } : message,
          ),
        },
      };
      expect((yield* (yield* makeImporter([rewritten])).run).skippedCount).toBe(1);
      expect(yield* projections.getThreadRecords(threadId, fields)).toEqual(after);
      expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
        runtimePayload: { importedTranscripts: [continued.source] },
      });
    }

    const followUp = {
      ...before.messages[0]!,
      id: MessageId.make("j1-local-follow-up"),
      createdBy: "user" as const,
      creationSource: "web" as const,
      text: "Continue inside J1",
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make("j1-import-follow-up"),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: followUp,
        },
      ],
    });
    const afterFollowUp = yield* projections.getThreadRecords(threadId, fields);
    expect(afterFollowUp.messages).toContainEqual(followUp);
    const afterExternalFollowUp = {
      ...continued,
      source: { ...continued.source, mtimeMs: 5 },
      thread: {
        ...continued.thread,
        messages: [
          ...continued.thread.messages,
          { role: "assistant" as const, text: "Later external answer", createdAt: timestamp },
        ],
      },
    };
    expect((yield* (yield* makeImporter([afterExternalFollowUp])).run).skippedCount).toBe(1);
    expect((yield* projections.getThreadRecords(threadId, fields)).messages).toEqual(
      afterFollowUp.messages,
    );
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect.each(["approval", "user_input"] as const)(
  "preserves source history and its fingerprint while a %s request is pending",
  (kind) => Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const sink = yield* EventSink.EventSinkV2;
    const source = candidate(CODEX_MODEL_SELECTION, `j1-pending-${kind}`);
    const threadId = importId(source);
    expect((yield* (yield* makeImporter([source])).run).importedCount).toBe(1);
    const before = yield* projections.getThreadRecords(threadId, ["messages"]);
    const binding = yield* runtimes.getByThreadId({ threadId });
    expect(before.thread.historyOrigin).toBe("v1_import");
    expect(before.thread.settledOverride).toBe("settled");

    const requestId = RuntimeRequestId.make(`request:${kind}`);
    yield* sink.write({
      events: [{
        id: EventId.make(`event:pending-${kind}`),
        type: "runtime-request.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: requestId,
          nodeId: NodeId.make(`node:${kind}`),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: kind === "approval" ? "command" : "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: now,
          resolvedAt: null,
        },
      }],
    });
    const appended = {
      ...source,
      source: { ...source.source, size: 200, mtimeMs: 3 },
      thread: {
        ...source.thread,
        messages: [...source.thread.messages,
          { role: "assistant" as const, text: "Later native answer", createdAt: timestamp }],
      },
    };
    expect((yield* (yield* makeImporter([appended])).run).skippedCount).toBe(1);
    const after = yield* projections.getThreadRecords(threadId, ["messages", "runtimeRequests"]);
    expect(after.messages).toEqual(before.messages);
    expect(after.runtimeRequests.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: requestId, status: "pending" },
    ]);
    expect(yield* runtimes.getByThreadId({ threadId })).toEqual(binding);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "ignores owned sessions, including archived and deleted threads, but imports other instances and unowned sessions",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventStore.EventStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const active = candidate(CODEX_MODEL_SELECTION, "active");
      const archived = candidate(
        CLAUDE_MODEL_SELECTION,
        "020e7f00-dce6-406b-8ec6-ed90498945d6",
        "claudeAgent",
      );
      const deleted = candidate(CODEX_MODEL_SELECTION, "deleted");
      const ownedPi = candidate(PI_MODEL_SELECTION, "owned-pi", "pi");
      const owners = [
        yield* seedOwner(active),
        yield* seedOwner(archived, "archived"),
        yield* seedOwner(deleted, "deleted"),
        yield* seedOwner(ownedPi),
      ];
      const before = yield* Effect.forEach(owners, (id) =>
        projections.getThreadRecords(id, ["providerThreads"]),
      );
      const otherInstance = candidate(
        { ...CLAUDE_MODEL_SELECTION, instanceId: ProviderInstanceId.make("claude-other") },
        archived.source.providerSessionId,
        "claudeAgent",
      );
      const unowned = candidate(CODEX_MODEL_SELECTION, "unowned");
      unowned.thread.omittedMessageCount = 1;
      unowned.worktree = { path: "/workspace/project/.claude/worktrees/feat", branch: "feat" };
      const unownedPi = candidate(PI_MODEL_SELECTION, "unowned-pi", "pi");
      const importer = yield* makeImporter(
        [active, archived, deleted, ownedPi, otherInstance, unowned, unownedPi],
        Effect.void,
        () => Effect.die("Importing a transcript must not open a provider"),
      );

      expect(yield* importer.run).toEqual({ importedCount: 3, skippedCount: 0 });
      for (const source of [active, archived, deleted, ownedPi]) {
        const threadId = importId(source);
        expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
        expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
        expect(yield* runtimes.getByThreadId({ threadId })).toEqual(Option.none());
      }
      expect(
        yield* Effect.forEach(owners, (id) =>
          projections.getThreadRecords(id, ["providerThreads"]),
        ),
      ).toEqual(before);
      expect(
        new Set(
          importer.published.flatMap((stored) =>
            "event" in stored ? [stored.event.threadId] : [],
          ),
        ),
      ).toEqual(new Set([importId(otherInstance), importId(unowned), importId(unownedPi)]));
      for (const source of [otherInstance, unowned, unownedPi]) {
        const threadId = importId(source);
        const records = yield* projections.getThreadRecords(threadId, [
          "messages",
          "turnItems",
          "providerThreads",
          "runs",
        ]);
        expect(records.runs).toEqual([]);
        expect(records.messages.map((message) => message.text)).toEqual(["Fix it", "Fixed"]);
        const notices = records.turnItems.filter((item) => item.type === "system_notice");
        if (source === unowned) {
          expect(records.turnItems[0]).toBe(notices[0]);
          expect(notices).toMatchObject([
            {
              ordinal: 1,
              runId: null,
              message: expect.stringContaining("1 earlier message was not imported"),
            },
          ]);
        } else {
          expect(notices).toEqual([]);
        }
        expect(records.thread.historyOrigin).toBe("v1_import");
        expect(records.thread.worktreePath).toBe(source.worktree?.path ?? null);
        expect(records.thread.branch).toBe(source.worktree?.branch ?? null);
        expect(records.thread.activeProviderThreadId).toBe(records.providerThreads[0]?.id);
        expect(records.providerThreads[0]?.nativeThreadRef?.nativeId).toBe(nativeId(source));
        expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
          providerInstanceId: source.source.providerInstanceId,
          resumeCursor:
            source.source.provider === "claudeAgent"
              ? { threadId, resume: source.source.providerSessionId }
              : { threadId: nativeId(source) },
          runtimePayload: {
            cwd: source.worktree?.path ?? "/workspace/project",
            importedTranscripts: [source.source],
          },
        });
      }
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("tolerates a missing transcript owner but propagates failed ownership reads", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const source = candidate(CODEX_MODEL_SELECTION, "ownership-read");
    const threadId = importId(source);
    yield* runtimes.upsert({
      threadId: ThreadId.make("missing-owner"),
      providerName: "codex",
      providerInstanceId: source.source.providerInstanceId,
      adapterKey: "codex",
      runtimeMode: "full-access",
      status: "stopped",
      lastSeenAt: timestamp,
      resumeCursor: null,
      runtimePayload: { importedTranscripts: [source.source] },
    });
    yield* runtimes.recordImportedTranscript({
      threadId: ThreadId.make("missing-owner"),
      source: source.source,
    });
    const importer = yield* makeImporter([source]);
    expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });

    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{}' WHERE thread_id = ${threadId}`;
    expect(yield* Effect.flip(importer.run)).toMatchObject({
      _tag: "AgentSessionScanError",
      operation: "read-projects",
      cause: {
        _tag: "OrchestratorProjectionError",
        threadId,
        cause: { _tag: "ProjectionStoreReadError" },
      },
    });
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("rechecks ownership after the import reaches the commit transaction", () =>
  Effect.gen(function* () {
    const enteringTransaction = yield* Deferred.make<void>();
    const continueTransaction = yield* Deferred.make<void>();
    const source = candidate(CODEX_MODEL_SELECTION, "claimed-during-import");
    const importer = yield* makeImporter(
      [source],
      Deferred.succeed(enteringTransaction, undefined).pipe(
        Effect.andThen(Deferred.await(continueTransaction)),
      ),
    );
    const pending = yield* Effect.forkScoped(importer.run);
    yield* Deferred.await(enteringTransaction);
    // Commit ownership after all pre-transaction reads, before the import acquires SQLite.
    const ownerId = yield* seedOwner(source);
    yield* Deferred.succeed(continueTransaction, undefined);
    expect(yield* Fiber.join(pending)).toEqual({ importedCount: 0, skippedCount: 0 });
    expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 0 });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    expect(yield* Effect.option(projections.getThread(importId(source)))).toEqual(Option.none());
    expect(yield* events.read({ threadId: importId(source) }).pipe(Stream.runCollect)).toEqual([]);
    expect(yield* runtimes.list()).toEqual([]);
    expect(importer.published).toEqual([]);
    expect(
      (yield* projections.getThreadRecords(ownerId, ["providerThreads"])).providerThreads[0]
        ?.appThreadId,
    ).toBe(ownerId);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "retries failed commits and runtime persistence without replaying committed history",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events = yield* EventStore.EventStoreV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const source = candidate(CODEX_MODEL_SELECTION, "retry");
      const threadId = importId(source);
      const importer = yield* makeImporter([source]);
      yield* sql`CREATE TEMP TRIGGER fail_import BEFORE INSERT ON orchestration_events WHEN NEW.event_type = 'message.updated' BEGIN SELECT RAISE(ABORT, 'test publication failure'); END`;
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
      expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
      expect(yield* runtimes.list()).toEqual([]);
      expect(importer.published).toEqual([]);
      yield* sql`DROP TRIGGER fail_import`;

      yield* sql`CREATE TEMP TRIGGER fail_runtime BEFORE INSERT ON provider_session_runtime BEGIN SELECT RAISE(ABORT, 'test runtime failure'); END`;
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      const committed = yield* events.read({ threadId }).pipe(Stream.runCollect);
      expect(committed).toHaveLength(6);
      expect(importer.published).toHaveLength(6);
      expect(yield* runtimes.list()).toEqual([]);
      yield* sql`DROP TRIGGER fail_runtime`;

      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 0 });
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 0 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual(committed);
      expect(importer.published).toHaveLength(6);
      expect(
        (yield* projections.getThreadRecords(threadId, ["messages"])).messages.map(
          (message) => message.text,
        ),
      ).toEqual(["Fix it", "Fixed"]);
      expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
        providerInstanceId: source.source.providerInstanceId,
        resumeCursor: { threadId: source.source.providerSessionId },
        runtimePayload: { importedTranscripts: [source.source] },
      });
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("counts only new threads when re-importing cached and recovered transcripts", () =>
  Effect.gen(function* () {
    const events = yield* EventStore.EventStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const cached = candidate(
      CLAUDE_MODEL_SELECTION,
      "020e7f00-dce6-406b-8ec6-ed90498945d6",
      "claudeAgent",
    );
    const recovered = candidate(CODEX_MODEL_SELECTION, "recovered");
    const initial = yield* makeImporter([cached, recovered]);
    expect(yield* initial.run).toEqual({ importedCount: 2, skippedCount: 0 });
    const before = yield* events.read({ threadId: importId(recovered) }).pipe(Stream.runCollect);
    // The file changed on disk but still holds the imported messages.
    recovered.source.size += 100;
    recovered.source.mtimeMs += 1;
    const duplicate = { ...recovered.source, filePath: "/tmp/duplicate.jsonl" };
    const fresh = candidate(CODEX_MODEL_SELECTION, "fresh");
    const repeated = yield* makeImporter([
      { _tag: "AlreadyImported", source: cached.source },
      recovered,
      { _tag: "Duplicate", source: duplicate },
      fresh,
      { _tag: "Skipped" },
    ]);

    expect(yield* repeated.run).toEqual({ importedCount: 1, skippedCount: 1 });
    expect(yield* events.read({ threadId: importId(recovered) }).pipe(Stream.runCollect)).toEqual(
      before,
    );
    expect(
      new Set(
        repeated.published.flatMap((stored) => ("event" in stored ? [stored.event.threadId] : [])),
      ),
    ).toEqual(new Set([importId(fresh)]));
    expect(
      Option.getOrThrow(yield* runtimes.getByThreadId({ threadId: importId(recovered) })),
    ).toMatchObject({
      runtimePayload: { importedTranscripts: [recovered.source, duplicate] },
    });
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("does not certify new native history after a partial import retry", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const original = candidate(CODEX_MODEL_SELECTION, "partial-retry");
    const threadId = importId(original);
    const importer = yield* makeImporter([original]);
    yield* sql`CREATE TEMP TRIGGER fail_runtime BEFORE INSERT ON provider_session_runtime BEGIN SELECT RAISE(ABORT, 'test runtime failure'); END`;
    expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
    yield* sql`DROP TRIGGER fail_runtime`;
    expect(yield* runtimes.list()).toEqual([]);
    const continued = candidate(CODEX_MODEL_SELECTION, original.source.providerSessionId);
    continued.source.size = 200;
    continued.source.mtimeMs = 3;
    continued.thread.messages.push(
      { role: "user", text: "Continue outside T3", createdAt: timestamp },
      { role: "assistant", text: "Native continuation", createdAt: timestamp },
    );
    // The thread holds only the original messages, so the continued transcript stays unrecorded.
    expect(yield* (yield* makeImporter([continued])).run).toEqual({
      importedCount: 0,
      skippedCount: 1,
    });
    expect(yield* runtimes.list()).toEqual([]);
    expect(
      (yield* projections.getThreadRecords(threadId, ["messages"])).messages.map(
        (message) => message.text,
      ),
    ).toEqual(["Fix it", "Fixed"]);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("does not record a changed transcript as imported without its new messages", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const first = candidate(
      CLAUDE_MODEL_SELECTION,
      "6f1c2a7e-3b4d-4e5f-9a8b-1c2d3e4f5a6b",
      "claudeAgent",
    );
    const threadId = importId(first);
    expect(yield* (yield* makeImporter([first])).run).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });

    const continued = candidate(
      CLAUDE_MODEL_SELECTION,
      first.source.providerSessionId,
      "claudeAgent",
    );
    continued.source.size = 200;
    continued.source.mtimeMs = 3;
    continued.thread.messages.push(
      { role: "user", text: "Continue", createdAt: timestamp },
      { role: "assistant", text: "Continued", createdAt: timestamp },
    );
    yield* (yield* makeImporter([continued])).run;

    const recorded = AgentSessionScanner.decodeImportedTranscriptPayload(
      Option.getOrThrow(yield* runtimes.getByThreadId({ threadId })).runtimePayload,
    ).pipe(Option.getOrThrow).importedTranscripts;
    const texts = (yield* projections.getThreadRecords(threadId, ["messages"])).messages.map(
      (message) => message.text,
    );
    expect({
      recordsChangedTranscript: recorded?.some((source) => source.size === 200) ?? false,
      showsNewMessages: texts.includes("Continued"),
    }).not.toEqual({ recordsChangedTranscript: true, showsNewMessages: false });
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "copies native session history into the imported thread once, retrying a failed read",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const source = candidate(CODEX_MODEL_SELECTION, "native-history");
      const threadId = yield* seedOwner(source);
      const resolved: Array<ProviderInstanceId> = [];
      const opened: Array<ProviderAdapter.ProviderAdapterV2OpenSessionInput> = [];
      let closed = false;
      let failRead = true;
      const replayed = (role: "user" | "assistant", text: string) => ({
        createdBy: role === "user" ? ("user" as const) : ("agent" as const),
        creationSource: "provider" as const,
        id: MessageId.make(`replayed:${text}`),
        threadId,
        runId: null,
        nodeId: null,
        role,
        text,
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      });
      const adapter = {
        openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              opened.push(input);
              return {
                readThreadSnapshot: ({ providerThread }) =>
                  failRead
                    ? Effect.fail(
                        new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                          driver: providerThread.driver,
                          providerThreadId: providerThread.id,
                        }),
                      )
                    : Effect.succeed({
                        providerThread,
                        providerTurns: [],
                        runtimeRequests: [],
                        reasoningMessageIds: [MessageId.make("replayed:Check the build log")],
                        messages: [
                          replayed("user", "Fix the build"),
                          replayed("assistant", "Check the build log"),
                          replayed("assistant", "Fixed it"),
                          replayed("assistant", " "),
                        ],
                      }),
              } as Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "readThreadSnapshot">;
            }),
            () =>
              Effect.sync(() => {
                closed = true;
              }),
          ),
      } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
      const importer = yield* makeImporter([], Effect.void, (instanceId) =>
        Effect.sync(() => {
          resolved.push(instanceId);
          return adapter;
        }),
      );

      const importHistory = importer.importNativeHistory({
        threadId,
        workspaceRoot: "/workspace/project",
      });

      expect((yield* Effect.flip(importHistory))._tag).toBe(
        "ProviderAdapterReadThreadSnapshotError",
      );
      expect(closed).toBe(true);
      expect(
        (yield* projections.getThreadRecords(threadId, [])).thread.historyOrigin,
      ).toBeUndefined();

      failRead = false;
      const foreignWorkspace = yield* Effect.flip(importer.importNativeHistory({
        threadId,
        workspaceRoot: "/workspace/foreign",
      }));
      expect(foreignWorkspace._tag).toBe("AgentSessionImportProjectChangedError");
      expect(opened).toHaveLength(1);
      expect(yield* importHistory).toBe(3);
      expect(resolved).toEqual([
        CODEX_MODEL_SELECTION.instanceId,
        CODEX_MODEL_SELECTION.instanceId,
      ]);
      expect(opened[1]).toMatchObject({
        threadId,
        initialNativeThreadId: source.source.providerSessionId,
        runtimePolicy: { cwd: "/workspace/project" },
      });
      // Forks keep run-less history only for this origin.
      expect((yield* projections.getThreadRecords(threadId, [])).thread.historyOrigin).toBe(
        "v1_import",
      );
      expect(yield* importHistory).toBe(0);
      expect(opened).toHaveLength(2);
      const page = yield* projections.getTimelinePage(threadId, { view: "activity", limit: 10 });
      expect(
        page.items.map(({ item }) => [
          item.type,
          item.runId,
          "text" in item ? item.text : undefined,
        ]),
      ).toEqual([
        ["user_message", null, "Fix the build"],
        ["reasoning", null, "Check the build log"],
        ["assistant_message", null, "Fixed it"],
      ]);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("releases the ACP import lock when a native session never answers", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
    const threadId = yield* seedOwner(candidate(CODEX_MODEL_SELECTION, "native-history-hang"));
    const opened = yield* Deferred.make<void>();
    let closed = false;
    // An agent that only resumes sessions and never answers its first session/resume.
    const adapter = {
      openSession: () =>
        Effect.suspend(() => {
          if (!closed) {
            return Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed = true;
              }),
            ).pipe(
              Effect.andThen(Deferred.succeed(opened, undefined)),
              Effect.andThen(Effect.never),
            );
          }
          return Effect.succeed({
            readThreadSnapshot: ({ providerThread }) =>
              Effect.succeed({
                providerThread,
                providerTurns: [],
                runtimeRequests: [],
                messages: [
                  {
                    createdBy: "user",
                    creationSource: "provider",
                    id: MessageId.make("replayed:hang"),
                    threadId,
                    runId: null,
                    nodeId: null,
                    role: "user",
                    text: "Fix the build",
                    attachments: [],
                    streaming: false,
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
              }),
          } as Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "readThreadSnapshot">);
        }),
    } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
    const importer = yield* makeImporter([], Effect.void, () => Effect.succeed(adapter));
    const importHistory = coordinator.withSessionMutation(
      importer.importNativeHistory({ threadId, workspaceRoot: "/workspace/project" }),
    );

    const importing = yield* importHistory.pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(opened);
    // Any other ACP import or delete waits for the same lock.
    const next = yield* coordinator
      .withSessionMutation(Effect.succeed("next"))
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("2 minutes");

    expect((yield* Fiber.join(importing))._tag).toBe("TimeoutError");
    expect(closed).toBe(true);
    expect(yield* Fiber.join(next)).toBe("next");
    expect(
      (yield* projections.getThreadRecords(threadId, [])).thread.historyOrigin,
    ).toBeUndefined();
    expect(yield* importHistory).toBe(1);
    expect((yield* projections.getThreadRecords(threadId, [])).thread.historyOrigin).toBe(
      "v1_import",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(persistence, AcpRegistryRuntimeCoordinator.layer)),
  ),
);

/**
 * Runs a thread command that read the thread before the history load ended and
 * writes once the importer is about to commit, as an unserialized write would.
 */
const importDuringCommand = Effect.fn(function* (
  name: string,
  command: (thread: OrchestrationV2AppThread) => ReadonlyArray<OrchestrationV2DomainEvent>,
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const threadId = yield* seedOwner(candidate(CODEX_MODEL_SELECTION, name));
  const lock = yield* ThreadCommandExecutor.make;
  const loaded = yield* Deferred.make<void>();
  const importerCommitting = yield* Deferred.make<void>();
  const commandWritten = yield* Deferred.make<void>();
  const committing = Deferred.succeed(importerCommitting, undefined);
  const adapter = {
    openSession: () =>
      Effect.succeed({
        readThreadSnapshot: ({ providerThread }) =>
          Deferred.await(loaded).pipe(
            Effect.as({
              providerThread,
              providerTurns: [],
              runtimeRequests: [],
              messages: [
                {
                  createdBy: "user" as const,
                  creationSource: "provider" as const,
                  id: MessageId.make(`replayed:${name}`),
                  threadId,
                  runId: null,
                  nodeId: null,
                  role: "user" as const,
                  text: "Fix the build",
                  attachments: [],
                  streaming: false,
                  createdAt: now,
                  updatedAt: now,
                },
              ],
            }),
          ),
      } as Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "readThreadSnapshot">),
  } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
  const importer = yield* makeImporter(
    [],
    committing.pipe(Effect.andThen(Deferred.await(commandWritten))),
    () => Effect.succeed(adapter),
    {
      ...lock,
      withLock: (key, effect) => committing.pipe(Effect.andThen(lock.withLock(key, effect))),
    },
  );
  const commanding = yield* Effect.forkScoped(
    lock.withLock(
      threadId,
      Effect.gen(function* () {
        const { thread } = yield* projections.getThreadRecords(threadId, []);
        yield* Deferred.succeed(loaded, undefined);
        yield* Deferred.await(importerCommitting);
        yield* sink.write({ events: command(thread) });
        yield* Deferred.succeed(commandWritten, undefined);
      }),
    ),
  );
  const imported = yield* importer.importNativeHistory({
    threadId,
    workspaceRoot: "/workspace/project",
  });
  yield* Fiber.join(commanding);
  const records = yield* projections.getThreadRecords(threadId, ["runs"]);
  const page = yield* projections.getTimelinePage(threadId, { view: "messages", limit: 10 });
  return { imported, thread: records.thread, runs: records.runs, items: page.items };
});

it.effect("keeps a thread edit made while the native history loads", () =>
  Effect.gen(function* () {
    const result = yield* importDuringCommand("renamed-during-load", (thread) => [
      {
        id: EventId.make(`${thread.id}:renamed`),
        type: "thread.metadata-updated",
        threadId: thread.id,
        occurredAt: now,
        payload: { ...thread, title: "Renamed" },
      },
    ]);
    expect(result.imported).toBe(1);
    expect(result.thread.title).toBe("Renamed");
    expect(result.thread.historyOrigin).toBe("v1_import");
    expect(result.items).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect.each(["provider account", "runtime mode"] as const)(
  "does not save native history after its %s changes during the read",
  (change) =>
    Effect.gen(function* () {
      const result = yield* importDuringCommand(`changed-${change.replace(" ", "-")}`, (thread) => [
        {
          id: EventId.make(`${thread.id}:changed-owner`),
          type: "thread.metadata-updated",
          threadId: thread.id,
          occurredAt: now,
          payload: change === "provider account"
            ? { ...thread, providerInstanceId: CLAUDE_MODEL_SELECTION.instanceId, modelSelection: CLAUDE_MODEL_SELECTION }
            : { ...thread, runtimeMode: "approval-required" },
        },
      ]);
      expect(result.imported).toBe(0);
      expect(result.thread.historyOrigin).toBeUndefined();
      expect(result.items).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("skips the native history when a run starts while it loads", () =>
  Effect.gen(function* () {
    const result = yield* importDuringCommand("run-during-load", (thread) => [
      {
        id: EventId.make(`${thread.id}:run`),
        type: "run.updated",
        threadId: thread.id,
        occurredAt: now,
        payload: {
          id: RunId.make(`${thread.id}:run`),
          threadId: thread.id,
          ordinal: 1,
          providerInstanceId: thread.providerInstanceId,
          modelSelection: thread.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`${thread.id}:prompt`),
          rootNodeId: null,
          activeAttemptId: null,
          status: "queued",
          requestedAt: now,
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
    ]);
    expect(result.imported).toBe(0);
    expect(result.runs).toHaveLength(1);
    expect(result.thread.historyOrigin).toBeUndefined();
    expect(result.items).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("imports under a policy ceiling in the project's default, kept under the ceiling", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const source = candidate(CODEX_MODEL_SELECTION, "ceiling");
    const threadId = importId(source);
    const importer = yield* makeImporter(
      [source],
      Effect.void,
      undefined,
      undefined,
      ServerSettings.layerTest(
        { defaultRuntimeMode: "full-access" },
        {
          organization: "Example Corp",
          lockedSettings: [],
          limits: { maxRuntimeMode: "auto-accept-edits" },
        },
      ),
    );
    expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
    expect((yield* projections.getThread(threadId)).runtimeMode).toBe("auto-accept-edits");
    expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId })).runtimeMode).toBe(
      "auto-accept-edits",
    );
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("repeated imports reach linked-worktree sessions behind the scan budget", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-import-worktree-budget-" });
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "feature");
    const worktreeGitDir = path.join(repo, ".git", "worktrees", "feature");
    yield* fs.makeDirectory(worktreeGitDir, { recursive: true });
    yield* fs.makeDirectory(worktree);
    yield* fs.writeFileString(path.join(repo, ".git", "config"), "[core]\n");
    yield* fs.writeFileString(path.join(worktreeGitDir, "commondir"), "../..\n");
    yield* fs.writeFileString(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
    yield* fs.writeFileString(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);

    const claudeHome = path.join(root, "claude");
    const codexHome = path.join(root, "codex");
    const sessions = path.join(codexHome, "sessions", "2026", "09", "01");
    yield* fs.makeDirectory(sessions, { recursive: true });
    const nowMs = DateTime.toEpochMillis(now);
    yield* TestClock.setTime(nowMs);
    // One more session than the 100-transcript scan budget, all run in the linked worktree.
    for (let index = 0; index < 101; index++) {
      const file = path.join(sessions, `rollout-${String(index).padStart(3, "0")}.jsonl`);
      const records = [
        { type: "session_meta", payload: { id: `session-${index}`, cwd: worktree } },
        { type: "event_msg", payload: { type: "user_message", message: `Request ${index}` } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Done" }],
          },
        },
      ];
      yield* fs.writeFileString(
        file,
        records.map((record) => JSON.stringify(record) + "\n").join(""),
      );
      const modifiedAtSeconds = nowMs / 1000 - (index + 1);
      yield* fs.utimes(file, modifiedAtSeconds, modifiedAtSeconds);
    }

    const scannerContext = yield* Layer.build(
      AgentSessionScanner.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerConfig.layerTest(claudeHome, { prefix: "t3-import-budget-config-" }),
            ServerSettings.layerTest({
              providerInstances: {
                [ProviderInstanceId.make("claudeAgent")]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  config: { homePath: claudeHome },
                },
                [ProviderInstanceId.make("codex")]: {
                  driver: ProviderDriverKind.make("codex"),
                  config: { homePath: codexHome },
                },
                // Keeps the default Pi instance off the developer's real ~/.pi.
                [ProviderInstanceId.make("pi")]: {
                  driver: ProviderDriverKind.make("pi"),
                  enabled: false,
                  config: {},
                },
              },
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
            Layer.succeed(
              ProviderSessionRuntime.ProviderSessionRuntimeRepository,
              yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository,
            ),
          ),
        ),
      ),
    );
    const importer = yield* makeImporter([], Effect.void, undefined, undefined, undefined, {
      workspaceRoot: repo,
      scanner: Context.get(scannerContext, AgentSessionScanner.AgentSessionScanner),
    });

    expect(yield* importer.run).toEqual({ importedCount: 100, skippedCount: 1 });
    expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
    const oldest = yield* ProjectionStore.ProjectionStoreV2.pipe(
      Effect.flatMap((projections) =>
        projections.getThread(ThreadId.make("import:codex:session-100")),
      ),
    );
    expect(oldest.worktreePath).toBe(worktree);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("refreshes the transcript order after reopening and rejects rewritten rows", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "j1-import-refresh-" });
    const database = () => {
      const storage = SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite"));
      const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(Layer.provideMerge(storage));
      return Layer.mergeAll(stores, EventSink.layer.pipe(Layer.provide(stores)),
        ProviderSessionRuntime.layer.pipe(Layer.provide(storage)), IdAllocator.layer);
    };
    const initial = candidate(CODEX_MODEL_SELECTION, "restart-history-order");
    const source = { ...initial, thread: { ...initial.thread, messages: [
      { ...initial.thread.messages[0]!, createdAt: "2026-01-02T00:00:00.000Z" },
      { ...initial.thread.messages[1]!, createdAt: "2026-01-01T00:00:00.000Z" },
    ] } };
    const threadId = importId(source);
    const before = yield* Effect.gen(function* () {
      expect(yield* (yield* makeImporter([source])).run).toEqual({ importedCount: 1, skippedCount: 0 });
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      return yield* projection.getThreadRecords(threadId, ["messages", "turnItems"]);
    }).pipe(Effect.provide(database()));

    yield* Effect.gen(function* () {
      const updated = { ...source, source: { ...source.source, size: 200, mtimeMs: 3 },
        thread: { ...source.thread, messages: [...source.thread.messages,
          { role: "assistant" as const, text: "External progress", createdAt: "2026-01-03T00:00:00.000Z" },
        ] } };
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const read = () => projection.getThreadRecords(threadId, ["messages", "turnItems"]);
      expect((yield* read()).messages).toEqual(before.messages);
      expect(before.messages.map(({ text, createdAt }) => ({
        text,
        createdAt: DateTime.formatIso(createdAt),
      }))).toEqual(source.thread.messages.map(({ text, createdAt }) => ({ text, createdAt })));
      expect(before.turnItems.map(({ ordinal }) => ordinal)).toEqual([1, 2]);
      const importer = yield* makeImporter([updated]);
      yield* importer.refreshBeforeFirstPrompt({ threadId });
      const after = yield* read();
      expect(after.messages.slice(0, 2)).toEqual(before.messages);
      expect(after.messages.slice(2).map(({ text }) => text)).toEqual(["External progress"]);
      expect(after.turnItems).toHaveLength(before.turnItems.length + 1);
      expect(after.thread.settledAt).toEqual(before.thread.settledAt);
      yield* importer.refreshBeforeFirstPrompt({ threadId });
      expect(yield* read()).toEqual(after);
      const rewritten = { ...updated, source: { ...updated.source, mtimeMs: 4 },
        thread: { ...updated.thread, messages: updated.thread.messages.map((message, index) =>
          index === 0 ? { ...message, text: "Rewritten" } : message) } };
      const changed = yield* makeImporter([rewritten]);
      yield* Effect.flip(changed.refreshBeforeFirstPrompt({ threadId }));
      expect(yield* read()).toEqual(after);
    }).pipe(Effect.provide(database()));
  }).pipe(Effect.provide(NodeServices.layer)),
);
