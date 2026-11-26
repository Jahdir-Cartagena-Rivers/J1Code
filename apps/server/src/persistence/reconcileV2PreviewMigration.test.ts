import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@j1code/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import OrchestrationV2 from "./Migrations/055_OrchestrationV2.ts";

import { reconciledV2PreviewHistory } from "./reconcileV2PreviewMigration.ts";

const seedPreview = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 52 });
  yield* Migrator.make({})({
    loader: Migrator.fromRecord({ "53_OrchestrationV2": OrchestrationV2 }),
  });
  yield* sql`
    INSERT INTO orchestration_v2_legacy_imports
      (thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count)
    VALUES ('preview-thread', '2026-09-15', '2026-09-15', '2026-09-16', 42)
  `;
  yield* sql`
    UPDATE effect_sql_migrations SET created_at = '2026-09-15 00:00:00' WHERE migration_id = 53
  `;
});

describe("V2 preview history", () => {
  it.effect.each([false, true])("blocks preview adoption without writing (%s divergent)", (divergent) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      if (divergent) {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (54, 'UnknownFork')`;
      }
      const ledger = sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      const previews = sql`SELECT * FROM orchestration_v2_legacy_imports`;
      const before = yield* ledger;
      const imports = yield* previews;
      yield* sql`PRAGMA query_only = ON`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* ledger, before);
      assert.deepStrictEqual(yield* previews, imports);
      assert.isNull(reconciledV2PreviewHistory([{ id: 53, name: "OrchestrationV2" }]));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
