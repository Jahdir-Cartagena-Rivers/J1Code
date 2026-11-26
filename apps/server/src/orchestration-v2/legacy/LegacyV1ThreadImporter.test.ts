import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ComposerContextId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationMessageContext,
  type OrchestrationV2AppThreadLineage,
  ThreadId,
} from "@j1code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { listLinkedPullRequestThreads } from "../../pullRequest/linkedThreads.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";
import * as ProjectionReplay from "../testkit/ProjectionReplay.ts";
import * as ProjectionStore from "../ProjectionStore.ts";

import { layerReaderDatabase, traceSqlRouting } from "../../persistence/testkit/SqliteRouting.ts";

const layerDatabase = layerReaderDatabase;
const layerEventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(layerDatabase));
const layerProjectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase));
const layerStoresProvided = Layer.mergeAll(
  layerDatabase,
  layerEventStoreProvided,
  layerProjectionStoreProvided,
);
const layerEventSinkProvided = EventSink.layer.pipe(Layer.provide(layerStoresProvided));
const layerImporterProvided = LegacyV1ThreadImporter.layer.pipe(
  Layer.provide(Layer.mergeAll(layerStoresProvided, layerEventSinkProvided)),
);
const layerProjectionReplayProvided = ProjectionReplay.layer.pipe(
  Layer.provide(layerStoresProvided),
);
const layerTest = Layer.mergeAll(
  layerStoresProvided,
  layerEventSinkProvided,
  layerImporterProvided,
  layerProjectionReplayProvided,
);

const seedPendingTranscriptsWith = Effect.fnUntraced(function* <E>(beforeImport?: Effect.Effect<void, E>) {
  const sql = yield* SqlClient.SqlClient;
  const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const threadIds = [ThreadId.make("thread:first"), ThreadId.make("thread:later")];
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at
    ) VALUES (
      'project:background', 'Legacy project', '/tmp/legacy-background', '[]',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )
  `;
  for (const threadId of threadIds) {
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at
      ) VALUES (
        ${threadId}, 'project:background', 'Legacy thread',
        '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES
        (${`${threadId}:old`}, ${threadId}, 'user', 'Old question', 0,
          '2026-01-01T01:00:00.000Z', '2026-01-01T01:00:00.000Z'),
        (${`${threadId}:latest`}, ${threadId}, 'user', 'Latest question', 0,
          '2026-01-02T01:00:00.000Z', '2026-01-02T01:00:00.000Z')
    `;
  }
  if (beforeImport !== undefined) yield* beforeImport;
  yield* importer.reconcileShells;
});

const seedPendingTranscripts = seedPendingTranscriptsWith<never>();

it.effect("imports saved bot identity and repairs identity missing from an earlier import", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const columns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('projection_threads')
    `;
    if (!columns.some(({ name }) => name === "bot_identity_json")) {
      yield* sql`ALTER TABLE projection_threads ADD COLUMN bot_identity_json TEXT`;
    }
    const first = ThreadId.make("thread:first");
    const later = ThreadId.make("thread:later");
    const bot = { id: "original-bot", name: "Saved name", instructions: "Saved instructions" };
    const saveBot = (id: ThreadId, value: unknown) =>
      sql`UPDATE projection_threads SET bot_identity_json = ${JSON.stringify(value) ?? "null"} WHERE thread_id = ${id}`;
    yield* seedPendingTranscriptsWith(saveBot(first, bot).pipe(Effect.asVoid));
    assert.deepEqual((yield* store.getThread(first)).bot, bot);
    assert.notProperty(yield* store.getThread(later), "bot");

    // An earlier import can have a shell without the saved identity. Refuse to advance it
    // while the legacy value is malformed, and retry after the source is repaired.
    const events = yield* EventStore.EventStoreV2;
    const readProgress = () =>
      sql`SELECT * FROM orchestration_v2_legacy_imports WHERE thread_id = ${later}`;
    const pendingBefore = yield* readProgress();
    const shellBefore = yield* store.getThread(later);
    const sequenceBefore = yield* events.latestApplicationSequence;
    yield* sql`UPDATE projection_threads SET bot_identity_json = '{"id":' WHERE thread_id = ${later}`;
    const failure = yield* importer.reconcileShells.pipe(Effect.flip);
    assert.equal(failure._tag, "LegacyV1ThreadImportError");
    assert.equal(failure.threadId, later);
    assert.equal(yield* events.latestApplicationSequence, sequenceBefore);
    assert.deepEqual(yield* store.getThread(later), shellBefore);
    assert.deepEqual(yield* readProgress(), pendingBefore);

    yield* saveBot(later, bot);
    yield* importer.reconcileShells;
    assert.deepEqual((yield* store.getThread(later)).bot, bot);
    assert.deepEqual((yield* store.getThreadShell(later))?.bot, { id: bot.id, name: bot.name });

    // Repair must never overwrite an identity V2 has already captured.
    yield* sql`UPDATE projection_threads SET bot_identity_json = '{"id":' WHERE thread_id = ${later}`;
    yield* sql`UPDATE orchestration_v2_projection_threads
      SET payload_json = json_remove(payload_json, '$.pinOrderKey')
      WHERE thread_id = ${later}`;
    yield* importer.reconcileShells;
    assert.deepEqual((yield* store.getThread(later)).bot, bot);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { label: "malformed JSON", raw: '{"instructions":"fixture-private-text"' },
  { label: "JSON null", raw: "null" },
  { label: "missing instructions", raw: '{"id":"fixture-private-text","name":"Saved bot"}' },
  {
    label: "numeric bot ID",
    raw: '{"id":42,"name":"Saved bot","instructions":"fixture-private-text"}',
  },
])("refuses $label without advancing that legacy thread", ({ raw }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    const ordinary = ThreadId.make("thread:first");
    const affected = ThreadId.make("thread:later");
    const repaired = { id: "saved-bot", name: "Saved bot", instructions: "Recovered instructions" };
    const setIdentity = (value: string) =>
      sql`UPDATE projection_threads SET bot_identity_json = ${value} WHERE thread_id = ${affected}`;
    const readProgress = () =>
      sql`SELECT thread_id FROM orchestration_v2_legacy_imports ORDER BY thread_id`;
    const failure = yield* seedPendingTranscriptsWith(Effect.gen(function* () {
      const columns = yield* sql<{ name: string }>`
        SELECT name FROM pragma_table_info('projection_threads')
      `;
      if (!columns.some(({ name }) => name === "bot_identity_json")) {
        yield* sql`ALTER TABLE projection_threads ADD COLUMN bot_identity_json TEXT`;
      }
      yield* setIdentity(raw);
    })).pipe(Effect.flip);
    assert.equal(failure._tag, "LegacyV1ThreadImportError");
    if (failure._tag !== "LegacyV1ThreadImportError") return;
    assert.equal(failure.threadId, affected);
    assert.include(failure.message, "validate saved bot identity");
    assert.isUndefined(failure.cause);
    assert.notInclude(JSON.stringify(failure), "fixture-private-text");

    assert.notProperty(yield* store.getThread(ordinary), "bot");
    assert.isNull(yield* store.getThreadShell(affected));
    assert.deepEqual(yield* events.read({ threadId: affected }).pipe(Stream.runCollect), []);
    assert.deepEqual(yield* readProgress(), [{ thread_id: ordinary }]);
    assert.deepEqual(
      yield* sql`SELECT bot_identity_json FROM projection_threads WHERE thread_id = ${affected}`,
      [{ bot_identity_json: raw }],
    );
    assert.deepEqual(
      yield* sql`
        SELECT text FROM projection_thread_messages
        WHERE thread_id = ${affected} ORDER BY created_at
      `,
      [{ text: "Old question" }, { text: "Latest question" }],
    );

    yield* setIdentity(JSON.stringify(repaired));
    const retry = yield* importer.reconcileShells;
    assert.equal(retry.importedThreadCount, 1);
    assert.deepEqual(yield* readProgress(), [{ thread_id: ordinary }, { thread_id: affected }]);
    assert.deepEqual((yield* store.getThread(affected)).bot, repaired);
    const reopened = yield* Effect.gen(function* () {
      const freshImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      return yield* freshImporter.reconcileShells;
    }).pipe(Effect.provide(LegacyV1ThreadImporter.layer));
    assert.deepEqual(reopened, { importedThreadCount: 0, importedMessageCount: 0 });
    assert.deepEqual((yield* store.getThread(affected)).bot, repaired);
  }).pipe(Effect.provide(layerTest)),
);

const verifyWorkerLineageImport = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const root = ThreadId.make("thread:first");
  const child = ThreadId.make("thread:later");
  const id = (name: string) => ThreadId.make(`thread:lineage:${name}`);
  const at = "2026-01-01T00:00:00.000Z";
  const addThread = (name: string, projectId = "project:background", deleted = false) =>
    sql`INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
      created_at, updated_at, archived_at, deleted_at
    ) VALUES (${id(name)}, ${projectId}, 'Worker: title supplies no lineage',
      '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
      ${at}, ${at}, ${name === "grandchild" ? at : null}, ${deleted ? at : null})`;
  const saveLink = (
    threadId: ThreadId, parentThreadId: unknown, ordinal = 1,
    options: { readonly version?: number | boolean; readonly activityThreadId?: ThreadId;
      readonly envelopeThreadId?: ThreadId; readonly malformed?: boolean } = {},
  ) => {
    const eventId = `legacy-lineage:${threadId}:${ordinal}`;
    const payload = options.malformed ? "broken-json" : JSON.stringify({
      threadId: options.envelopeThreadId ?? threadId,
      activity: {
        id: eventId,
        kind: "agent.delegation",
        payload: { version: options.version ?? 1,
          threadId: options.activityThreadId ?? threadId, parentThreadId },
      },
    });
    return sql`INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type,
      occurred_at, actor_kind, payload_json, metadata_json, application_event_version
    ) VALUES (${eventId}, 'thread', ${threadId},
      (SELECT COALESCE(MAX(stream_version), 0) + 1 FROM orchestration_events
       WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}),
      'thread.activity-appended', ${at}, 'server', ${payload}, '{}', 1)`;
  };
  const refused = ["bad-record", "deleted-parent", "missing-parent", "foreign-parent",
    "cycle-a", "cycle-b", "ambiguous"];
  yield* seedPendingTranscriptsWith(Effect.gen(function* () {
    yield* sql`INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at
    ) VALUES ('project:foreign-lineage', 'Foreign', '/foreign', '[]', ${at}, ${at})`;
    for (const name of ["grandchild", "repair", "repair-neighbor", "authority", ...refused]) {
      yield* addThread(name);
    }
    yield* addThread("foreign", "project:foreign-lineage");
    yield* addThread("deleted", "project:background", true);
    yield* sql`UPDATE projection_threads SET created_at = '2025-01-01T00:00:00.000Z'
      WHERE thread_id = ${child}`;
    yield* saveLink(child, root);
    yield* saveLink(id("grandchild"), child);
    yield* saveLink(id("bad-record"), root, 1, { malformed: true });
    yield* saveLink(id("bad-record"), 42, 2);
    yield* saveLink(id("bad-record"), "", 3);
    yield* saveLink(id("bad-record"), id("bad-record"), 4);
    yield* saveLink(id("bad-record"), root, 5, { activityThreadId: child });
    yield* saveLink(id("bad-record"), root, 6, { envelopeThreadId: child });
    yield* saveLink(id("bad-record"), root, 7, { version: 2 });
    yield* saveLink(id("bad-record"), root, 8, { version: true });
    yield* saveLink(id("deleted-parent"), id("deleted"));
    yield* saveLink(id("missing-parent"), id("missing"));
    yield* saveLink(id("foreign-parent"), id("foreign"));
    yield* saveLink(id("cycle-a"), id("cycle-b"));
    yield* saveLink(id("cycle-b"), id("cycle-a"));
    yield* saveLink(id("ambiguous"), root);
    yield* saveLink(id("ambiguous"), child, 2);
  }));
  const childLineage: OrchestrationV2AppThreadLineage = {
    parentThreadId: root,
    relationshipToParent: "subagent",
    rootThreadId: root,
  };
  const grandchildLineage = { ...childLineage, parentThreadId: child };
  assert.deepEqual((yield* store.getThread(child)).lineage, childLineage);
  assert.deepEqual((yield* store.getThreadShell(child))?.lineage, childLineage);
  const active = yield* store.getShellSnapshot({ familyOf: root, location: "active" });
  assert.deepEqual(active.threads.find(({ id }) => id === child)?.lineage, childLineage);
  const archive = yield* store.getShellSnapshot({ familyOf: root, location: "archive" });
  assert.deepEqual(archive.archivedThreads.map(({ id, lineage }) => [id, lineage]), [
    [id("grandchild"), grandchildLineage],
  ]);
  for (const name of refused) {
    assert.deepEqual((yield* store.getThread(id(name))).lineage, {
      parentThreadId: null, relationshipToParent: null, rootThreadId: id(name),
    });
  }

  const authority = yield* store.getThread(id("authority"));
  const corrected = {
    ...authority,
    lineage: { parentThreadId: root, relationshipToParent: "fork" as const, rootThreadId: root },
  };
  yield* store.apply({
    id: EventId.make("lineage-authority-update"),
    type: "thread.metadata-updated",
    occurredAt: DateTime.makeUnsafe(at),
    threadId: authority.id,
    payload: corrected,
  });
  yield* saveLink(authority.id, child);
  yield* saveLink(id("repair"), child);
  yield* saveLink(id("repair-neighbor"), root);
  const pendingBefore = yield* sql`SELECT * FROM orchestration_v2_legacy_imports ORDER BY thread_id`;
  yield* sql`CREATE TEMP TRIGGER reject_lineage_fixture BEFORE INSERT ON orchestration_events
    WHEN NEW.event_id LIKE '%:worker-lineage:%' AND NEW.stream_id = 'thread:lineage:repair'
    BEGIN SELECT RAISE(ABORT, 'fixture lineage write failed'); END`;
  const error = yield* importer.reconcileShells.pipe(Effect.flip);
  assert.equal(error._tag, "LegacyV1ThreadImportError");
  assert.isNull((yield* store.getThread(id("repair"))).lineage.parentThreadId);
  assert.isNull((yield* store.getThread(id("repair-neighbor"))).lineage.parentThreadId);
  yield* sql`DROP TRIGGER reject_lineage_fixture`;

  assert.deepEqual(yield* importer.reconcileShells, { importedThreadCount: 2, importedMessageCount: 0 });
  assert.deepEqual((yield* store.getThread(id("repair"))).lineage, grandchildLineage);
  assert.deepEqual((yield* store.getThread(id("repair-neighbor"))).lineage, childLineage);
  assert.deepEqual((yield* store.getThread(authority.id)).lineage, corrected.lineage);
  assert.deepEqual(
    yield* sql`SELECT * FROM orchestration_v2_legacy_imports ORDER BY thread_id`,
    pendingBefore,
  );
  return { repairedId: id("repair"), lineage: grandchildLineage };
});

it.effect("imports and repairs validated worker families across SQLite reopen", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "j1-import-worker-lineage-" });
    const database = Sqlite.layerFromPath(path.join(directory, "state.sqlite"));
    const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
      Layer.provideMerge(database),
    );
    const dependencies = EventSink.layer.pipe(Layer.provideMerge(stores));
    const layer = LegacyV1ThreadImporter.layer.pipe(Layer.provideMerge(dependencies));
    const repaired = yield* verifyWorkerLineageImport.pipe(Effect.provide(layer), Effect.scoped);
    yield* Effect.gen(function* () {
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      assert.deepEqual(yield* importer.reconcileShells, {
        importedThreadCount: 0, importedMessageCount: 0,
      });
      assert.deepEqual((yield* store.getThreadShell(repaired.repairedId))?.lineage, repaired.lineage);
    }).pipe(Effect.provide(Layer.fresh(layer)), Effect.scoped);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("routes shell selectors to readers while imports stay writable", () =>
  Effect.gen(function* () {
    const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const sql = yield* SqlClient.SqlClient;
    const { queries, trace } = traceSqlRouting();
    yield* seedPendingTranscripts.pipe(trace);
    const selectors = queries.filter(
      ({ query }) =>
        query.includes("FROM projection_threads AS thread") ||
        query.includes("FROM orchestration_v2_legacy_imports AS legacy_import") ||
        query.includes("FROM projection_thread_messages AS message"),
    );
    assert.lengthOf(selectors, 6);
    assert.deepEqual([...new Set(selectors.map((row) => row.connection))], ["reader"]);
    assert.deepEqual(yield* importer.reconcileShells, {
      importedThreadCount: 0,
      importedMessageCount: 0,
    });
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES (
          'thread:uncommitted', 'project:background', 'Uncommitted legacy title',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, role, text, is_streaming, created_at, updated_at
          ) VALUES (
            'message:uncommitted', 'thread:uncommitted', 'user', 'Uncommitted preview', 0,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
          )
        `;
        yield* sql`
          UPDATE orchestration_v2_projection_threads
          SET payload_json = json_remove(payload_json, '$.pinnedAt')
          WHERE thread_id = 'thread:first'
        `;
        yield* sql`
          UPDATE projection_threads SET pinned_at = '2026-01-01T00:00:00.000Z'
          WHERE thread_id = 'thread:first'
        `;
        const result = yield* importer.reconcileShells;
        assert.deepEqual(result, { importedThreadCount: 2, importedMessageCount: 1 });
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const repaired = yield* projections.getThreadProjection(ThreadId.make("thread:first"));
        assert.equal(DateTime.formatIso(repaired.thread.pinnedAt!), "2026-01-01T00:00:00.000Z");
        const imported = yield* projections.getThreadProjection(
          ThreadId.make("thread:uncommitted"),
        );
        assert.equal(imported.messages[0]?.text, "Uncommitted preview");
        assert.equal(
          (yield* projections.getThreadProjection(ThreadId.make("thread:uncommitted"))).thread
            .title,
          "Uncommitted legacy title",
        );
      }),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "keeps hydrating later transcripts after a defect and leaves the failed thread pending",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* seedPendingTranscripts;

      yield* importer.importPendingTranscripts.pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) => {
          const [query, params] = statement.compile();
          return query.includes("FROM projection_thread_messages") &&
            params.includes("thread:first")
            ? Effect.die("transcript read failed")
            : Effect.succeed(statement);
        }),
      );

      const later = yield* projections.getThreadProjection(ThreadId.make("thread:later"));
      assert.deepStrictEqual(
        later.messages.map((message) => message.text),
        ["Old question", "Latest question"],
      );
      assert.deepStrictEqual(
        yield* sql`
          SELECT thread_id, transcript_imported_at, last_error FROM orchestration_v2_legacy_imports
          WHERE transcript_imported_at IS NULL OR last_error IS NOT NULL
        `,
        [
          {
            thread_id: "thread:first",
            transcript_imported_at: null,
            last_error: "Transcript hydration failed; retry on next open.",
          },
        ],
      );
    }).pipe(Effect.provide(layerTest)),
);

// regression: #15920 one bad legacy message stopped the server from starting
it.effect("propagates interruption from transcript reads and retry-marker writes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    yield* seedPendingTranscripts;
    const interrupted = [];
    for (const phase of ["transcript", "retry-marker"]) {
      const exit = yield* importer.importPendingTranscripts.pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) => {
          const [query, params] = statement.compile();
          const readingTranscript =
            query.includes("FROM projection_thread_messages") && params.includes("thread:first");
          const writingRetryMarker =
            query.includes("SET last_error =") && params.includes("thread:first");
          if (phase === "retry-marker" && readingTranscript) {
            return Effect.die("transcript read failed");
          }
          if (phase === "transcript" ? readingTranscript : writingRetryMarker) {
            return Effect.interrupt;
          }
          return Effect.succeed(statement);
        }),
        Effect.exit,
      );
      interrupted.push(Exit.hasInterrupts(exit));
    }
    assert.deepStrictEqual(interrupted, [true, true]);
    assert.deepStrictEqual(
      yield* sql`
        SELECT thread_id FROM orchestration_v2_legacy_imports
        WHERE transcript_imported_at IS NOT NULL OR last_error IS NOT NULL
      `,
      [],
    );
  }).pipe(Effect.provide(layerTest)),
);

// regression: #30813 a malformed V1 timestamp stopped the server from starting
it.effect("imports legacy rows with malformed timestamps and keeps the archive marker", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const malformed = "2026-07-13T14:13:00.3NZ";
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at
      ) VALUES (
        'project:malformed', 'Legacy project', '/tmp/legacy-malformed', '[]',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at, archived_at
      ) VALUES (
        'thread:malformed', 'project:malformed', 'Legacy thread',
        '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
        '2026-07-13T14:00:00.000Z', ${malformed}, ${malformed}
      )
    `;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES (
        'message:malformed', 'thread:malformed', 'user', 'Question', 0,
        ${malformed}, '2026-07-13T14:13:00.000Z'
      )
    `;

    assert.deepStrictEqual(yield* importer.reconcileShells, {
      importedThreadCount: 1,
      importedMessageCount: 1,
    });
    const projection = yield* projections.getThreadProjection(ThreadId.make("thread:malformed"));
    assert.isNotNull(projection.thread.archivedAt);
    assert.deepStrictEqual(
      projection.messages.map((message) => message.text),
      ["Question"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("caches the absent legacy transcript for a native V2 thread", () =>
  Effect.gen(function* () {
    const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const eventSink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:v2-born");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("event:v2-born"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            id: threadId,
            projectId: ProjectId.make("project:v2-born"),
            title: "Native V2 thread",
            providerInstanceId,
            modelSelection: { instanceId: providerInstanceId, model: "gpt-6" },
            createdBy: "user",
            creationSource: "web",
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        },
      ],
    });
    const before = yield* projections.getThreadProjection(threadId);
    let legacyLookups = 0;
    for (let read = 0; read < 3; read++) {
      const summary = yield* importer.ensureTranscript(threadId).pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) => {
          const [query, parameters] = statement.compile();
          if (
            query.includes("FROM orchestration_v2_legacy_imports") &&
            parameters[0] === threadId
          ) {
            legacyLookups++;
          }
          return Effect.succeed(statement);
        }),
      );
      assert.deepStrictEqual(summary, { importedThreadCount: 0, importedMessageCount: 0 });
    }
    assert.equal(legacyLookups, 1);
    assert.deepStrictEqual(yield* projections.getThreadProjection(threadId), before);
  }).pipe(Effect.provide(layerTest)),
);

describe("LegacyV1ThreadImporter", () => {
  it.effect.each(["fresh", "preview", "completed"] as const)(
    "preserves reasoning while hydrating or repairing a %s transcript",
    (state) => Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:legacy-import");

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          'project:legacy-import',
          'Legacy project',
          '/tmp/legacy-project',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          unsettled_at,
          snoozed_until,
          snoozed_at,
          pinned_at,
          pin_order_key,
          linked_pull_request_json,
          deleted_at
        ) VALUES (
          ${threadId},
          'project:legacy-import',
          'Migrated conversation',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          ' main ',
          ' /tmp/legacy-project ',
          NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          NULL,
          NULL,
          NULL,
          '2026-01-03T12:00:00.000Z',
          '2026-02-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          'm',
          '{"projectId":"project:legacy-import","repository":"pingdotgg/t3code","number":9000,"url":"https://github.com/pingdotgg/t3code/pull/9000"}',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        ) VALUES
          (
            'message:legacy:1',
            ${threadId},
            NULL,
            'user',
            'First question',
            '[]',
            0,
            '2026-01-01T01:00:00.000Z',
            '2026-01-01T01:00:00.000Z'
          ),
          (
            'message:legacy:2',
            ${threadId},
            NULL,
            'assistant',
            'First answer',
            '[]',
            0,
            '2026-01-02T01:00:00.000Z',
            '2026-01-02T01:00:00.000Z'
          ),
          (
            'message:legacy:3',
            ${threadId},
            NULL,
            'user',
            'Follow-up question',
            '[]',
            0,
            '2026-01-03T01:00:00.000Z',
            '2026-01-03T01:00:00.000Z'
          ),
          (
            'message:legacy:4',
            ${threadId},
            NULL,
            'assistant',
            'Partial answer',
            '[]',
            1,
            '2026-01-04T01:00:00.000Z',
            '2026-01-04T01:00:00.000Z'
        )
      `;

      const seedReasoning = sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json, is_streaming,
          created_at, updated_at
        ) VALUES
          ('message:legacy:thought', ${threadId}, NULL, 'reasoning', 'Checking evidence', '[]', 1,
            '2026-01-03T02:00:00.000Z', '2026-01-03T02:00:01.000Z'),
          ('message:legacy:status', ${threadId}, NULL, 'system', 'System status', '[]', 0,
            '2026-01-05T01:00:00.000Z', '2026-01-05T01:00:00.000Z')
      `;

      if (state === "fresh") yield* seedReasoning;

      const validContext = {
        version: 1,
        records: [
          {
            version: 1,
            contextId: ComposerContextId.make("ctx_1"),
            kind: "skill",
            label: "$test",
            name: "test",
          },
        ],
      } satisfies OrchestrationMessageContext;
      yield* sql`
        UPDATE projection_thread_messages
        SET context_json = CASE message_id
          WHEN 'message:legacy:2' THEN '{broken-json'
          WHEN 'message:legacy:3' THEN '{"version":2,"records":[]}'
          ELSE ${JSON.stringify(validContext)}
        END
        WHERE thread_id = ${threadId}
      `;
      yield* sql`
        INSERT INTO projection_thread_pull_requests (
          thread_id, host, repository, number, url, source, linked_at, snapshot_json
        ) VALUES
          (${threadId}, 'github.com', 'pingdotgg/t3code', 9002,
            'https://github.com/pingdotgg/t3code/pull/9002', 'created',
            '2026-01-03T00:00:00.000Z',
            '{"state":"open","title":"Second PR","headBranch":"feature-two","baseBranch":"main","isDraft":false,"updatedAt":"2026-01-03T00:00:00.000Z","syncedAt":"2026-01-03T00:00:00.000Z"}'),
          (${threadId}, 'github.com', 'pingdotgg/t3code', 9003,
            'https://github.com/pingdotgg/t3code/pull/9003', 'manual',
            '2026-01-04T00:00:00.000Z', NULL)
      `;

      assert.equal(yield* importer.pendingThreadCount, 1);
      const shellImport = yield* importer.reconcileShells;
      assert.equal(yield* importer.pendingThreadCount, 1);
      assert.deepStrictEqual(shellImport, {
        importedThreadCount: 1,
        importedMessageCount: 2,
      });
      const shellEventCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.equal(shellEventCount[0]?.count, 6);

      assert.isTrue((yield* maintenance.verify).valid);
      const shellProjection = yield* projections.getThreadProjection(threadId);
      assert.equal(shellProjection.thread.historyOrigin, "v1_import");
      assert.equal(shellProjection.thread.branch, "main");
      assert.equal(shellProjection.thread.worktreePath, "/tmp/legacy-project");
      assert.deepEqual(
        shellProjection.thread.pinnedAt,
        DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      );
      assert.equal(shellProjection.thread.pinOrderKey, "m");
      assert.deepEqual(
        shellProjection.thread.snoozedUntil,
        DateTime.makeUnsafe("2026-02-01T00:00:00.000Z"),
      );
      assert.deepEqual(
        shellProjection.thread.unsettledAt,
        DateTime.makeUnsafe("2026-01-03T12:00:00.000Z"),
      );
      assert.equal(shellProjection.thread.linkedPullRequest?.number, 9000);
      assert.deepStrictEqual(
        (shellProjection.thread.pullRequests ?? []).map((link) => link.number),
        [9002, 9003, 9000],
      );
      assert.equal(shellProjection.thread.pullRequests?.[0]?.snapshot?.title, "Second PR");
      assert.deepStrictEqual(
        (yield* listLinkedPullRequestThreads({
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 9002,
        })).threads.map((thread) => thread.id),
        [threadId],
      );
      const shellSnapshot = yield* projections.getShellSnapshot();
      assert.equal(
        shellSnapshot.threads.find((thread) => thread.id === threadId)?.historyOrigin,
        "v1_import",
      );
      assert.deepStrictEqual(
        shellProjection.messages.map((message) => message.id),
        ["message:legacy:3", "message:legacy:4"],
      );
      assert.deepStrictEqual(
        shellProjection.messages.map((message) => [message.text, message.context]),
        [
          ["Follow-up question", undefined],
          ["Partial answer", validContext],
        ],
      );

      const renamedAt = DateTime.makeUnsafe("2026-01-05T00:00:00.000Z");
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:legacy-import:metadata-after-shell"),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: shellProjection.thread.providerInstanceId,
            occurredAt: renamedAt,
            payload: {
              ...shellProjection.thread,
              title: "Renamed after shell import",
              runtimeMode: "approval-required",
              interactionMode: "plan",
              archivedAt: renamedAt,
              settledOverride: "settled",
              settledAt: renamedAt,
              updatedAt: renamedAt,
            },
          },
        ],
      });

      if (state === "completed") yield* importer.ensureTranscript(threadId);
      if (state !== "fresh") yield* seedReasoning;
      const sourceMessages = yield* sql`
        SELECT * FROM projection_thread_messages WHERE thread_id = ${threadId} ORDER BY message_id
      `;


      const repair = Effect.gen(function* () {
        const freshImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        if (state === "completed") {
          const readPositions = sql`
            SELECT turn_item_id, ordinal FROM orchestration_v2_turn_item_positions
            WHERE thread_id = ${threadId} ORDER BY ordinal
          `;
          const before = yield* readPositions;
          yield* sql`
            CREATE TRIGGER reject_reasoning_insert BEFORE INSERT ON orchestration_events
            WHEN NEW.event_id = 'migration:v1:turn-item:message:legacy:thought'
            BEGIN SELECT RAISE(ABORT, 'fixture rejects reasoning'); END
          `;
          const unsuccessful = yield* Effect.exit(freshImporter.ensureTranscript(threadId));
          assert.isTrue(Exit.isFailure(unsuccessful));
          assert.deepStrictEqual(yield* readPositions, before);
          yield* sql`DROP TRIGGER reject_reasoning_insert`;
        }
        return yield* freshImporter.importPendingTranscripts;
      });
      const transcriptImport = yield* repair.pipe(
        Effect.provide(Layer.fresh(LegacyV1ThreadImporter.layer)),
      );
      assert.equal(yield* importer.pendingThreadCount, 0);
      assert.deepStrictEqual(transcriptImport, {
        importedThreadCount: 1,
        importedMessageCount: state === "completed" ? 1 : 3,
      });
      const projection = yield* projections.getThreadProjection(threadId);
      assert.equal(projection.thread.title, "Renamed after shell import");
      assert.isNull(projection.thread.lastVisitedAt);
      assert.equal(projection.thread.runtimeMode, "approval-required");
      assert.equal(projection.thread.interactionMode, "plan");
      assert.deepEqual(projection.thread.archivedAt, renamedAt);
      assert.equal(projection.thread.settledOverride, "settled");
      assert.deepEqual(projection.thread.settledAt, renamedAt);
      assert.deepStrictEqual(
        projection.messages.map((message) => message.id),
        ["message:legacy:1", "message:legacy:2", "message:legacy:3", "message:legacy:4"],
      );
      const expectedMessages = [
        ["First question", validContext],
        ["First answer", undefined],
        ["Follow-up question", undefined],
        ["Partial answer", validContext],
      ];
      assert.deepStrictEqual(
        projection.messages.map((message) => [message.text, message.context]),
        expectedMessages,
      );
      assert.deepStrictEqual(
        yield* sql`
          SELECT * FROM projection_thread_messages WHERE thread_id = ${threadId} ORDER BY message_id
        `,
        sourceMessages,
      );
      assert.deepStrictEqual(
        projection.turnItems
          .filter(
            (
              item,
            ): item is Extract<
              (typeof projection.turnItems)[number],
              { readonly type: "user_message" | "assistant_message" }
            > => item.type === "user_message" || item.type === "assistant_message",
          )
          .map((item) => [item.messageId, item.ordinal, item.status]),
        [
          ["message:legacy:1", 1, "completed"],
          ["message:legacy:2", 2, "completed"],
          ["message:legacy:3", 3, "completed"],
          ["message:legacy:4", 5, "interrupted"],
        ],
      );

      assert.deepStrictEqual(
        projection.turnItems.flatMap((item) =>
          item.type === "reasoning"
            ? [[item.id, item.ordinal, item.status, item.text, item.streaming]]
            : [],
        ),
        [["migration:v1:turn-item:message:legacy:thought", 4, "interrupted", "Checking evidence", false]],
      );

      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:legacy-import:explicit-unpin"),
            type: "thread.unpinned",
            threadId,
            providerInstanceId: projection.thread.providerInstanceId,
            occurredAt: renamedAt,
            payload: { ...projection.thread, pinnedAt: null, pinOrderKey: null },
          },
        ],
      });
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_remove(
          payload_json,
          '$.snoozedUntil',
          '$.snoozedAt',
          '$.unsettledAt',
          '$.linkedPullRequest',
          '$.pullRequests'
        )
        WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 1,
        importedMessageCount: 0,
      });
      const repaired = yield* projections.getThreadProjection(threadId);
      assert.isNull(repaired.thread.pinnedAt);
      assert.isNull(repaired.thread.pinOrderKey);
      assert.deepEqual(
        repaired.thread.snoozedUntil,
        DateTime.makeUnsafe("2026-02-01T00:00:00.000Z"),
      );
      assert.deepEqual(
        repaired.thread.unsettledAt,
        DateTime.makeUnsafe("2026-01-03T12:00:00.000Z"),
      );
      assert.equal(repaired.thread.linkedPullRequest?.number, 9000);
      assert.deepStrictEqual(
        (repaired.thread.pullRequests ?? []).map((link) => link.number),
        [9002, 9003, 9000],
      );
      assert.equal(repaired.thread.pullRequests?.[0]?.snapshot?.title, "Second PR");
      const eventCountBeforeRetry = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });
      assert.deepStrictEqual(yield* importer.ensureTranscript(threadId), {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });
      assert.deepStrictEqual(
        yield* Effect.flatMap(
          LegacyV1ThreadImporter.LegacyV1ThreadImporter,
          (reopened) => reopened.ensureTranscript(threadId),
        ).pipe(Effect.provide(Layer.fresh(LegacyV1ThreadImporter.layer))),
        { importedThreadCount: 0, importedMessageCount: 0 },
      );
      assert.isTrue((yield* maintenance.rebuild).valid);
      const replayed = yield* projections.getThreadProjection(threadId);
      assert.deepStrictEqual(replayed.turnItems, projection.turnItems);
      const eventCountAfterRetry = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.equal(eventCountAfterRetry[0]?.count, eventCountBeforeRetry[0]?.count);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("repairs newly added metadata after an earlier metadata repair", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:legacy-metadata-upgrade");
      const previousRepairId = EventId.make(`migration:v1:thread:${threadId}:metadata-repair`);

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'project:legacy-metadata-upgrade',
          'Legacy project',
          '/tmp/legacy-metadata-upgrade',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, pinned_at, pin_order_key,
          linked_pull_request_json, branch_pull_request_json, active_order_key
        ) VALUES (
          ${threadId},
          'project:legacy-metadata-upgrade',
          'Original v1 title',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          'm',
          '{"projectId":"project:legacy-metadata-upgrade","repository":"pingdotgg/t3code","number":9000,"url":"https://github.com/pingdotgg/t3code/pull/9000"}',
          '{"projectId":"project:legacy-metadata-upgrade","repository":"pingdotgg/t3code","number":9001,"url":"https://github.com/pingdotgg/t3code/pull/9001"}',
          'az'
        )
      `;
      yield* importer.reconcileShells;
      yield* maintenance.rebuild;
      const shellProjection = yield* projections.getThreadProjection(threadId);
      assert.deepStrictEqual(
        (shellProjection.thread.pullRequests ?? []).map((link) => link.number),
        [9000],
      );
      const previousRepairThread = {
        ...shellProjection.thread,
        title: "Renamed in v2",
        pinnedAt: null,
        pinOrderKey: null,
        linkedPullRequest: null,
        pullRequests: [],
      };
      delete previousRepairThread.branchPullRequest;
      delete previousRepairThread.activeOrderKey;
      yield* eventSink.write({
        events: [
          {
            id: previousRepairId,
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: previousRepairThread.providerInstanceId,
            occurredAt: DateTime.makeUnsafe("2026-01-03T00:00:00.000Z"),
            payload: previousRepairThread,
          },
        ],
      });

      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 1,
        importedMessageCount: 0,
      });
      const repaired = yield* projections.getThreadProjection(threadId);
      assert.equal(repaired.thread.title, "Renamed in v2");
      assert.isNull(repaired.thread.pinnedAt);
      assert.isNull(repaired.thread.pinOrderKey);
      assert.isNull(repaired.thread.linkedPullRequest);
      assert.deepStrictEqual(repaired.thread.pullRequests, []);
      assert.equal(repaired.thread.branchPullRequest?.number, 9001);
      assert.equal(repaired.thread.activeOrderKey, "az");

      const eventsBeforeRetry = yield* sql<{ readonly event_id: string }>`
        SELECT event_id
        FROM orchestration_events
        WHERE application_event_version = 2 AND stream_id = ${threadId}
        ORDER BY sequence
      `;
      assert.equal(eventsBeforeRetry.length, 4);
      assert.isTrue(eventsBeforeRetry.some((event) => event.event_id === previousRepairId));
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });

      assert.isTrue((yield* maintenance.rebuild).valid);
      const replayed = yield* projections.getThreadProjection(threadId);
      assert.deepStrictEqual(replayed.thread, repaired.thread);
      assert.deepStrictEqual(
        yield* Effect.gen(function* () {
          const restartedImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
          return yield* restartedImporter.reconcileShells;
        }).pipe(Effect.provide(LegacyV1ThreadImporter.layer)),
        { importedThreadCount: 0, importedMessageCount: 0 },
      );
      const eventsAfterRestart = yield* sql<{ readonly event_id: string }>`
        SELECT event_id
        FROM orchestration_events
        WHERE application_event_version = 2 AND stream_id = ${threadId}
        ORDER BY sequence
      `;
      assert.deepStrictEqual(eventsAfterRestart, eventsBeforeRetry);
    }).pipe(Effect.provide(layerTest)),
  );
});
