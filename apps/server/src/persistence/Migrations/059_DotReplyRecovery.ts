import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE dot_chat_outbox ADD COLUMN reminder_count INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE dot_chat_outbox ADD COLUMN event_created_at INTEGER`;
  yield* sql`ALTER TABLE dot_chat_outbox ADD COLUMN reply_due_at INTEGER`;
});
