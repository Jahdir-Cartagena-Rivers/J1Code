import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE bot_routine_runs (
    bot_id TEXT NOT NULL,
    routine_id TEXT NOT NULL,
    occurrence_ms INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('claimed', 'admitted', 'failed', 'uncertain')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    detail TEXT,
    PRIMARY KEY(bot_id, routine_id, occurrence_ms)
  )`;
  yield* sql`CREATE INDEX bot_routine_runs_status ON bot_routine_runs(status)`;
});
