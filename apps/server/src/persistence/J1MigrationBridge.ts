import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// J1 released these effects under IDs 55?64. Port their unchanged bodies to
// the current SQL service while retaining the original legacy migration files.

export const Migration0055 = Effect.gen(function* () {
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

export const Migration0056 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE dot_oauth_setup (id INTEGER PRIMARY KEY CHECK (id = 1), setup_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE dot_oauth_requests (request_hash TEXT PRIMARY KEY, request_json TEXT NOT NULL, expires_at INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE dot_oauth_codes (code_hash TEXT PRIMARY KEY, grant_json TEXT NOT NULL, expires_at INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE dot_oauth_tokens (
    token_hash TEXT PRIMARY KEY, family_id TEXT NOT NULL, kind TEXT NOT NULL,
    grant_json TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE INDEX dot_oauth_tokens_family ON dot_oauth_tokens(family_id)`;
});

export const Migration0057 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_worker_chat_lookup
    ON projection_thread_activities(thread_id, created_at, activity_id)
    WHERE kind = 'agent.delegation'
  `;
});

export const Migration0058 = Effect.gen(function* () {
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

export const Migration0059 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE dot_chat_outbox ADD COLUMN reminder_count INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE dot_chat_outbox ADD COLUMN event_created_at INTEGER`;
  yield* sql`ALTER TABLE dot_chat_outbox ADD COLUMN reply_due_at INTEGER`;
});

export const Migration0060 = Effect.gen(function* () {
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

export const Migration0061 = Effect.gen(function* () {
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

export const Migration0062 = Effect.gen(function* () {
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

export const Migration0063 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some((column) => column.name === "bot_identity_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN bot_identity_json TEXT`;
  }
});

export const Migration0064 = Effect.gen(function* () {
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
