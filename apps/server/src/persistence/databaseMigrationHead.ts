// @effect-diagnostics nodeBuiltinImport:off - read synchronously by the preflight subprocess and at startup.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { latestMigrationId, skippedV2Migrations } from "./Migrations.ts";

export const BUILD_MIGRATION_HEAD = latestMigrationId;

/** Refuse an existing V2 path that aliases the original rollback file. */
export function v2DatabaseAliasStatus(databasePath: string): "distinct" | "alias" | "unknown" {
  const source = NodePath.join(NodePath.dirname(databasePath), "state.sqlite");
  try {
    const rollback = NodeFS.statSync(source, { bigint: true, throwIfNoEntry: false });
    const target = NodeFS.statSync(databasePath, { bigint: true, throwIfNoEntry: false });
    if (rollback === undefined || target === undefined) return "distinct";
    return rollback.dev === target.dev && rollback.ino === target.ino ? "alias" : "distinct";
  } catch {
    return "unknown";
  }
}

/** Migrations the database records, read-only. A missing or new database records none; one that
 * exists but cannot be read is null, since its history is unknown. */
export function recordedMigrations(
  databasePath: string,
): ReadonlyArray<{ readonly id: number; readonly name: string }> | null {
  const isV2 = NodePath.basename(databasePath).toLowerCase() === "statev2.sqlite";
  if (isV2 && v2DatabaseAliasStatus(databasePath) !== "distinct") return null;
  // Before the first cutover, inspect the ledger that initializeV2Database will copy.
  const inspectedPath = isV2 && !NodeFS.existsSync(databasePath)
    ? NodePath.join(NodePath.dirname(databasePath), "state.sqlite")
    : databasePath;
  let db: NodeSqlite.DatabaseSync;
  try {
    db = new NodeSqlite.DatabaseSync(inspectedPath, { readOnly: true });
  } catch {
    return NodeFS.existsSync(inspectedPath) ? null : [];
  }
  try {
    const hasTable = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'",
      )
      .get();
    if (hasTable === undefined) {
      return db.prepare(
        "SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1",
      ).get() === undefined ? [] : null;
    }
    const ledger = db
      .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")
      .all()
      .map((row) => ({ id: Number(row.migration_id), name: String(row.name) }));
    if (ledger.length === 0 && db.prepare(
      "SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'effect_sql_migrations' LIMIT 1",
    ).get() !== undefined) return null;
    return ledger;
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // A read-only handle has nothing to flush; the result above already stands.
    }
  }
}

/** Highest migration the database holds once this build's startup migrations have run. A newer
 * build may have recorded an incompatible history. Undefined for unreadable or divergent histories. */
export function databaseMigrationHead(databasePath: string): number | undefined {
  const recorded = recordedMigrations(databasePath);
  return recorded === null || skippedV2Migrations(recorded).length > 0
    ? undefined
    : Math.max(BUILD_MIGRATION_HEAD, ...recorded.map(({ id }) => id));
}
