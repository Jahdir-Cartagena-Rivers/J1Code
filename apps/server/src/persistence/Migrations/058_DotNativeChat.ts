import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE dot_chat_messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    connection_id TEXT NOT NULL REFERENCES dot_connections(id),
    request_id TEXT, reply_to TEXT, message_json TEXT NOT NULL,
    UNIQUE(connection_id, request_id), UNIQUE(connection_id, reply_to)
  )`;
  yield* sql`CREATE INDEX dot_chat_messages_page ON dot_chat_messages(connection_id, seq)`;
  yield* sql`CREATE TABLE dot_chat_subscriptions (
    id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES dot_connections(id),
    callback_url TEXT NOT NULL, expires_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE dot_chat_outbox (
    message_id TEXT NOT NULL REFERENCES dot_chat_messages(id),
    subscription_id TEXT NOT NULL REFERENCES dot_chat_subscriptions(id),
    state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(message_id, subscription_id)
  )`;
  yield* sql`CREATE TABLE dot_chat_revision (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL)`;
  yield* sql`INSERT INTO dot_chat_revision (id, revision) VALUES (1, 0)`;
});
