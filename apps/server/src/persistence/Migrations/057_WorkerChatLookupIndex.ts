import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_worker_chat_lookup
    ON projection_thread_activities(thread_id, created_at, activity_id)
    WHERE kind = 'agent.delegation'
  `;
});
