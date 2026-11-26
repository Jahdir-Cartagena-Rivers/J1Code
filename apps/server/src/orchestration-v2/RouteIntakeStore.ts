import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

export interface RouteIntakeOwner {
  readonly subject: string;
  readonly environmentId: string;
}

export const persistRouteIntake = (
  sql: SqlClient.SqlClient,
  sequence: number,
  evidence: RouteIntakeOwner & { readonly projectId: string },
) => sql`
  UPDATE orchestration_events
  SET metadata_json = json_set(metadata_json, '$.routeIntake', json(${JSON.stringify(evidence)}))
  WHERE sequence = ${sequence} AND aggregate_kind = 'thread' AND event_type = 'message.updated'
    AND json_type(metadata_json, '$.routeIntake') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM orchestration_events AS prior
      WHERE prior.aggregate_kind = 'thread' AND prior.stream_id = orchestration_events.stream_id
        AND prior.event_type = 'message.updated' AND prior.sequence < orchestration_events.sequence
        AND json_extract(prior.payload_json, '$.id') = json_extract(orchestration_events.payload_json, '$.id')
    )
`;

export const readRouteIntake = (
  sql: SqlClient.SqlClient,
  source: { readonly threadId: string; readonly messageId: string; readonly runId: string; readonly projectId: string },
) => sql<{ subject: string | null; environment: string | null }>`
  SELECT
    json_extract(first.metadata_json, '$.routeIntake.subject') AS subject,
    json_extract(first.metadata_json, '$.routeIntake.environmentId') AS environment
  FROM (
    SELECT metadata_json, payload_json
    FROM orchestration_events
    WHERE aggregate_kind = 'thread' AND stream_id = ${source.threadId} AND event_type = 'message.updated'
      AND json_extract(payload_json, '$.id') = ${source.messageId}
    ORDER BY sequence
    LIMIT 1
  ) AS first
  WHERE json_extract(first.payload_json, '$.role') = 'user'
    AND json_extract(first.payload_json, '$.runId') = ${source.runId}
    AND json_extract(first.metadata_json, '$.routeIntake.projectId') = ${source.projectId}
`.pipe(Effect.map(([row]) =>
  typeof row?.subject === "string" && row.subject.trim() &&
    typeof row.environment === "string" && row.environment.trim()
    ? { subject: row.subject, environmentId: row.environment }
    : undefined,
));
