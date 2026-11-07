import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const makeRoutineRuns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    /** Claims are persisted before admission; duplicate scheduler owners cannot launch the same occurrence. */
    claim: (botId: string, routineId: string, occurrence: number, now: string) =>
      sql<{ readonly bot_id: string }>`INSERT INTO bot_routine_runs
        (bot_id, routine_id, occurrence_ms, status, created_at, updated_at)
        VALUES (${botId}, ${routineId}, ${occurrence}, 'claimed', ${now}, ${now})
        ON CONFLICT(bot_id, routine_id, occurrence_ms) DO NOTHING RETURNING bot_id`.pipe(
        Effect.map((rows) => rows.length === 1),
      ),
    /** Release only before admission starts, so a transient settings failure can be retried. */
    release: (botId: string, routineId: string, occurrence: number) =>
      sql`DELETE FROM bot_routine_runs WHERE bot_id = ${botId} AND routine_id = ${routineId}
        AND occurrence_ms = ${occurrence} AND status = 'claimed'`,
    settle: (
      botId: string,
      routineId: string,
      occurrence: number,
      status: "admitted" | "failed" | "uncertain",
      now: string,
      detail: string | null,
    ) =>
      sql<{
        readonly bot_id: string;
      }>`UPDATE bot_routine_runs SET status = ${status}, updated_at = ${now}, detail = ${detail}
        WHERE bot_id = ${botId} AND routine_id = ${routineId} AND occurrence_ms = ${occurrence} AND status = 'claimed'
        RETURNING bot_id`.pipe(Effect.map((rows) => rows.length === 1)),
    listForBot: (botId: string) => sql<{
      readonly routine_id: string;
      readonly occurrence_ms: number;
      readonly status: "claimed" | "admitted" | "failed" | "uncertain";
      readonly created_at: string;
      readonly updated_at: string;
      readonly detail: string | null;
    }>`SELECT routine_id, occurrence_ms, status, created_at, updated_at, detail FROM bot_routine_runs
      WHERE bot_id = ${botId} ORDER BY occurrence_ms DESC LIMIT 200`,
    recover: (
      now: string,
    ) => sql`UPDATE bot_routine_runs SET status = 'uncertain', updated_at = ${now}
      WHERE status = 'claimed'`,
  };
});
