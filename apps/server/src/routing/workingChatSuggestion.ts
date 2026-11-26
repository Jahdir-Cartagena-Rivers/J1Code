import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { RouteEndpoint } from "./routeState.ts";

const ignoredWords = new Set([
  "the",
  "and",
  "for",
  "this",
  "that",
  "with",
  "chat",
  "request",
  "changes",
  "project",
  "please",
  "code",
  "into",
  "from",
  "move",
]);
const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .match(/[a-z0-9]{3,}/g)
      ?.filter((word) => !ignoredWords.has(word)) ?? [],
  );
export function rankWorkingChats(
  request: string,
  candidates: readonly { thread_id: string; title: string; status: string | null }[],
) {
  const query = words(request);
  return (
    candidates
      .map((candidate) => {
        const overlap = [...words(candidate.title)].filter((word) => query.has(word)).length;
        const working = candidate.status === "running" || candidate.status === "starting";
        return { ...candidate, score: overlap * 10 + (working ? 5 : 0) };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.thread_id.localeCompare(b.thread_id))[0]?.thread_id ??
    null
  );
}

/** A proposal requiring approval, never ownership evidence or authority to auto-send. */
export const suggestWorkingChat = Effect.fnUntraced(function* (
  source: RouteEndpoint,
  request: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ thread_id: string; title: string; status: string | null }>`
    SELECT t.thread_id, t.title, (
      SELECT r.status FROM orchestration_v2_projection_runs r
      WHERE r.thread_id = t.thread_id AND r.status IN ('starting', 'running')
      ORDER BY r.ordinal DESC LIMIT 1
    ) AS status
    FROM orchestration_v2_projection_threads t
    WHERE t.project_id = ${source.projectId} AND t.thread_id <> ${source.threadId}
      AND t.archived_at IS NULL AND t.deleted_at IS NULL`;
  const threadId = rankWorkingChats(request, rows);
  return threadId ? { ...source, threadId } : null;
});
