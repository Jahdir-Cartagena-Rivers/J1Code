import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE durable_routes (
    request_id TEXT PRIMARY KEY NOT NULL,
    fingerprint TEXT NOT NULL,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL,
    state_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX durable_routes_status ON durable_routes(status)`;
});
