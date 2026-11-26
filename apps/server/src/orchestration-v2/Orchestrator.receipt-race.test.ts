import { vi } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@j1code/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@j1code/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
// Holds model-selection planning until both racing commands have read no receipt.
let capabilityGate: Effect.Effect<void> | undefined;
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () =>
    (capabilityGate ?? Effect.void).pipe(Effect.as(CodexProviderCapabilitiesV2)),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "receipt-race" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect("a command id reused concurrently for two threads succeeds for only one", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadIds = [ThreadId.make("thread:race-a"), ThreadId.make("thread:race-b")];
    for (const threadId of threadIds) {
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("project:receipt-race"),
        title: threadId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    }

    const arrived = yield* Ref.make(0);
    const bothArrived = yield* Deferred.make<void>();
    capabilityGate = Effect.gen(function* () {
      if ((yield* Ref.updateAndGet(arrived, (count) => count + 1)) === 2) {
        yield* Deferred.succeed(bothArrived, undefined);
      }
      yield* Deferred.await(bothArrived);
    });
    const setModel = (threadId: ThreadId) =>
      orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("command:shared"),
        threadId,
        modelSelection: { ...modelSelection, model: "gpt-6" },
      });
    const exits = yield* Effect.forEach(threadIds, (threadId) => Effect.exit(setModel(threadId)), {
      concurrency: "unbounded",
    }).pipe(Effect.ensuring(Effect.sync(() => (capabilityGate = undefined))));

    const winner = exits.findIndex(Exit.isSuccess);
    const loser = exits.findIndex(Exit.isFailure);
    assert.isAtLeast(winner, 0);
    assert.isAtLeast(loser, 0);
    const winnerExit = exits[winner]!;
    const loserExit = exits[loser]!;
    assert.isTrue(Exit.isSuccess(winnerExit) && Exit.isFailure(loserExit));
    if (Exit.isFailure(loserExit)) {
      const error = Cause.findErrorOption(loserExit.cause);
      assert.isTrue(error._tag === "Some");
      if (error._tag === "Some") {
        assert.equal(error.value._tag, "OrchestratorCommandIdConflictError");
        if (error.value._tag === "OrchestratorCommandIdConflictError") {
          assert.equal(error.value.receiptThreadId, threadIds[winner]);
          assert.equal(error.value.commandThreadId, threadIds[loser]);
        }
      }
    }

    const models = yield* Effect.forEach(threadIds, (threadId) =>
      projections.getThreadShell(threadId).pipe(Effect.map((shell) => shell?.modelSelection.model)),
    );
    assert.equal(models[winner], "gpt-6");
    assert.equal(models[loser], "gpt-5.1-codex");

    const noOpArrived = yield* Ref.make(0);
    const bothNoOpsArrived = yield* Deferred.make<void>();
    const getThreadRecords = projections.getThreadRecords;
    using _records = vi.spyOn(projections, "getThreadRecords").mockImplementation((...args) =>
      Effect.gen(function* () {
        if ((yield* Ref.updateAndGet(noOpArrived, (count) => count + 1)) === 2) {
          yield* Deferred.succeed(bothNoOpsArrived, undefined);
        }
        yield* Deferred.await(bothNoOpsArrived);
        return yield* getThreadRecords(...args);
      }),
    );
    const closeShare = (threadId: ThreadId) =>
      orchestrator.dispatch({
        type: "thread.guest-share.close",
        commandId: CommandId.make("command:shared-noop"),
        threadId,
      });
    const noOpExits = yield* Effect.forEach(
      threadIds,
      (threadId) => Effect.exit(closeShare(threadId)),
      {
        concurrency: "unbounded",
      },
    );
    const noOpWinner = noOpExits.findIndex(Exit.isSuccess);
    const noOpLoser = noOpExits.findIndex(Exit.isFailure);
    assert.isAtLeast(noOpWinner, 0);
    assert.isAtLeast(noOpLoser, 0);
    const noOpFailure = noOpExits[noOpLoser]!;
    if (Exit.isFailure(noOpFailure)) {
      const error = Cause.findErrorOption(noOpFailure.cause);
      assert.isTrue(error._tag === "Some");
      if (error._tag === "Some") {
        assert.equal(error.value._tag, "OrchestratorCommandIdConflictError");
      }
    }
    const noOpReplay = yield* closeShare(threadIds[noOpWinner]!);
    const noOpSuccess = noOpExits[noOpWinner]!;
    if (Exit.isSuccess(noOpSuccess)) {
      assert.equal(noOpReplay.sequence, noOpSuccess.value.sequence);
      assert.deepEqual(noOpReplay.storedEvents, []);
    }

    // The winner's own thread still replays its receipt.
    const replay = yield* setModel(threadIds[winner]!);
    if (Exit.isSuccess(winnerExit)) {
      assert.equal(replay.sequence, winnerExit.value.sequence);
      assert.isAbove(replay.storedEvents.length, 0);
      assert.deepEqual(
        replay.storedEvents.map((stored) => stored.sequence),
        winnerExit.value.storedEvents.map((stored) => stored.sequence),
      );
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps rejected receipts scoped and prevents replay as a different command", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:receipt-owner");
    const missingThread = ThreadId.make("thread:receipt-missing");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create:receipt-owner"),
      threadId,
      projectId: ProjectId.make("project:receipt-race"),
      title: "Receipt owner",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });

    const started = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    capabilityGate = Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Deferred.await(resume)),
    );
    yield* Effect.gen(function* () {
      const commandId = CommandId.make("rejected:race");
      const losing = {
        type: "thread.model-selection.set" as const,
        commandId,
        threadId,
        modelSelection: { ...modelSelection, model: "gpt-6" },
      };
      const rejecting = { type: "thread.archive" as const, commandId, threadId: missingThread };
      const pending = yield* Effect.forkScoped(orchestrator.dispatch(losing).pipe(Effect.flip));
      yield* Deferred.await(started);
      yield* orchestrator.dispatch(rejecting).pipe(Effect.flip);
      yield* Deferred.succeed(resume, undefined);

      assert.equal((yield* Fiber.join(pending))._tag, "OrchestratorCommandIdConflictError");
      assert.equal(
        (yield* orchestrator.dispatch(losing).pipe(Effect.flip))._tag,
        "OrchestratorCommandIdConflictError",
      );
      const wrongThread = yield* orchestrator.dispatch({ ...rejecting, threadId }).pipe(Effect.flip);
      assert.equal(wrongThread._tag, "OrchestratorCommandIdConflictError");
      assert.equal(
        (yield* orchestrator.dispatch(rejecting).pipe(Effect.flip))._tag,
        "OrchestratorCommandPreviouslyRejectedError",
      );
      assert.equal(
        (yield* orchestrator.getThreadShell(threadId))?.modelSelection.model,
        modelSelection.model,
      );
    }).pipe(Effect.ensuring(Effect.sync(() => (capabilityGate = undefined))));

    const archive = {
      type: "thread.archive" as const,
      commandId: CommandId.make("accepted:archive"),
      threadId,
    };
    const accepted = yield* orchestrator.dispatch(archive);
    const wrongType = yield* orchestrator.dispatch({ ...archive, type: "thread.unarchive" }).pipe(Effect.flip);
    assert.equal(wrongType._tag, "OrchestratorCommandIdConflictError");
    if (wrongType._tag === "OrchestratorCommandIdConflictError") {
      assert.equal(wrongType.receiptCommandType, "thread.archive");
    }
    assert.isNotNull((yield* orchestrator.getThreadShell(threadId))?.archivedAt);
    const replay = yield* orchestrator.dispatch(archive);
    assert.isTrue(replay.replayed);
    assert.equal(replay.sequence, accepted.sequence);
    assert.deepEqual(replay.storedEvents, accepted.storedEvents);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
