import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE dot_connections (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      connection_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE dot_task_requests (
      connection_id TEXT NOT NULL REFERENCES dot_connections(id),
      project_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      PRIMARY KEY (connection_id, project_id, request_id)
    )
  `;
});
