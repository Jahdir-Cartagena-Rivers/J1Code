import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  BotId, CommandId, EventId, MessageId, OrchestrationV2RpcSchemas, ProjectId, ProviderInstanceId, ThreadId,
  type BotProfile, type OrchestrationV2InternalCommand,
} from "@j1code/contracts";
import * as IdAllocator from "@j1code/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import * as CommandPolicy from "./CommandPolicy.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import {
  MausbotHistoryImport, mausbotHistoryCommandId, matchesMausbotHistoryReceipt,
  type MausbotHistoryImportCommand,
} from "./MausbotHistoryImport.ts";
import { MausbotProjectOverride, type MausbotProjectOverrideProof } from "./MausbotProjectOverride.ts";
import { MausbotNativeProofError } from "./MausbotNativeProofError.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { ProviderSwitchServiceV2 } from "./ProviderSwitchService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ThreadForkService from "./ThreadForkService.ts";

const decodePublicDispatch = Schema.decodeUnknownSync(OrchestrationV2RpcSchemas.dispatchCommand.input);

const projectId = ProjectId.make("project:bot");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5" };
const botId = BotId.make("bot:valid");
const archivedId = BotId.make("bot:archived");
const mismatchId = BotId.make("bot:mismatch");
const now = "2026-01-01T00:00:00Z";
const bot: BotProfile = {
  id: botId, name: "Saved bot", projectId, instructions: "Saved instructions", description: "",
  modelSelection, archived: false, pinned: false, createdAt: now, updatedAt: now,
};

const nativeBot = { ...bot, id: BotId.make("mausbot:native") };
const destinationId = ProjectId.make("project:task");
const disabledId = ProjectId.make("project:disabled");
const archivedProjectId = ProjectId.make("project:archived");
const rootFor = (id: ProjectId) => "/private-fixtures/" + id;

// Provide settings to the layer constructor, where Orchestrator captures the service.
const settings = Layer.effect(
  ServerSettings.ServerSettingsService,
  Effect.gen(function* () {
    const service = yield* ServerSettings.ServerSettingsService;
    return {
      ...service,
      // The normal settings validator rejects a key mismatch. Introduce it
      // at the read boundary to exercise Orchestrator's second check.
      getSettings: service.getSettings.pipe(
        Effect.map((current) => ({ ...current, bots: { ...current.bots, [mismatchId]: bot } })),
      ),
    };
  }),
).pipe(Layer.provide(ServerSettings.layerTest({
  bots: { [botId]: bot, [archivedId]: { ...bot, id: archivedId, archived: true }, [nativeBot.id]: nativeBot },
  projectSettingsOverrides: { [disabledId]: { providerInstances: { [instanceId]: { enabled: false } } } },
})));

const stores = Layer.mergeAll(
  ProjectionStore.layer, ProjectStore.layer, EventStore.layer, CommandReceiptStore.layer,
  EffectOutbox.layer,
);
const layerTest = Orchestrator.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(
    settings, IdAllocator.layer, CommandPolicy.layer, RuntimePolicy.layer, ThreadForkService.layer,
    Layer.mock(CheckpointServiceV2)({}), Layer.mock(ProviderAdapterRegistryV2)({}),
    Layer.mock(ProviderSessionManagerV2)({}), Layer.mock(ProviderSwitchServiceV2)({}),
    ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer)),
  )),
  Layer.provideMerge(EventSink.layer),
  Layer.provideMerge(stores),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(NodeServices.layer),
);

const create = (suffix: string, id = botId): Extract<
  OrchestrationV2InternalCommand, { type: "thread.bot.create" }
> => ({
  type: "thread.bot.create",
  commandId: CommandId.make(`command:${suffix}`),
  threadId: ThreadId.make(`thread:${suffix}`),
  projectId,
  botId: id,
  modelSelection,
  title: "Bot",
  createdBy: "user",
  creationSource: "web",
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
});

it.layer(layerTest)("durable bot identity admission", (it) => {
  it.effect("snapshots an authorized saved profile while public creation cannot bind it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const internal = create("internal");
      yield* orchestrator.dispatch(internal);
      assert.deepEqual((yield* projection.getThread(internal.threadId)).bot, {
        id: bot.id, name: bot.name, instructions: bot.instructions,
      });

      const decode = decodePublicDispatch;
      assert.throws(() => decode(internal));
      const forged = create("forged");
      yield* orchestrator.dispatch(decode({
        ...forged, type: "thread.create",
        bot: { id: botId, name: "Forged", instructions: "Forged instructions" },
      }));
      assert.notProperty(yield* projection.getThread(forged.threadId), "bot");
    }),
  );

  it.effect("rejects invalid profile ownership before writing a thread or provider work", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      for (const command of [
        create("missing", BotId.make("missing")),
        create("archived", archivedId),
        create("key-mismatch", mismatchId),
        { ...create("project-mismatch"), projectId: ProjectId.make("different-project") },
      ]) {
        const error = yield* orchestrator.dispatch(command).pipe(Effect.flip);
        assert.equal(error._tag, "OrchestratorDispatchError");
        assert.isNull(yield* projection.getThreadShell(command.threadId));
        assert.deepEqual(yield* outbox.listByCommandId(command.commandId), []);
        const receipt = yield* receipts.getByCommandId(command.commandId);
        assert.isTrue(Option.isSome(receipt) && receipt.value.status === "rejected");
      }
    }),
  );

  it.effect("rechecks the private native task destination without changing the saved default", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const settings = yield* ServerSettings.ServerSettingsService;
      for (const [index, id] of [projectId, destinationId, disabledId, archivedProjectId].entries()) {
        const event = {
          aggregateKind: "project", aggregateId: id, occurredAt: now,
          commandId: null, causationEventId: null, correlationId: null, metadata: {},
        } as const;
        yield* projects.apply({
          ...event, sequence: index + 1, eventId: EventId.make("event:create:" + id),
          type: "project.created",
          payload: {
            projectId: id, title: id, workspaceRoot: rootFor(id), defaultModelSelection: null,
            scripts: [], createdAt: now, updatedAt: now,
          },
        });
        if (id === archivedProjectId) {
          yield* projects.apply({
            ...event, sequence: index + 2, eventId: EventId.make("event:archive:" + id),
            type: "project.meta-updated", payload: { projectId: id, archivedAt: now, updatedAt: now },
          });
        }
      }

      const commandFor = (suffix: string, destination = destinationId) => ({
        ...create(suffix, nativeBot.id),
        threadId: ThreadId.make("j1-mausbot:native:" + suffix),
        projectId: destination,
        creationSource: "server" as const,
      });
      const snapshotFor = (suffix: string, destination = destinationId) => ({
        botId: "native", threadId: suffix, projectId, threadProjectId: destination,
        modelSelection, threadSelection: modelSelection, approvalMode: "ask" as const,
        name: bot.name, description: bot.description, instructions: bot.instructions, restrictedTools: true,
      });
      const proofFor = (
        command: ReturnType<typeof commandFor>,
        suffix: string,
      ): MausbotProjectOverrideProof => ({
        command, nativeBotId: "native", nativeThreadId: suffix, defaultProjectId: projectId,
        workspaceRoot: rootFor(command.projectId), restrictedTools: true,
        current: () => true,
        read: Effect.succeed(snapshotFor(suffix, command.projectId)),
      });
      const copied = commandFor("copied");
      const stale = commandFor("stale");
      const failedRead = commandFor("failed-read");
      const foreign = commandFor("foreign");
      const moved = commandFor("moved");
      const changedDefault = commandFor("changed-default", projectId);
      const disabled = commandFor("disabled", disabledId);
      const archived = commandFor("archived-destination", archivedProjectId);
      const forged = commandFor("forged-authority");
      const denied: ReadonlyArray<readonly [
        ReturnType<typeof commandFor>,
        MausbotProjectOverrideProof | undefined,
      ]> = [
        [{ ...forged, projectOverride: true } as typeof forged, undefined],
        [{ ...copied }, proofFor(copied, "copied")],
        [stale, {
          ...proofFor(stale, "stale"),
          current: (() => { let reads = 0; return () => ++reads === 1; })(),
        }],
        [failedRead, {
          ...proofFor(failedRead, "failed-read"),
          read: Effect.fail(new MausbotNativeProofError({
            message: "Saved proof read failed", cause: new Error("fixture read failure"),
          })),
        }],
        [foreign, {
          ...proofFor(foreign, "foreign"),
          read: Effect.succeed({ ...snapshotFor("foreign"), botId: "another-bot" }),
        }],
        [moved, {
          ...proofFor(moved, "moved"),
          read: Effect.succeed(snapshotFor("moved", disabledId)),
        }],
        [changedDefault, {
          ...proofFor(changedDefault, "changed-default"),
          defaultProjectId: disabledId,
          read: Effect.succeed({ ...snapshotFor("changed-default", projectId), projectId: disabledId }),
        }],
        [disabled, proofFor(disabled, "disabled")],
        [archived, proofFor(archived, "archived-destination")],
      ];
      for (const [command, proof] of denied) {
        const error = yield* orchestrator.dispatch(command).pipe(
          Effect.provideService(MausbotProjectOverride, proof),
          Effect.flip,
        );
        assert.equal(error._tag, "OrchestratorDispatchError");
        assert.isNull(yield* projection.getThreadShell(command.threadId));
      }

      const allowed = commandFor("saved");
      yield* orchestrator.dispatch(allowed).pipe(
        Effect.provideService(MausbotProjectOverride, proofFor(allowed, "saved")),
      );
      assert.equal((yield* projection.getThreadShell(allowed.threadId))?.projectId, destinationId);
      assert.equal((yield* projection.getThreadShell(allowed.threadId))?.bot?.id, nativeBot.id);
      const neighbor = commandFor("neighbor", projectId);
      yield* orchestrator.dispatch(neighbor);
      assert.equal((yield* projection.getThreadShell(neighbor.threadId))?.projectId, projectId);
      assert.deepEqual((yield* settings.getSettings).bots[nativeBot.id], nativeBot);
    }),
  );

  it.effect("atomically imports cold bot history with an exact private retry", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const createNative = (name: string) => ({
        ...create(name, nativeBot.id),
        threadId: ThreadId.make("j1-mausbot:native:" + name),
        creationSource: "server" as const,
      });
      const cold = createNative("cold");
      const neighbor = createNative("neighbor-history");
      yield* orchestrator.dispatch(cold);
      yield* orchestrator.dispatch(neighbor);
      const history = (threadId: ThreadId): MausbotHistoryImportCommand => ({
        type: "thread.bot.history.import", commandId: mausbotHistoryCommandId(threadId),
        threadId, botId: nativeBot.id,
        messages: [
          { nativeMessageId: "question1", createdAt: "2026-01-01T00:00:01.000Z",
            completedAt: null, role: "user", text: "First question", attachments: [] },
          { nativeMessageId: "answer1", createdAt: "2026-01-01T00:00:02.000Z",
            completedAt: "2026-01-01T00:00:03.000Z", role: "assistant", text: "First answer", attachments: [{
            type: "file", id: "fixture-00000000-0000-0000-0000-000000000000",
            name: "historical.txt", mimeType: "text/plain", sizeBytes: 10,
          }] },
          { nativeMessageId: "question2", createdAt: "2026-01-01T00:00:04.000Z",
            completedAt: null, role: "user", text: "Second question", attachments: [] },
        ],
      });
      const privately = (command: MausbotHistoryImportCommand, name: string, savedName = name) =>
        orchestrator.dispatch(command).pipe(Effect.provideService(MausbotHistoryImport, {
          command, botId: "native", threadId: name, turnId: "saved-turn",
          anchorMessageId: "anchor", promptText: "New question",
          promptAttachments: [], current: () => true,
          read: Effect.succeed({
            botId: "native", threadId: savedName, projectId, threadProjectId: projectId,
            modelSelection, threadSelection: modelSelection, approvalMode: "ask" as const,
            name: bot.name, description: bot.description, instructions: bot.instructions,
            restrictedTools: true,
            coldHistory: {
              turnId: "saved-turn", anchorMessageId: "anchor",
              promptText: "New question", promptAttachments: [], messages: command.messages,
            },
          }),
        }));

      const original = history(cold.threadId);
      const decode = decodePublicDispatch;
      assert.throws(() => decode(original));
      yield* orchestrator.dispatch(original).pipe(Effect.flip);
      yield* privately(original, "cold", "foreign").pipe(Effect.flip);
      assert.isTrue(Option.isNone(yield* receipts.getByCommandId(original.commandId)));
      const imported = yield* privately(original, "cold");
      const retry = yield* privately({ ...original }, "cold");
      assert.equal(retry.sequence, imported.sequence);
      assert.isTrue(retry.replayed);
      assert.deepEqual(retry.storedEvents, imported.storedEvents);
      assert.isFalse(matchesMausbotHistoryReceipt(original, imported.storedEvents.map(row =>
        row.event.type === "turn-item.updated"
          ? { ...row, event: { ...row.event, payload: { ...row.event.payload, threadId: neighbor.threadId } } }
          : row,
      )));
      const [first, ...rest] = original.messages;
      for (const changed of [
        { ...first, text: "Different" },
        { ...first, nativeMessageId: "replaced" },
        { ...first, createdAt: "2026-01-01T00:00:05.000Z" },
        { ...first, completedAt: first.createdAt },
      ]) {
        yield* privately({ ...original, messages: [changed, ...rest] }, "cold").pipe(Effect.flip);
      }
      const stored = yield* projection.getThreadRecords(cold.threadId, [
        "messages", "turnItems", "runs", "providerThreads",
      ]);
      assert.deepEqual(stored.messages.map(row => ({
        nativeMessageId: row.id.split(":").at(-1), createdAt: DateTime.formatIso(row.createdAt),
        role: row.role, text: row.text, attachments: row.attachments,
      })), original.messages.map(({ completedAt: _, ...row }) => row));
      assert.deepEqual(stored.turnItems.map(row => row.ordinal), [1, 2, 3]);
      assert.deepEqual(stored.turnItems[1]?.type === "assistant_message"
        ? stored.turnItems[1].attachments : undefined, original.messages[1]?.attachments);
      assert.deepEqual(stored.runs, []);
      assert.deepEqual(stored.providerThreads, []);
      assert.deepEqual(yield* outbox.listByCommandId(original.commandId), []);

      const at = DateTime.makeUnsafe(now);
      const independent = MessageId.make("independent-history");
      yield* projection.apply({
        id: EventId.make("independent-history-event"),
        type: "message.updated", threadId: neighbor.threadId, occurredAt: at,
        payload: {
          id: independent, threadId: neighbor.threadId, runId: null, nodeId: null,
          role: "user", text: "Independent history", attachments: [], streaming: false,
          createdBy: "user", creationSource: "web", createdAt: at, updatedAt: at,
        },
      });
      yield* privately(history(neighbor.threadId), "neighbor-history").pipe(Effect.flip);
      const remaining = yield* projection.getThreadRecords(neighbor.threadId, ["messages"]);
      assert.deepEqual(remaining.messages.map(row => row.id), [independent]);
    }),
  );

  it.effect("checks the signed caller ceiling for bot creation", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const command = { ...create("limited"), runtimeMode: "full-access" as const };
      const refusal = yield* orchestrator.dispatch(command).pipe(
        Effect.provideService(DispatchModeLimit, {
          runtimeMode: "approval-required", interactionMode: "default",
        }),
        Effect.flip,
      );
      assert.equal(refusal._tag, "OrchestratorThreadAboveModeLimitError");
      assert.isNull(yield* projection.getThreadShell(command.threadId));
      yield* orchestrator.dispatch({ ...create("unrestricted"), runtimeMode: "full-access" });
      assert.isNotNull(yield* projection.getThreadShell(ThreadId.make("thread:unrestricted")));
    }),
  );

  it.effect("records source route notices idempotently without creating a run or provider work", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const source = create("route-notice");
      yield* orchestrator.dispatch(source);
      const notice = {
        id: "routing-notice:request:2", requestId: "request", revision: 2,
        source: { environmentId: "environment", projectId, threadId: source.threadId },
        destination: null, status: "queued" as const, summary: "Forwarded request", occurredAt: now,
      };
      const command = {
        type: "thread.route-status.record" as const,
        commandId: CommandId.make(notice.id), threadId: source.threadId, notice,
      };
      assert.throws(() => decodePublicDispatch(command));
      const initial = yield* orchestrator.dispatch(command);
      assert.lengthOf(initial.storedEvents, 1);
      assert.isTrue((yield* orchestrator.dispatch(command)).replayed);
      const older = { ...notice, id: "routing-notice:request:1", revision: 1 };
      const staleCommand = { ...command, commandId: CommandId.make(older.id), notice: older };
      const equalCommand = {
        ...command, commandId: CommandId.make("notice:equal"),
        notice: { ...notice, summary: "Conflicting same revision" },
      };
      for (const noOp of [staleCommand, equalCommand]) {
        const accepted = yield* orchestrator.dispatch(noOp);
        assert.equal(accepted.sequence, initial.sequence);
        assert.deepEqual(accepted.storedEvents, []);
        const receipt = Option.getOrThrow(yield* receipts.getByCommandId(noOp.commandId));
        assert.include(receipt, {
          commandType: "thread.route-status.record", threadId: source.threadId,
          status: "accepted", resultSequence: initial.sequence,
        });
        assert.deepEqual(yield* outbox.listByCommandId(noOp.commandId), []);
      }
      assert.deepEqual((yield* projection.getThread(source.threadId)).routeNotices, [notice]);
      const shell = yield* projection.getThreadShell(source.threadId);
      assert.isNotNull(shell);
      assert.isUndefined(shell?.routeNotices);
      const newer = { ...notice, id: "routing-notice:request:3", revision: 3, status: "delivered" as const };
      const newerCommand = { ...command, commandId: CommandId.make(newer.id), notice: newer };
      const advanced = yield* orchestrator.dispatch(newerCommand);
      assert.lengthOf(advanced.storedEvents, 1);
      assert.isAbove(advanced.sequence, initial.sequence);
      for (const noOp of [staleCommand, equalCommand]) {
        const replay = yield* orchestrator.dispatch(noOp);
        assert.isTrue(replay.replayed);
        assert.equal(replay.sequence, initial.sequence);
        assert.deepEqual(replay.storedEvents, []);
      }
      assert.deepEqual(yield* outbox.listByCommandId(newerCommand.commandId), []);
      assert.deepEqual((yield* projection.getThread(source.threadId)).routeNotices, [newer]);
      const rejected = yield* orchestrator.dispatch({
        ...command, commandId: CommandId.make("notice:foreign"),
        notice: { ...newer, source: { ...notice.source, projectId: ProjectId.make("foreign") } },
      }).pipe(Effect.result);
      assert.equal(rejected._tag, "Failure");
      const missingThreadId = ThreadId.make("thread:no-route-source");
      const missingCommandId = CommandId.make("notice:missing");
      const missing = yield* orchestrator.dispatch({
        ...command, commandId: missingCommandId, threadId: missingThreadId,
        notice: { ...older, source: { ...older.source, threadId: missingThreadId } },
      }).pipe(Effect.result);
      assert.equal(missing._tag, "Failure");
      assert.isNull(yield* projection.getThreadShell(missingThreadId));
      assert.deepEqual(yield* outbox.listByCommandId(missingCommandId), []);
      assert.deepEqual(yield* outbox.listByCommandId(command.commandId), []);
      const records = yield* orchestrator.getThreadRecords(source.threadId, ["messages", "runs"]);
      assert.deepEqual(records.messages, []);
      assert.deepEqual(records.runs, []);
    }),
  );
});
