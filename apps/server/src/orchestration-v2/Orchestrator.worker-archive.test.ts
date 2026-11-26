import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@j1code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../persistence/Sqlite.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { LegacyV1ThreadImporter, layer as legacyLayer } from "./legacy/LegacyV1ThreadImporter.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionMaintenanceV2, layer as maintenanceLayer } from "./ProjectionMaintenance.ts";
import { layerFromAdapters } from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const parent = ThreadId.make("saved-parent");
const worker = ThreadId.make("saved-child");
const grandchild = ThreadId.make("saved-grandchild");
const earlier = ThreadId.make("saved-previously-archived");
const unrelated = ThreadId.make("saved-unrelated");
const missing = ThreadId.make("saved-missing");
const savedThreads = [parent, worker, grandchild, earlier, unrelated];
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const lifecycle = (type: "thread.archive" | "thread.unarchive", threadId: ThreadId, id: string) => ({
  type,
  commandId: CommandId.make(id),
  threadId,
});

it.effect("archives saved workers as one replayable command and restores its cohort after reopening SQLite", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "j1-worker-archive-" });
    const database = Sqlite.layerFromPath(path.join(dir, "state.sqlite")).pipe(
      Layer.provide(NodeServices.layer),
    );
    const harness = ProviderReplayHarness.layerWithRegistry(
      { name: "saved-worker-archive" },
      layerFromAdapters([]),
      { databaseLayer: database, runEffectWorker: false },
    );
    const testLayer = Layer.mergeAll(
      database,
      harness,
      legacyLayer.pipe(Layer.provide(Layer.mergeAll(database, harness))),
      maintenanceLayer.pipe(Layer.provide(database)),
    );
    const archive = lifecycle("thread.archive", parent, "archive-saved-tree");

    const accepted = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter;
      const orchestrator = yield* OrchestratorV2;
      const sink = yield* EventSinkV2;
      const maintenance = yield* ProjectionMaintenanceV2;
      const at = "2026-01-01T00:00:00.000Z";
      yield* sql`INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at
      ) VALUES ('saved-workers', 'Saved workers', ${dir}, '[]', ${at}, ${at})`;
      for (const threadId of savedThreads) {
        yield* sql`INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES (
          ${threadId}, 'saved-workers', ${threadId}, ${JSON.stringify(modelSelection)},
          'full-access', 'default', ${at}, ${at}
        )`;
      }
      for (const [child, owner] of [[worker, parent], [grandchild, worker], [earlier, parent]] as const) {
        const payload = JSON.stringify({ threadId: child, activity: {
          id: child, kind: "agent.delegation", createdAt: at, tone: "info",
          summary: "Saved worker", turnId: null,
          payload: { version: 1, threadId: child, parentThreadId: owner },
        } });
        yield* sql`INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${child}, 'thread', ${child}, 1, 'thread.activity-appended', ${at},
          'user', ${payload}, '{}', 1
        )`;
      }
      yield* importer.reconcileShells;
      for (const threadId of savedThreads) yield* importer.ensureTranscript(threadId);
      yield* orchestrator.dispatch(lifecycle("thread.archive", earlier, "archive-earlier-worker"));
      assert.isNull((yield* orchestrator.getThreadShell(parent))?.archivedAt);

      const now = yield* DateTime.now;
      const runId = RunId.make("saved-grandchild-run");
      const running = {
        id: runId, threadId: grandchild, ordinal: 1, providerInstanceId: modelSelection.instanceId,
        modelSelection, providerThreadId: null, rootNodeId: null, activeAttemptId: null,
        userMessageId: MessageId.make("saved-grandchild-message"), status: "running" as const,
        requestedAt: now, startedAt: now, completedAt: null, checkpointId: null, contextHandoffId: null,
      };
      yield* sink.write({ events: [{
        type: "run.created", id: EventId.make("worker-archive-running"), threadId: grandchild,
        runId, occurredAt: now, payload: running,
      }] });
      const refused = yield* orchestrator.dispatch({
        ...archive, commandId: CommandId.make("archive-busy-tree"),
      }).pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorDispatchError");
      if (refused._tag === "OrchestratorDispatchError") {
        assert.equal(
          refused.cause,
          `Worker ${grandchild} has unfinished work. Wait for it or stop it before archiving.`,
        );
      }
      for (const threadId of [parent, worker, grandchild]) {
        assert.isNull((yield* orchestrator.getThreadShell(threadId))?.archivedAt);
      }
      assert.equal((yield* orchestrator.getThreadRecords(grandchild, ["runs"])).runs[0]?.status, "running");
      yield* sink.write({ events: [{
        type: "run.updated", id: EventId.make("worker-archive-completed"), threadId: grandchild,
        runId, occurredAt: now, payload: { ...running, status: "completed", completedAt: now },
      }] });

      yield* sql`CREATE TEMP TRIGGER reject_worker_archive BEFORE INSERT ON orchestration_events
        WHEN NEW.stream_id = 'saved-grandchild' AND NEW.event_type = 'thread.archived'
        BEGIN SELECT RAISE(ABORT, 'worker event write failed'); END`;
      const failedCommit = yield* orchestrator.dispatch(archive).pipe(Effect.flip);
      assert.equal(failedCommit._tag, "OrchestratorDispatchError");
      assert.deepEqual(yield* sql`SELECT 1 FROM orchestration_events WHERE command_id = ${archive.commandId}`, []);
      assert.deepEqual(yield* sql`SELECT 1 FROM orchestration_command_receipts WHERE command_id = ${archive.commandId}`, []);
      for (const threadId of [parent, worker, grandchild]) {
        assert.isNull((yield* orchestrator.getThreadShell(threadId))?.archivedAt);
      }
      yield* sql`DROP TRIGGER reject_worker_archive`;

      const receipt = yield* orchestrator.dispatch(archive);
      const archived = receipt.storedEvents.filter(({ event }) => event.type === "thread.archived");
      assert.deepEqual(archived.map(({ event }) => event.threadId), [parent, worker, grandchild]);
      const timestamps = new Set(archived.map(({ event }) => DateTime.formatIso(event.occurredAt)));
      assert.equal(timestamps.size, 1);
      assert.isNull((yield* orchestrator.getThreadShell(unrelated))?.archivedAt);
      const { thread } = yield* orchestrator.getThreadRecords(worker, []);
      yield* sink.write({ events: [{
        id: EventId.make("worker-archive-later-metadata"),
        type: "thread.metadata-updated",
        threadId: worker,
        occurredAt: yield* DateTime.now,
        payload: { ...thread, title: "Archived worker" },
      }] });
      yield* sink.write({ events: [{
        id: EventId.make("worker-archive-latest-metadata"),
        type: "thread.metadata-updated",
        threadId: worker,
        occurredAt: yield* DateTime.now,
        payload: { ...thread, title: "Archived worker renamed" },
      }] });
      yield* maintenance.pruneEventStore();
      yield* TestClock.adjust("25 hours");
      const pruned = yield* maintenance.pruneEventStore();
      assert.isAbove(pruned.deletedEventCount, 0);
      assert.deepEqual(yield* sql`
        SELECT event_id FROM orchestration_events
        WHERE event_id IN ('worker-archive-later-metadata', 'worker-archive-latest-metadata')
        ORDER BY sequence
      `, [{ event_id: "worker-archive-latest-metadata" }]);
      return receipt;
    }).pipe(Effect.provide(testLayer));

    yield* Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const replay = yield* orchestrator.dispatch(archive);
      assert.equal(replay.sequence, accepted.sequence);
      assert.deepEqual(replay.storedEvents, accepted.storedEvents);
      assert.isTrue(replay.replayed);
      assert.equal((yield* orchestrator.dispatch({
        ...archive, commandId: CommandId.make("archive-already-archived"),
      }).pipe(Effect.flip))._tag, "OrchestratorDispatchError");
      const missingThread = yield* orchestrator.dispatch(
        lifecycle("thread.archive", missing, "archive-missing"),
      ).pipe(Effect.flip);
      assert.equal(missingThread._tag, "OrchestratorProjectionError");

      const restore = lifecycle("thread.unarchive", parent, "restore-saved-tree");
      const restored = yield* orchestrator.dispatch(restore);
      assert.deepEqual(restored.storedEvents.map(({ event }) => event.threadId), [parent, worker, grandchild]);
      for (const threadId of [parent, worker, grandchild, unrelated]) {
        assert.isNull((yield* orchestrator.getThreadShell(threadId))?.archivedAt);
      }
      assert.isNotNull((yield* orchestrator.getThreadShell(earlier))?.archivedAt);
      const replayedRestore = yield* orchestrator.dispatch(restore);
      assert.isTrue(replayedRestore.replayed);
      assert.equal(replayedRestore.sequence, restored.sequence);
      assert.deepEqual(replayedRestore.storedEvents, restored.storedEvents);
      yield* orchestrator.dispatch(lifecycle("thread.unarchive", earlier, "restore-earlier-worker"));
      assert.isNull((yield* orchestrator.getThreadShell(earlier))?.archivedAt);
    }).pipe(Effect.provide(testLayer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
