// @effect-diagnostics nodeBuiltinImport:off - Explicit read-only CLI emits JSON, not application logs.
import * as NodeSqlite from "node:sqlite";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

export interface ActivityTiming {
  kind: string;
  createdAt: string;
  callId: string | null;
  itemType: string | null;
  tool: string | null;
  durationMs: number | null;
  status: string | null;
}

/** Tool lifetimes overlap and background commands may live throughout a run; never call the remainder inference time. */
export function summarizeActivity(rows: readonly ActivityTiming[]) {
  const completed = rows.filter((row) => row.kind === "tool.completed");
  const tools = new Map<string, { calls: number; failed: number; recordedMs: number }>();
  const intervals: [number, number][] = [];
  const starts = new Map<string, number>();
  for (const row of rows) {
    const at = Date.parse(row.createdAt);
    if (row.callId && row.kind === "tool.started") starts.set(row.callId, at);
    if (row.kind !== "tool.completed") continue;
    const name = row.tool ?? row.itemType ?? "unknown";
    const item = tools.get(name) ?? { calls: 0, failed: 0, recordedMs: 0 };
    item.calls++;
    if (row.status === "failed") item.failed++;
    item.recordedMs += row.durationMs ?? 0;
    tools.set(name, item);
    const start = row.callId ? starts.get(row.callId) : undefined;
    if (start !== undefined && Number.isFinite(at) && at >= start) intervals.push([start, at]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let unionMs = 0;
  let range: [number, number] | undefined;
  for (const interval of intervals) {
    if (!range) range = [...interval];
    else if (interval[0] <= range[1]) range[1] = Math.max(range[1], interval[1]);
    else {
      unionMs += range[1] - range[0];
      range = [...interval];
    }
  }
  if (range) unionMs += range[1] - range[0];
  let firstAt = Infinity;
  let lastAt = -Infinity;
  for (const row of rows) {
    const at = Date.parse(row.createdAt);
    if (Number.isFinite(at)) {
      firstAt = Math.min(firstAt, at);
      lastAt = Math.max(lastAt, at);
    }
  }
  return {
    activitySpanMs: firstAt === Infinity ? 0 : lastAt - firstAt,
    completedToolCalls: completed.length,
    observedToolLifetimeUnionMs: unionMs,
    tools: [...tools].map(([tool, values]) => ({ tool, ...values })),
    note: "Recorded tool durations overlap and include background process lifetimes. Activity span excludes time before the first and after the last event. Neither the union nor the remainder measures model inference or user waiting.",
  };
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const { values } = NodeUtil.parseArgs({
    options: { db: { type: "string" }, thread: { type: "string" }, turn: { type: "string" } },
  });
  if (!values.db || !values.thread)
    throw new Error(
      "Usage: node scripts/agent-run-report.ts --db <state.sqlite> --thread <id> [--turn <id>]",
    );
  const db = new NodeSqlite.DatabaseSync(NodePath.resolve(values.db), { readOnly: true });
  try {
    const current = db
      .prepare("SELECT latest_turn_id AS turn FROM projection_threads WHERE thread_id = ?")
      .get(values.thread);
    const turn = values.turn ?? current?.turn;
    if (typeof turn !== "string") throw new Error("Thread or turn not found.");
    // Select metadata in SQLite; never return prompts, commands, credentials or tool output.
    const rows = db
      .prepare(`SELECT kind, created_at AS createdAt,
      json_extract(payload_json, '$.toolCallId') AS callId,
      json_extract(payload_json, '$.itemType') AS itemType,
      json_extract(payload_json, '$.data.item.tool') AS tool,
      json_extract(payload_json, '$.data.item.durationMs') AS durationMs,
      json_extract(payload_json, '$.status') AS status
      FROM projection_thread_activities WHERE thread_id = ? AND turn_id = ? ORDER BY sequence`)
      .all(values.thread, turn);
    const timings = rows.map((row): ActivityTiming => ({
      kind: String(row.kind),
      createdAt: String(row.createdAt),
      callId: typeof row.callId === "string" ? row.callId : null,
      itemType: typeof row.itemType === "string" ? row.itemType : null,
      tool: typeof row.tool === "string" ? row.tool : null,
      durationMs: typeof row.durationMs === "number" ? row.durationMs : null,
      status: typeof row.status === "string" ? row.status : null,
    }));
    process.stdout.write(
      JSON.stringify(
        { threadId: values.thread, turnId: turn, ...summarizeActivity(timings) },
        null,
        2,
      ) + "\n",
    );
  } finally {
    db.close();
  }
}
