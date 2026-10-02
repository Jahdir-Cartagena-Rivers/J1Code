import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
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
