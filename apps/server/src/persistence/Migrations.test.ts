import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@j1code/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import {
  canonicalUpstreamMigrationId,
  FIRST_V2_MIGRATION_ID,
  latestMigrationId,
  migrationManifest,
  runMigrations,
} from "./Migrations.ts";

const v2Migrations = migrationManifest.filter(([id]) => id >= FIRST_V2_MIGRATION_ID);
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

it("maps upstream source IDs without reassigning released J1 migration IDs", () => {
  assert.equal(canonicalUpstreamMigrationId(1), 1);
  assert.equal(canonicalUpstreamMigrationId(54), 54);
  assert.equal(canonicalUpstreamMigrationId(55), 65);
  assert.equal(canonicalUpstreamMigrationId(64), 74);
  assert.equal(canonicalUpstreamMigrationId(96), 106);
  assert.equal(latestMigrationId, 116);
  const names = new Map<number, string>(migrationManifest);
  assert.equal(names.get(55), "DotConnections");
  assert.equal(names.get(64), "BotRoutineRuns");
  assert.equal(names.get(104), "TurnItemMessageOrdinalIndex");
  assert.equal(names.get(105), "TurnItemInlineWorkOutput");
  assert.equal(names.get(canonicalUpstreamMigrationId(55)), "OrchestrationV2");
  assert.equal(names.get(canonicalUpstreamMigrationId(64)), "CanonicalizeThreadPullRequestLinks");
  for (const id of [0, -1, 54.5, 97, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => canonicalUpstreamMigrationId(id), RangeError);
  }
});

describe("runMigrations", () => {
  it.effect("adds repository metadata without changing existing projects or ledger entries", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const at = "2026-01-01T00:00:00.000Z";
      yield* runMigrations({ toMigrationInclusive: 107 });
      yield* sql`
        INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('legacy-project', 'Existing project', '/workspace/existing', '[]', ${at}, ${at})
      `;
      const before = yield* history;
      const project = sql`
        SELECT project_id, title, workspace_root, scripts_json, created_at, updated_at
        FROM projection_projects WHERE project_id = 'legacy-project'
      `;
      const rows = yield* project;
      assert.lengthOf(rows, 1);

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 108 }), [
        [108, "ProjectionProjectsTrackedFolders"],
      ]);
      assert.deepStrictEqual(yield* history, [
        ...before,
        [108, "ProjectionProjectsTrackedFolders"],
      ]);
      assert.deepStrictEqual(yield* project, rows);
      assert.deepStrictEqual(
        yield* sql`SELECT tracked_folders_json FROM projection_projects WHERE project_id = 'legacy-project'`,
        [{ tracked_folders_json: "[]" }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'OrchestrationV2')
      `;
      const before = yield* history;

      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(runMigrations({ toMigrationInclusive: 54 }))),
      );
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "55_DotConnections (recorded: OrchestrationV2)");
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      for (const [id, name] of v2Migrations) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at exactly 54, then rechecks it without a write lock", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id > 54),
      );
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);

      // query_only rejects BEGIN IMMEDIATE, which CLI startup would otherwise take on the live database.
      yield* sql`PRAGMA query_only = ON`;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rejects a canonical J1 ledger missing recorded schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 64 });
      yield* sql`DROP TABLE bot_routine_runs`;
      const before = yield* history;
      const exit = yield* Effect.exit(runMigrations());
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "bot_routine_runs");
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("drops the unused correlation index and keeps correlation values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES (
          'event-1', 'thread', 'thread-1', 0, 'thread.created', '2026-01-01T00:00:00.000Z',
          'command-1', NULL, 'correlation-1', 'client', '{}', '{}'
        )
      `;

      yield* runMigrations();

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'orchestration_events' AND sql IS NOT NULL
      `;
      const indexNames = indexes.map((row) => row.name);
      assert.notInclude(indexNames, "idx_orch_events_correlation_id");
      for (const kept of [
        "idx_orch_events_stream_version",
        "idx_orch_events_stream_sequence",
        "idx_orch_events_command_id",
        "idx_orchestration_events_agent_stream_sequence",
      ]) {
        assert.include(indexNames, kept);
      }
      const events = yield* sql<{ readonly correlation_id: string | null }>`
        SELECT correlation_id FROM orchestration_events WHERE event_id = 'event-1'
      `;
      assert.deepStrictEqual(events, [{ correlation_id: "correlation-1" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 54])("refuses a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      const before = yield* history;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses an incompatible history even with a lower migration limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (56, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(runMigrations({ toMigrationInclusive: 55 }))),
      );
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 56 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "56_DotOAuth (recorded: SiteLocalMigration)");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps the migrations that finished before a later one failed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: canonicalUpstreamMigrationId(81) });
      yield* sql`CREATE TABLE orchestration_v2_projection_turn_item_counts (thread_id TEXT)`;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(
        yield* history,
        migrationManifest.filter(([id]) => id <= canonicalUpstreamMigrationId(84)),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("reapplies peer link migrations whose ledger rows are missing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: canonicalUpstreamMigrationId(72) });
      yield* sql`
        DELETE FROM effect_sql_migrations
        WHERE migration_id BETWEEN ${canonicalUpstreamMigrationId(70)} AND ${canonicalUpstreamMigrationId(72)}
      `;

      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id >= canonicalUpstreamMigrationId(70)),
      );
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses unknown newer migration IDs without modifying the ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      const before = yield* history;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

// Compare source identities as well as canonical IDs. Upstream effects retain their source filenames.
it.effect("registers every migration file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(import.meta.dirname, "Migrations");
    const files = (yield* fs.readDirectory(dir)).flatMap((name) => {
      const match = /^(\d+)_(\w+)\.ts$/.exec(name);
      return match ? [[Number(match[1]), match[2]] as const] : [];
    });
    assert.deepStrictEqual(
      files
        .map(([sourceId, name]) => {
          // J1-owned files already use canonical IDs. Upstream filenames use source IDs.
          const isCanonicalEntry = migrationManifest.some(
            ([id, entryName]) => id === sourceId && entryName === name,
          );
          return `${isCanonicalEntry ? sourceId : canonicalUpstreamMigrationId(sourceId)}:${name}`;
        })
        .toSorted(),
      migrationManifest.map(([id, name]) => `${id}:${name}`).toSorted(),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
