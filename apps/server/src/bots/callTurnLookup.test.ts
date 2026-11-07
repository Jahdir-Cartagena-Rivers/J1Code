import { it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vite-plus/test";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeBotCallTurnLookup } from "./callTurnLookup.ts";

it.effect(
  "resolves only the exact submitted user's completed turn, never an unrelated response",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const lookup = yield* makeBotCallTurnLookup;
      yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES ('user', 'thread', NULL, 'user', 'hello', 0, '2026-01-01', '2026-01-01'),
      ('assistant', 'thread', 'turn', 'assistant', 'reply', 1, '2026-01-01', '2026-01-01')`;
      yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at, checkpoint_files_json)
      VALUES ('thread', 'turn', 'user', 'assistant', 'running', '2026-01-01', '[]')`;
      expect((yield* lookup("thread", "user"))?.text).toBeNull();
      expect(yield* lookup("other", "user")).toBeNull();
      expect(yield* lookup("thread", "other")).toBeNull();
      yield* sql`UPDATE projection_turns SET state = 'completed' WHERE thread_id = 'thread'`;
      expect((yield* lookup("thread", "user"))?.text).toBeNull();
      yield* sql`UPDATE projection_thread_messages SET is_streaming = 0 WHERE message_id = 'assistant'`;
      expect(yield* lookup("thread", "user")).toEqual({
        turnId: "turn",
        state: "completed",
        assistantMessageId: "assistant",
        text: "reply",
      });
      yield* sql`UPDATE projection_thread_messages SET turn_id = 'other' WHERE message_id = 'assistant'`;
      expect((yield* lookup("thread", "user"))?.text).toBeNull();
      yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
        VALUES ('thread', 'duplicate', 'user', 'running', '2026-01-01', '[]')`;
      expect(yield* lookup("thread", "user")).toBeNull();
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
