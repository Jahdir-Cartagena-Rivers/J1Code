import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Resolve a submitted message through the turn's persisted message ownership, not timestamps. */
export const makeBotCallTurnLookup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (threadId: string, userMessageId: string) =>
    sql<{
      readonly turn_id: string | null;
      readonly state: string;
      readonly assistant_message_id: string | null;
      readonly text: string | null;
      readonly is_streaming: number | null;
    }>`
      SELECT t.turn_id, t.state, t.assistant_message_id, a.text, a.is_streaming
      FROM projection_turns t
      INNER JOIN projection_thread_messages u ON u.thread_id = t.thread_id AND u.message_id = t.pending_message_id AND u.role = 'user'
      LEFT JOIN projection_thread_messages a ON a.thread_id = t.thread_id AND a.message_id = t.assistant_message_id AND a.role = 'assistant' AND a.turn_id = t.turn_id
      WHERE t.thread_id = ${threadId} AND t.pending_message_id = ${userMessageId}
      ORDER BY t.row_id DESC LIMIT 2
    `.pipe(
      Effect.map((rows) => {
        if (rows.length !== 1) return null;
        const row = rows[0]!;
        return {
          turnId: row.turn_id,
          state: row.state,
          assistantMessageId: row.assistant_message_id,
          text: row.state === "completed" && row.is_streaming === 0 ? row.text : null,
        };
      }),
    );
});
