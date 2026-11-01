import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE auto_model_admissions (
    thread_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    request_id TEXT NOT NULL,
    request_identity TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    PRIMARY KEY (thread_id, task_id, revision),
    UNIQUE (thread_id, request_id)
  )`;
});
