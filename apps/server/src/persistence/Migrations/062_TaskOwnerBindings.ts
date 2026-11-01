import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE task_owner_bindings (
    binding_id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    provenance_json TEXT NOT NULL,
    revocation_json TEXT
  )`;
  yield* sql`CREATE INDEX task_owner_bindings_lookup
    ON task_owner_bindings(environment_id, project_id, task_id)`;
});
