import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  BUILD_MIGRATION_HEAD,
  databaseMigrationHead,
} from "../persistence/databaseMigrationHead.ts";
import {
  canonicalUpstreamMigrationId,
  latestMigrationId,
  migrationManifest,
} from "../persistence/Migrations.ts";

import { runServicePreflight } from "./servicePreflight.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

// regression: #13239 a stale CLI shadowing the updated one kept "updating" to itself
it.each([1])("blocks legacy launcher protocol %i with exact recovery steps", (launcherProtocol) => {
  const result = runServicePreflight({
    databasePath: "/missing/state.sqlite",
    launcherProtocol,
    version: "9.8.7",
  });

  expect(result).toMatchObject({ status: "blocked", version: "9.8.7" });
  const reason = result.status === "blocked" ? result.reason : "";
  expect(reason).toMatch(new RegExp(`\\b${launcherProtocol}\\b`));
  expect(reason).toMatch(new RegExp(`\\b${SERVICE_LAUNCHER_PROTOCOL}\\b`));
  expect(reason).toContain("curl -fsSL https://t3.codes/install.sh | T3CODE_VERSION=9.8.7 sh");
  expect(reason).toContain("~/.local/bin/t3 service install");
  expect(reason).toContain("t3 --version");
  expect(reason).toContain("which -a t3");
});

// regression: #34502 every installed launcher was protocol 3, so protocol 4 blocked every remote update
it.each([3, SERVICE_LAUNCHER_PROTOCOL])(
  "is ready under launcher protocol %i and reports it back",
  (launcherProtocol) => {
    // A released server accepts a ready result only when it names that server's own protocol.
    expect(
      runServicePreflight({
        databasePath: "/missing/state.sqlite",
        launcherProtocol,
        version: "9.8.7",
      }),
    ).toEqual({ status: "ready", version: "9.8.7", launcherProtocol });
  },
);

it.layer(NodeServices.layer)("service preflight database", (it) => {
  it.effect("blocks a database that a newer build migrated", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const databasePath = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-preflight-" }),
        "state.sqlite",
      );
      const db = new NodeSqlite.DatabaseSync(databasePath);
      db.exec("CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT)");
      const insert = db.prepare("INSERT INTO effect_sql_migrations VALUES (?, ?)");
      for (const [id, name] of migrationManifest) insert.run(id, name);
      const preflight = () =>
        runServicePreflight({ databasePath, launcherProtocol: SERVICE_LAUNCHER_PROTOCOL });

      expect(preflight().status).toBe("ready");
      expect(BUILD_MIGRATION_HEAD).toBe(latestMigrationId);
      expect(BUILD_MIGRATION_HEAD).toBe(canonicalUpstreamMigrationId(96));
      expect(databaseMigrationHead(databasePath)).toBe(BUILD_MIGRATION_HEAD);

      // A released J1 ledger is a valid source before statev2.sqlite exists.
      db.prepare("DELETE FROM effect_sql_migrations WHERE migration_id > ?").run(64);
      const destination = path.join(path.dirname(databasePath), "statev2.sqlite");
      expect(runServicePreflight({
        databasePath: destination,
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      }).status).toBe("ready");
      expect(databaseMigrationHead(destination)).toBe(BUILD_MIGRATION_HEAD);
      expect(yield* fs.exists(destination)).toBe(false);
      for (const [id, name] of migrationManifest) {
        if (id > 64) insert.run(id, name);
      }

      db.prepare("UPDATE effect_sql_migrations SET name = ? WHERE migration_id = ?").run(
        "ForkMigration",
        BUILD_MIGRATION_HEAD,
      );
      const conflict = preflight();
      expect(conflict.status).toBe("blocked");
      expect(conflict.status === "blocked" ? conflict.reason : "").toContain("ForkMigration");
      db.prepare("UPDATE effect_sql_migrations SET name = ? WHERE migration_id = ?").run(
        migrationManifest.at(-1)![1],
        BUILD_MIGRATION_HEAD,
      );

      // The old preview adoption would collide with released J1 IDs.
      const preview = path.join(path.dirname(databasePath), "preview.sqlite");
      const previewDb = new NodeSqlite.DatabaseSync(preview);
      previewDb.exec(
        "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT)",
      );
      const insertPreview = previewDb.prepare("INSERT INTO effect_sql_migrations VALUES (?, ?)");
      for (const [id, name] of migrationManifest.filter(([id]) => id < 53)) {
        insertPreview.run(id, name);
      }
      insertPreview.run(53, "PullRequestFilesViewed");
      insertPreview.run(54, "OrchestrationV2");
      insertPreview.run(55, "RemoveRedundantProjectionIndexes");
      previewDb.close();
      const previewResult = runServicePreflight({
        databasePath: preview,
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      });
      expect(previewResult.status).toBe("blocked");
      expect(previewResult.status === "blocked" ? previewResult.reason : "").toContain("preview");
      expect(databaseMigrationHead(preview)).toBeUndefined();

      // A standalone upstream V2 ledger also collides even when its ID is below head.
      const upstream = path.join(path.dirname(databasePath), "upstream.sqlite");
      const upstreamDb = new NodeSqlite.DatabaseSync(upstream);
      upstreamDb.exec(
        "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT)",
      );
      const insertUpstream = upstreamDb.prepare("INSERT INTO effect_sql_migrations VALUES (?, ?)");
      for (const [id, name] of migrationManifest) {
        if (id <= 54) insertUpstream.run(id, name);
      }
      insertUpstream.run(55, "OrchestrationV2");
      upstreamDb.close();
      const upstreamResult = runServicePreflight({
        databasePath: upstream,
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      });
      expect(upstreamResult.status).toBe("blocked");
      expect(upstreamResult.status === "blocked" ? upstreamResult.reason : "").toContain(
        "55_DotConnections",
      );
      expect(databaseMigrationHead(upstream)).toBeUndefined();

      const newerId = BUILD_MIGRATION_HEAD + 1;
      insert.run(newerId, "FromNightly");
      db.close();
      const result = preflight();
      expect(result.status).toBe("blocked");
      expect(result.status === "blocked" ? result.reason : "").toContain(`${newerId}_FromNightly`);
      // A newer ledger cannot be described by this build's canonical head.
      expect(databaseMigrationHead(databasePath)).toBeUndefined();

      // A database that exists but cannot be read has an unknown history, so it blocks.
      const unreadable = path.join(path.dirname(databasePath), "unreadable.sqlite");
      yield* fs.writeFileString(unreadable, "not a database");
      expect(databaseMigrationHead(unreadable)).toBeUndefined();
      expect(
        runServicePreflight({
          databasePath: unreadable,
          launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
        }).status,
      ).toBe("blocked");
      // A missing database is a fresh install.
      expect(databaseMigrationHead(path.join(path.dirname(databasePath), "missing.sqlite"))).toBe(
        BUILD_MIGRATION_HEAD,
      );
    }),
  );
});
