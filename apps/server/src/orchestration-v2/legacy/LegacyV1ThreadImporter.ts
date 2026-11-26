import {
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
} from "../../sourceControl/threadPullRequests.ts";
import {
  ChatAttachment,
  OrchestrationMessageContext,
  DEFAULT_MODEL,
  EventId,
  MessageId,
  ModelSelection,
  type OrchestrationV2AppThread,
  OrchestrationV2AppThreadJson,
  OrchestrationV2AppThreadLineage,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
  ProjectId,
  ProviderInstanceId,
  ThreadBotIdentity,
  ThreadId,
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
  TurnItemId,
} from "@j1code/contracts";
import * as KeyedLock from "@j1code/shared/KeyedLock";
import * as NodeSqliteClient from "@j1code/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../EventSink.ts";
import { randomUuidV4 } from "@j1code/provider-core/server/randomUuid";

const IMPORT_EVENT_PREFIX = "migration:v1";
const TRANSCRIPT_EVENT_BATCH_SIZE = 100;

type LegacyNativeDriver = "opencode" | "grok" | "cursor" | "claudeAgent" | "codex" | "antigravity";

const isLegacySessionUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

function readClaudeLegacyCursor(cursor: unknown, appThreadId: string) {
  if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return undefined;
  const row = cursor as Record<string, unknown>;
  // Claude V1 writes resume without schemaVersion; some installations used sessionId.
  if ((row.schemaVersion !== undefined && row.schemaVersion !== 1) ||
      (row.generation !== undefined && row.generation !== "v1")) return undefined;
  const nativeId = row.resume ?? row.sessionId;
  if (!isLegacySessionUuid(nativeId) ||
      [row.resume, row.sessionId].some((id) =>
        id !== undefined && (!isLegacySessionUuid(id) || id.toLowerCase() !== nativeId.toLowerCase())) ||
      (row.threadId !== undefined && row.threadId !== appThreadId &&
        (!isLegacySessionUuid(row.threadId) || row.threadId.toLowerCase() !== nativeId.toLowerCase())) ||
      (row.resumeSessionAt !== undefined && !isLegacySessionUuid(row.resumeSessionAt))) return undefined;
  return {
    nativeId: nativeId.toLowerCase(),
    ...(typeof row.resumeSessionAt === "string" ? { headId: row.resumeSessionAt.toLowerCase() } : {}),
  };
}

function legacyNativeId(cursor: unknown, driver: LegacyNativeDriver): string | undefined {
  if (driver === "codex") {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return undefined;
    const { threadId, schemaVersion, generation, sessionId } = cursor as Record<string, unknown>;
    if ((schemaVersion !== undefined && schemaVersion !== 1) ||
        (generation !== undefined && generation !== "v1") || !isLegacySessionUuid(threadId) ||
        (sessionId !== undefined &&
          (!isLegacySessionUuid(sessionId) || sessionId.toLowerCase() !== threadId.toLowerCase()))) return undefined;
    return threadId.toLowerCase();
  }
  if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor) ||
      !("schemaVersion" in cursor) || cursor.schemaVersion !== 1 ||
      !("sessionId" in cursor) || typeof cursor.sessionId !== "string" ||
      !(driver === "opencode" ? /^ses_[A-Za-z0-9_-]+$/ : /^[A-Za-z0-9_-]{1,256}$/).test(cursor.sessionId) ||
      ("generation" in cursor && cursor.generation !== "v1")) return undefined;
  return cursor.sessionId;
}

export function isImportedV1TranscriptHandoff(handoff: OrchestrationV2ContextHandoff): boolean {
  if (handoff.strategy !== "manual_context" || handoff.transferId != null ||
      handoff.fromProviderThreadIds.length !== 0 || handoff.history === undefined) return false;
  const ids = [
    ...handoff.history.messages.map(({ itemId }) => itemId),
    ...(handoff.history.omittedItemIds ?? []),
  ];
  return ids.length > 0 && ids.every((id) => id.startsWith(`${IMPORT_EVENT_PREFIX}:turn-item:`));
}

interface LegacyThreadRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly model_selection_json: string | null;
  readonly bot_identity_json: string | null;
  readonly runtime_mode: string;
  readonly interaction_mode: string;
  readonly branch: string | null;
  readonly worktree_path: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
  readonly settled_override: string | null;
  readonly settled_at: string | null;
  readonly unsettled_at: string | null;
  readonly snoozed_until: string | null;
  readonly snoozed_at: string | null;
  readonly pinned_at: string | null;
  readonly auto_settle_disabled_at: string | null;
  readonly pin_order_key: string | null;
  readonly pull_requests_json: string;
  readonly linked_pull_request_json: string | null;
  readonly branch_pull_request_json: string | null;
  readonly active_order_key: string | null;
  readonly deleted_at: string | null;
}

interface LegacyRepairRow extends LegacyThreadRow {
  readonly payload_json: string;
}

interface LegacyMessageRow {
  readonly message_id: string;
  readonly thread_id: string;
  readonly role: "user" | "assistant" | "reasoning";
  readonly text: string;
  readonly attachments_json: string | null;
  readonly context_json?: string | null;
  readonly is_streaming: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly ordinal: number;
}

interface LegacyImportRow {
  readonly thread_id: string;
  readonly transcript_imported_at: string | null;
}

export interface LegacyV1ImportSummary {
  readonly importedThreadCount: number;
  readonly importedMessageCount: number;
}

export class LegacyV1ThreadImportError extends Schema.TaggedError<LegacyV1ThreadImportError>()(
  "LegacyV1ThreadImportError",
  {
    operation: Schema.String,
    threadId: Schema.optional(ThreadId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.threadId === undefined
      ? `Failed to ${this.operation} legacy v1 threads.`
      : `Failed to ${this.operation} legacy v1 thread ${this.threadId}.`;
  }
}

export interface LegacyV1ThreadImporterShape {
  readonly pendingThreadCount: Effect.Effect<number, LegacyV1ThreadImportError>;
  readonly reconcileShells: Effect.Effect<LegacyV1ImportSummary, LegacyV1ThreadImportError>;
  readonly ensureTranscript: (
    threadId: ThreadId,
  ) => Effect.Effect<LegacyV1ImportSummary, LegacyV1ThreadImportError>;
  readonly importPendingTranscripts: Effect.Effect<LegacyV1ImportSummary, never>;
  readonly readOpenCodeHistory?: (
    threadId: ThreadId,
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<string | undefined, LegacyV1ThreadImportError>;
  readonly readGrokHistory?: LegacyV1ThreadImporterShape["readOpenCodeHistory"];
  readonly readCodexHistory?: LegacyV1ThreadImporterShape["readCursorHistory"];
  readonly readAntigravityHistory?: LegacyV1ThreadImporterShape["readCursorHistory"];
  readonly readClaudeHistory?: (
    threadId: ThreadId,
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<{
    readonly nativeId: string;
    readonly storeCwd: string;
    readonly headId?: string;
  } | undefined, LegacyV1ThreadImportError>;
  readonly readCursorHistory?: (
    threadId: ThreadId,
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<{ readonly nativeId: string; readonly storeCwd: string } | undefined, LegacyV1ThreadImportError>;
}

export class LegacyV1ThreadImporter extends Context.Service<
  LegacyV1ThreadImporter,
  LegacyV1ThreadImporterShape
>()("@j1code/server/orchestration-v2/legacy/LegacyV1ThreadImporter") {}

const isLegacyV1ThreadImportError = Schema.is(LegacyV1ThreadImportError);
const decodeBotIdentity = Schema.decodeUnknownOption(ThreadBotIdentity);
const decodeLineage = Schema.decodeUnknownOption(OrchestrationV2AppThreadLineage);
const decodeModelSelection = Schema.decodeUnknownOption(ModelSelection);
const decodeAttachments = Schema.decodeUnknownOption(Schema.Array(ChatAttachment));
const decodePullRequests = Schema.decodeUnknownOption(Schema.Array(ThreadPullRequestLink));
const decodeLinkedPullRequest = Schema.decodeUnknownOption(ThreadLinkedPullRequest);
const decodeStoredThread = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeMessageContext = Schema.decodeUnknownOption(OrchestrationMessageContext);
// Compare the in-memory representation without rebuilding the object or changing key order.
const encodeMetadataComparison = Schema.encodeEffect(
  Schema.fromJsonString(Schema.declare(Schema.is(Schema.toType(OrchestrationV2AppThreadJson)))),
);

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function modelSelectionFor(row: LegacyThreadRow) {
  const decoded =
    row.model_selection_json === null
      ? Option.none()
      : decodeModelSelection(parseJson(row.model_selection_json));
  return Option.getOrElse(decoded, () => ({
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  }));
}

function attachmentsFor(row: LegacyMessageRow) {
  if (row.attachments_json === null) return [];
  return Option.getOrElse(decodeAttachments(parseJson(row.attachments_json)), () => []);
}

function contextFor(row: LegacyMessageRow) {
  if (!row.context_json) return undefined;
  return Option.getOrUndefined(decodeMessageContext(parseJson(row.context_json)));
}

function linkedPullRequestFor(row: LegacyThreadRow) {
  if (row.linked_pull_request_json === null) return null;
  return Option.getOrNull(decodeLinkedPullRequest(parseJson(row.linked_pull_request_json)));
}

function branchPullRequestFor(row: LegacyThreadRow) {
  if (row.branch_pull_request_json === null) return null;
  return Option.getOrNull(decodeLinkedPullRequest(parseJson(row.branch_pull_request_json)));
}

function runtimeModeFor(value: string): OrchestrationV2AppThread["runtimeMode"] {
  return value === "approval-required" ||
    value === "auto-accept-edits" ||
    value === "auto" ||
    value === "full-access"
    ? value
    : "full-access";
}

function interactionModeFor(value: string): OrchestrationV2AppThread["interactionMode"] {
  return value === "plan" ? "plan" : "default";
}

function settledOverrideFor(value: string | null): OrchestrationV2AppThread["settledOverride"] {
  return value === "settled" || value === "active" ? value : null;
}

// V1 rows can hold unparseable timestamps; fall back to another time rather than fail the import.
function dateTimeOr(value: string | null, fallback: DateTime.Utc): DateTime.Utc {
  return value === null ? fallback : Option.getOrElse(DateTime.make(value), () => fallback);
}

// A malformed marker stays set so archived or deleted threads keep that state.
function nullableDateTime(value: string | null, fallback: DateTime.Utc): DateTime.Utc | null {
  return value === null ? null : dateTimeOr(value, fallback);
}

function readLegacyBotIdentity(
  row: LegacyThreadRow,
): Effect.Effect<OrchestrationV2AppThread["bot"], LegacyV1ThreadImportError> {
  if (row.bot_identity_json === null) return Effect.undefined;
  const identity = decodeBotIdentity(parseJson(row.bot_identity_json));
  if (Option.isSome(identity)) return Effect.succeed(identity.value);
  // Decoder failures can contain the saved identity or instructions.
  return Effect.fail(new LegacyV1ThreadImportError({
    operation: "validate saved bot identity for",
    threadId: ThreadId.make(row.thread_id),
  }));
}

function importedThread(
  row: LegacyThreadRow,
  importedAt: DateTime.Utc,
  bot: OrchestrationV2AppThread["bot"],
): OrchestrationV2AppThread {
  const createdAt = dateTimeOr(row.created_at, dateTimeOr(row.updated_at, importedAt));
  const updatedAt = dateTimeOr(row.updated_at, createdAt);
  const threadId = ThreadId.make(row.thread_id);
  const modelSelection = modelSelectionFor(row);
  const branch = row.branch?.trim() || null;
  const worktreePath = row.worktree_path?.trim() || null;
  const pullRequests = Option.getOrElse(
    decodePullRequests(parseJson(row.pull_requests_json)),
    () => [],
  );
  const linkedPullRequest = linkedPullRequestFor(row);
  const legacyLink = threadPullRequestsOf({ linkedPullRequest })[0];
  const importedPullRequests =
    legacyLink !== undefined &&
    !pullRequests.some((link) => threadPullRequestKeysEqual(link, legacyLink))
      ? [...pullRequests, legacyLink]
      : pullRequests;
  return {
    createdBy: "system",
    creationSource: "server",
    id: threadId,
    projectId: ProjectId.make(row.project_id),
    title: row.title.trim() === "" ? "Untitled thread" : row.title,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    runtimeMode: runtimeModeFor(row.runtime_mode),
    interactionMode: interactionModeFor(row.interaction_mode),
    branch,
    worktreePath,
    linkedPullRequest,
    pullRequests: importedPullRequests,
    branchPullRequest: branchPullRequestFor(row),
    activeOrderKey: row.active_order_key?.trim() || null,
    activeProviderThreadId: null,
    historyOrigin: "v1_import",
    ...(bot === undefined ? {} : { bot }),
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt,
    updatedAt,
    archivedAt: nullableDateTime(row.archived_at, updatedAt),
    settledOverride: settledOverrideFor(row.settled_override),
    settledAt: nullableDateTime(row.settled_at, updatedAt),
    unsettledAt: nullableDateTime(row.unsettled_at, updatedAt),
    snoozedUntil: nullableDateTime(row.snoozed_until, updatedAt),
    snoozedAt: nullableDateTime(row.snoozed_at, updatedAt),
    pinnedAt: nullableDateTime(row.pinned_at, updatedAt),
    autoSettleDisabledAt: nullableDateTime(row.auto_settle_disabled_at, updatedAt),
    pinOrderKey: row.pin_order_key?.trim() || null,
    lastVisitedAt: null,
    deletedAt: nullableDateTime(row.deleted_at, updatedAt),
  };
}

function messageEvents(
  row: LegacyMessageRow,
  importedAt: DateTime.Utc,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const threadId = ThreadId.make(row.thread_id);
  const messageId = MessageId.make(row.message_id);
  const createdAt = dateTimeOr(row.created_at, dateTimeOr(row.updated_at, importedAt));
  const updatedAt = dateTimeOr(row.updated_at, createdAt);
  const baseTurnItem = {
    id: TurnItemId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${row.message_id}`),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: row.ordinal,
    status: row.is_streaming === 1 ? ("interrupted" as const) : ("completed" as const),
    title: null,
    startedAt: createdAt,
    completedAt: updatedAt,
    updatedAt,
  };
  if (row.role === "reasoning") {
    return [
      {
        id: EventId.make(baseTurnItem.id),
        type: "turn-item.updated",
        threadId,
        occurredAt: updatedAt,
        payload: {
          ...baseTurnItem,
          type: "reasoning",
          text: row.text,
          streaming: false,
        },
      },
    ];
  }

  const attachments = attachmentsFor(row);
  const context = contextFor(row);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: row.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId,
    runId: null,
    nodeId: null,
    role: row.role,
    text: row.text,
    ...(context !== undefined ? { context } : {}),
    attachments,
    streaming: false,
    createdAt,
    updatedAt,
  };
  const turnItem: OrchestrationV2TurnItem =
    row.role === "user"
      ? {
          ...baseTurnItem,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: row.text,
          ...(context !== undefined ? { context } : {}),
          attachments,
        }
      : {
          ...baseTurnItem,
          type: "assistant_message",
          messageId,
          text: row.text,
          ...(context !== undefined ? { context } : {}),
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${row.message_id}`),
      type: "message.updated",
      threadId,
      occurredAt: updatedAt,
      payload: message,
    },
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${row.message_id}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: updatedAt,
      payload: turnItem,
    },
  ];
}

interface LegacyTurnItemPosition {
  readonly turn_item_id: string;
  readonly ordinal: number;
  readonly payload_json: string | null;
}

function planLegacyTurnPositions(
  ordered: ReadonlyArray<{ readonly id: string; readonly ordinal: number }>,
  positions: ReadonlyArray<LegacyTurnItemPosition>,
) {
  const occupied = new Map(positions.map((row) => [row.ordinal, row.turn_item_id]));
  const current = new Map(positions.map((row) => [row.turn_item_id, row.ordinal]));
  const legacy = new Set(ordered.map((item) => item.id));
  let target = 0;
  const pending = new Map<string, number>();
  for (const item of ordered) {
    target = Math.max(target + 1, item.ordinal);
    while (occupied.has(target) && !legacy.has(occupied.get(target)!)) target += 1;
    if (current.get(item.id) !== target) pending.set(item.id, target);
  }
  // Shift the usual right-moving suffix from the end so each move frees the preceding slot.
  const moves = new Map(Array.from(pending).reverse());
  let temporary = positions.reduce((max, row) => Math.max(max, row.ordinal), target) + 1;
  const steps: Array<{ readonly id: string; readonly ordinal: number }> = [];
  const move = (id: string, ordinal: number) => {
    const previous = current.get(id);
    if (previous !== undefined) occupied.delete(previous);
    current.set(id, ordinal);
    occupied.set(ordinal, id);
    steps.push({ id, ordinal });
  };
  // Every emitted move must also be valid when replayed against the unique position index.
  while (moves.size > 0) {
    let progressed = false;
    for (const [id, ordinal] of moves) {
      if (occupied.has(ordinal)) continue;
      move(id, ordinal);
      moves.delete(id);
      progressed = true;
    }
    if (!progressed) {
      const id = moves.keys().next().value!;
      move(id, temporary++);
    }
  }
  return steps;
}

const decodeLegacyTurnItem = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJson),
);

function chunks<A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> {
  const result: Array<ReadonlyArray<A>> = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventSink = yield* EventSink.EventSinkV2;
  const transcriptImports = yield* KeyedLock.make<ThreadId>();

  const readNativeHistory = Effect.fn("LegacyV1ThreadImporter.readNativeHistory")(function* (
    threadId: ThreadId,
    instanceId: ProviderInstanceId,
    driver: LegacyNativeDriver,
  ) {
    const invalid = () => new LegacyV1ThreadImportError({
      operation: `verify the saved ${driver} session for`,
      threadId,
    });
    // A partial identity match needs verification before startup can fall back to a new session.
    const rows = yield* sql<{
      readonly thread_id: string;
      readonly provider_name: string;
      readonly provider_instance_id: string | null;
      readonly adapter_key: string;
      readonly resume_cursor_json: string;
      readonly runtime_payload_json: string | null;
    }>`
      SELECT runtime.thread_id, runtime.provider_name, runtime.provider_instance_id, runtime.adapter_key,
        runtime.resume_cursor_json, runtime.runtime_payload_json
      FROM provider_session_runtime AS runtime
      JOIN orchestration_v2_legacy_imports AS imported USING (thread_id)
      WHERE runtime.thread_id = ${threadId}
        AND (
          runtime.provider_name = ${driver}
          OR runtime.adapter_key = ${driver}
          OR runtime.provider_instance_id = ${instanceId}
        )
        AND runtime.resume_cursor_json IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_provider_threads AS existing
          WHERE existing.thread_id = runtime.thread_id
            AND json_type(existing.payload_json, '$.nativeThreadRef.nativeId') = 'text'
        )
    `;
    const row = rows[0];
    if (row === undefined) return undefined;
    if (rows.length !== 1 || row.thread_id !== threadId || row.provider_instance_id !== instanceId ||
        row.provider_name !== driver || row.adapter_key !== driver) return yield* invalid();
    const decoded = parseJson(row.resume_cursor_json);
    const claudeHistory = driver === "claudeAgent" ? readClaudeLegacyCursor(decoded, threadId) : undefined;
    const nativeId = driver === "claudeAgent" ? claudeHistory?.nativeId : legacyNativeId(decoded, driver);
    if (nativeId === undefined ||
        (driver === "antigravity" && typeof decoded === "object" && decoded !== null &&
          "threadId" in decoded && decoded.threadId !== threadId)) return yield* invalid();
    const otherOwners = yield* sql<{ readonly thread_id: string | null }>`
      SELECT thread_id FROM provider_session_runtime
      WHERE thread_id <> ${threadId} AND provider_name = ${driver}
        AND (${driver} IN ('claudeAgent', 'codex') OR provider_instance_id = ${instanceId})
        AND CASE WHEN json_valid(resume_cursor_json)
          THEN CASE WHEN ${driver} = 'claudeAgent' THEN
            lower(json_extract(resume_cursor_json, '$.resume')) = ${nativeId} OR
            lower(json_extract(resume_cursor_json, '$.sessionId')) = ${nativeId} OR
            lower(json_extract(resume_cursor_json, '$.threadId')) = ${nativeId}
          WHEN ${driver} = 'codex' THEN
            lower(json_extract(resume_cursor_json, '$.threadId')) = ${nativeId} OR
            lower(json_extract(resume_cursor_json, '$.sessionId')) = ${nativeId}
          WHEN ${driver} = 'antigravity' THEN
            lower(json_extract(resume_cursor_json, '$.sessionId')) = lower(${nativeId})
          ELSE json_extract(resume_cursor_json, '$.sessionId') = ${nativeId} END
        END
      UNION ALL
      SELECT thread_id FROM orchestration_v2_projection_provider_threads
      WHERE (thread_id IS NULL OR thread_id <> ${threadId}) AND provider = ${driver}
        AND (${driver} IN ('claudeAgent', 'codex') OR json_extract(payload_json, '$.providerInstanceId') = ${instanceId})
        AND CASE WHEN ${driver} IN ('claudeAgent', 'codex')
          THEN lower(json_extract(payload_json, '$.nativeThreadRef.nativeId')) = ${nativeId}
          WHEN ${driver} = 'antigravity' THEN
            lower(json_extract(payload_json, '$.nativeThreadRef.nativeId')) = lower(${nativeId})
          ELSE json_extract(payload_json, '$.nativeThreadRef.nativeId') = ${nativeId} END
      LIMIT 1
    `;
    if (otherOwners.length !== 0) return yield* invalid();
    if (driver !== "cursor" && driver !== "claudeAgent" && driver !== "codex" && driver !== "antigravity")
      return { nativeId, storeCwd: null };
    const payload: unknown = row.runtime_payload_json === null ? undefined : parseJson(row.runtime_payload_json);
    const cwd = typeof payload === "object" && payload !== null && "cwd" in payload ? payload.cwd : undefined;
    if (typeof cwd !== "string" || cwd.trim() !== cwd || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(cwd))
      return yield* invalid();
    return { ...claudeHistory, nativeId, storeCwd: cwd };
  }, (effect, threadId, _instanceId, driver) => effect.pipe(
    Effect.mapError((cause) => isLegacyV1ThreadImportError(cause)
      ? cause
      : new LegacyV1ThreadImportError({ operation: `read ${driver} history for`, threadId, cause })),
  ));

  const listMessages = (threadId: ThreadId) =>
    sql<LegacyMessageRow>`
      SELECT
        message_id,
        thread_id,
        role,
        text,
        attachments_json,
        context_json,
        is_streaming,
        created_at,
        updated_at,
        ROW_NUMBER() OVER (
          PARTITION BY thread_id
          ORDER BY created_at ASC, message_id ASC
        ) AS ordinal
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND role IN ('user', 'assistant', 'reasoning')
      ORDER BY created_at ASC, message_id ASC
    `.pipe(NodeSqliteClient.readOnly);

  const listShellMessages = Effect.fn("LegacyV1ThreadImporter.listShellMessages")(function* (
    threadId: ThreadId,
  ) {
    const latest = yield* sql<LegacyMessageRow>`
        SELECT
          message.message_id,
          message.thread_id,
          message.role,
          message.text,
          message.attachments_json,
          message.context_json,
          message.is_streaming,
          message.created_at,
          message.updated_at,
          (
            SELECT COUNT(*)
            FROM projection_thread_messages AS earlier
            WHERE earlier.thread_id = message.thread_id
              AND earlier.role IN ('user', 'assistant', 'reasoning')
              AND (
                earlier.created_at < message.created_at
                OR (
                  earlier.created_at = message.created_at
                  AND earlier.message_id <= message.message_id
                )
              )
          ) AS ordinal
        FROM projection_thread_messages AS message
        WHERE message.thread_id = ${threadId}
          AND message.role IN ('user', 'assistant')
        ORDER BY message.created_at DESC, message.message_id DESC
        LIMIT 1
      `.pipe(NodeSqliteClient.readOnly);
    const latestUser = yield* sql<LegacyMessageRow>`
        SELECT
          message.message_id,
          message.thread_id,
          message.role,
          message.text,
          message.attachments_json,
          message.context_json,
          message.is_streaming,
          message.created_at,
          message.updated_at,
          (
            SELECT COUNT(*)
            FROM projection_thread_messages AS earlier
            WHERE earlier.thread_id = message.thread_id
              AND earlier.role IN ('user', 'assistant', 'reasoning')
              AND (
                earlier.created_at < message.created_at
                OR (
                  earlier.created_at = message.created_at
                  AND earlier.message_id <= message.message_id
                )
              )
          ) AS ordinal
        FROM projection_thread_messages AS message
        WHERE message.thread_id = ${threadId}
          AND message.role = 'user'
        ORDER BY message.created_at DESC, message.message_id DESC
        LIMIT 1
      `.pipe(NodeSqliteClient.readOnly);
    return [latestUser[0], latest[0]].filter(
      (message, index, selected): message is LegacyMessageRow =>
        message !== undefined &&
        selected.findIndex((candidate) => candidate?.message_id === message.message_id) === index,
    );
  });

  // All imported shells must exist before linking them. Buffer family updates until commit.
  // Use the thread's event stream for parent lookup. The version index otherwise
  // scans all legacy events for every imported root during startup.
  const reconcileWorkerLineage = (changed: Set<ThreadId>, now: DateTime.Utc) =>
    eventSink.withProviderBatch(Effect.gen(function* () {
      const rows = yield* sql<{
        readonly thread_id: string;
        readonly project_id: string;
        readonly deleted_at: string | null;
        readonly lineage_json: string | null;
        readonly saved_parent_id: string | null;
      }>`
        SELECT projection.thread_id, projection.project_id, projection.deleted_at,
          CASE WHEN json_valid(projection.payload_json)
            THEN json_extract(projection.payload_json, '$.lineage') END AS lineage_json,
          CASE WHEN imported.thread_id IS NOT NULL
            AND source.project_id = projection.project_id AND source.deleted_at IS NULL
            AND projection.deleted_at IS NULL
            AND CASE WHEN json_valid(projection.payload_json) THEN
              json_extract(projection.payload_json, '$.historyOrigin') = 'v1_import'
              AND json_extract(projection.payload_json, '$.lineage.rootThreadId') = projection.thread_id
              AND json_type(projection.payload_json, '$.lineage.parentThreadId') = 'null'
              AND json_type(projection.payload_json, '$.lineage.relationshipToParent') = 'null'
              AND json_extract(projection.payload_json, '$.lineage.sideChat') IS NOT 1
            ELSE 0 END
          THEN (
            SELECT CASE WHEN COUNT(DISTINCT json_extract(event.payload_json,
              '$.activity.payload.parentThreadId')) = 1
              THEN MIN(json_extract(event.payload_json, '$.activity.payload.parentThreadId')) END
            FROM orchestration_events event INDEXED BY idx_orch_events_stream_sequence
            WHERE event.stream_id = projection.thread_id AND event.aggregate_kind = 'thread'
              AND event.application_event_version = 1 AND event.event_type = 'thread.activity-appended'
              AND CASE WHEN json_valid(event.payload_json) THEN
                json_type(event.payload_json, '$.threadId') = 'text'
                AND json_extract(event.payload_json, '$.threadId') = projection.thread_id
                AND json_extract(event.payload_json, '$.activity.kind') = 'agent.delegation'
                AND json_type(event.payload_json, '$.activity.payload.version') = 'integer'
                AND json_extract(event.payload_json, '$.activity.payload.version') = 1
                AND json_type(event.payload_json, '$.activity.payload.threadId') = 'text'
                AND json_extract(event.payload_json, '$.activity.payload.threadId') = projection.thread_id
                AND json_type(event.payload_json, '$.activity.payload.parentThreadId') = 'text'
                AND length(trim(json_extract(event.payload_json, '$.activity.payload.parentThreadId'))) > 0
                AND trim(json_extract(event.payload_json, '$.activity.payload.parentThreadId')) =
                  json_extract(event.payload_json, '$.activity.payload.parentThreadId')
                AND json_extract(event.payload_json, '$.activity.payload.parentThreadId') <> projection.thread_id
                AND EXISTS (
                  SELECT 1 FROM projection_threads parent
                  WHERE parent.thread_id = json_extract(event.payload_json, '$.activity.payload.parentThreadId')
                    AND parent.project_id = source.project_id AND parent.deleted_at IS NULL
                )
              ELSE 0 END
          ) END AS saved_parent_id
        FROM orchestration_v2_projection_threads projection
        LEFT JOIN orchestration_v2_legacy_imports imported ON imported.thread_id = projection.thread_id
        LEFT JOIN projection_threads source ON source.thread_id = imported.thread_id
        WHERE EXISTS (SELECT 1 FROM orchestration_v2_legacy_imports)
      `;
      const nodes = new Map(rows.map((row) => [
        row.thread_id,
        {
          ...row,
          lineage: row.lineage_json === null
            ? undefined
            : Option.getOrUndefined(decodeLineage(parseJson(row.lineage_json))),
        },
      ] as const));
      const roots = new Map<string, string | null>();
      const resolveRoot = (startId: string, projectId: string) => {
        const visited = new Set<string>();
        const path: Array<{ id: string; savedRoot: string | null }> = [];
        let id = startId;
        let root: string | null;
        while (true) {
          const node = nodes.get(id);
          if (node?.lineage === undefined || node.deleted_at !== null ||
              node.project_id !== projectId || visited.has(id)) {
            root = null;
            break;
          }
          const cached = roots.get(id);
          if (cached !== undefined) {
            root = cached;
            break;
          }
          visited.add(id);
          const parentId = node.saved_parent_id ?? node.lineage.parentThreadId;
          path.push({ id, savedRoot: node.saved_parent_id === null ? node.lineage.rootThreadId : null });
          if (parentId === null) {
            root = id;
            break;
          }
          id = parentId;
        }
        for (const entry of path.reverse()) {
          if (entry.savedRoot !== null && entry.savedRoot !== root) root = null;
          roots.set(entry.id, root);
        }
        return root;
      };
      for (const node of nodes.values()) {
        if (node.saved_parent_id === null || node.lineage === undefined) continue;
        const root = resolveRoot(node.thread_id, node.project_id);
        if (root === null) continue;
        const [row] = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${node.thread_id}
        `;
        if (row === undefined) continue;
        const stored = decodeStoredThread(row.payload_json);
        if (Option.isNone(stored)) continue;
        const thread = stored.value;
        const lineage: OrchestrationV2AppThread["lineage"] = {
          parentThreadId: ThreadId.make(node.saved_parent_id),
          relationshipToParent: "subagent",
          rootThreadId: ThreadId.make(root),
        };
        const repairId = yield* randomUuidV4;
        yield* eventSink.write({
          events: [{
            id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${thread.id}:worker-lineage:${repairId}`),
            type: "thread.metadata-updated",
            threadId: thread.id,
            providerInstanceId: thread.providerInstanceId,
            occurredAt: now,
            payload: { ...thread, lineage },
          }],
        });
        changed.add(thread.id);
      }
    }));

  const reconcileShellsBase = Effect.gen(function* () {
    const now = yield* DateTime.now;
    // Upstream-only databases never had the J1 column.
    const columns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('projection_threads')
    `.pipe(NodeSqliteClient.readOnly);
    const legacyBotIdentity = sql.literal(
      columns.some(({ name }) => name === "bot_identity_json")
        ? "thread.bot_identity_json"
        : "NULL",
    );
    const repairRows = yield* sql<LegacyRepairRow>`
      SELECT
        thread.thread_id,
        thread.project_id,
        thread.title,
        thread.model_selection_json,
        ${legacyBotIdentity} AS bot_identity_json,
        thread.runtime_mode,
        thread.interaction_mode,
        thread.branch,
        thread.worktree_path,
        thread.created_at,
        thread.updated_at,
        thread.archived_at,
        thread.settled_override,
        thread.settled_at,
        thread.unsettled_at,
        thread.snoozed_until,
        thread.snoozed_at,
        thread.pinned_at,
        thread.auto_settle_disabled_at,
        thread.pin_order_key,
        (SELECT json_group_array(json_object('host', pr.host, 'repository', pr.repository, 'number', pr.number, 'url', pr.url, 'source', pr.source, 'linkedAt', pr.linked_at, 'snapshot', json(pr.snapshot_json), 'stack', json(pr.stack_json))) FROM projection_thread_pull_requests pr WHERE pr.thread_id = thread.thread_id) AS pull_requests_json,
        thread.linked_pull_request_json,
        thread.branch_pull_request_json,
        thread.active_order_key,
        thread.deleted_at,
        projection.payload_json
      FROM orchestration_v2_legacy_imports AS legacy_import
      INNER JOIN projection_threads AS thread
        ON thread.thread_id = legacy_import.thread_id
      INNER JOIN orchestration_v2_projection_threads AS projection
        ON projection.thread_id = legacy_import.thread_id
      WHERE json_type(projection.payload_json, '$.pinnedAt') IS NULL
         OR json_type(projection.payload_json, '$.pinOrderKey') IS NULL
         OR json_type(projection.payload_json, '$.snoozedUntil') IS NULL
         OR json_type(projection.payload_json, '$.snoozedAt') IS NULL
         OR json_type(projection.payload_json, '$.unsettledAt') IS NULL
         OR json_type(projection.payload_json, '$.linkedPullRequest') IS NULL
         OR json_type(projection.payload_json, '$.pullRequests') IS NULL
         OR json_type(projection.payload_json, '$.branchPullRequest') IS NULL
         OR json_type(projection.payload_json, '$.activeOrderKey') IS NULL
         OR (
           json_type(projection.payload_json, '$.bot') IS NULL
           AND ${legacyBotIdentity} IS NOT NULL
         )
      ORDER BY thread.created_at ASC, thread.thread_id ASC
    `.pipe(NodeSqliteClient.readOnly);
    const changedThreadIds = new Set<ThreadId>();
    for (const row of repairRows) {
      const decoded = decodeStoredThread(row.payload_json);
      if (Option.isNone(decoded)) continue;
      const current = decoded.value;
      const legacy = importedThread(row, now, current.bot ?? (yield* readLegacyBotIdentity(row)));
      const legacyPullRequests = legacy.pullRequests ?? [];
      const repaired: OrchestrationV2AppThread = {
        ...current,
        ...(current.bot === undefined && legacy.bot !== undefined ? { bot: legacy.bot } : {}),
        pinnedAt: current.pinnedAt === undefined ? legacy.pinnedAt : current.pinnedAt,
        autoSettleDisabledAt:
          current.autoSettleDisabledAt === undefined
            ? legacy.autoSettleDisabledAt
            : current.autoSettleDisabledAt,
        pinOrderKey: current.pinOrderKey === undefined ? legacy.pinOrderKey : current.pinOrderKey,
        snoozedUntil:
          current.snoozedUntil === undefined ? legacy.snoozedUntil : current.snoozedUntil,
        snoozedAt: current.snoozedAt === undefined ? legacy.snoozedAt : current.snoozedAt,
        unsettledAt: current.unsettledAt === undefined ? legacy.unsettledAt : current.unsettledAt,
        linkedPullRequest:
          current.linkedPullRequest === undefined
            ? legacy.linkedPullRequest
            : current.linkedPullRequest,
        pullRequests:
          current.pullRequests === undefined
            ? current.linkedPullRequest === null
              ? []
              : legacyPullRequests.length > 0
                ? legacyPullRequests
                : threadPullRequestsOf({
                    linkedPullRequest:
                      current.linkedPullRequest === undefined
                        ? legacy.linkedPullRequest
                        : current.linkedPullRequest,
                  })
            : current.pullRequests,
        branchPullRequest:
          current.branchPullRequest === undefined
            ? legacy.branchPullRequest
            : current.branchPullRequest,
        activeOrderKey:
          current.activeOrderKey === undefined ? legacy.activeOrderKey : current.activeOrderKey,
      };
      if ((yield* encodeMetadataComparison(repaired)) === (yield* encodeMetadataComparison(current))) continue;
      // Later schema additions can require another repair for the same thread.
      const repairId = yield* randomUuidV4;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(
              `${IMPORT_EVENT_PREFIX}:thread:${row.thread_id}:metadata-repair:${repairId}`,
            ),
            type: "thread.metadata-updated",
            threadId: repaired.id,
            providerInstanceId: repaired.providerInstanceId,
            occurredAt: now,
            payload: repaired,
          },
        ],
      });
      changedThreadIds.add(repaired.id);
    }
    const rows = yield* sql<LegacyThreadRow>`
      SELECT
        thread.thread_id,
        thread.project_id,
        thread.title,
        thread.model_selection_json,
        ${legacyBotIdentity} AS bot_identity_json,
        thread.runtime_mode,
        thread.interaction_mode,
        thread.branch,
        thread.worktree_path,
        thread.created_at,
        thread.updated_at,
        thread.archived_at,
        thread.settled_override,
        thread.settled_at,
        thread.unsettled_at,
        thread.snoozed_until,
        thread.snoozed_at,
        thread.pinned_at,
        thread.auto_settle_disabled_at,
        thread.pin_order_key,
        (SELECT json_group_array(json_object('host', pr.host, 'repository', pr.repository, 'number', pr.number, 'url', pr.url, 'source', pr.source, 'linkedAt', pr.linked_at, 'snapshot', json(pr.snapshot_json), 'stack', json(pr.stack_json))) FROM projection_thread_pull_requests pr WHERE pr.thread_id = thread.thread_id) AS pull_requests_json,
        thread.linked_pull_request_json,
        thread.branch_pull_request_json,
        thread.active_order_key,
        thread.deleted_at
      FROM projection_threads AS thread
      WHERE NOT EXISTS (
        SELECT 1
        FROM orchestration_events AS event INDEXED BY orchestration_events_v2_created_threads_idx
        WHERE event.application_event_version = 2
          AND event.aggregate_kind = 'thread'
          AND event.stream_id = thread.thread_id
          AND event.event_type = 'thread.created'
      )
      ORDER BY thread.created_at ASC, thread.thread_id ASC
    `.pipe(NodeSqliteClient.readOnly);
    let importedMessageCount = 0;
    for (const row of rows) {
      const thread = importedThread(row, now, yield* readLegacyBotIdentity(row));
      const previews = yield* listShellMessages(thread.id);
      const events: Array<OrchestrationV2DomainEvent> = [
        {
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${row.thread_id}:created`),
          type: "thread.created",
          threadId: thread.id,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: thread.createdAt,
          payload: thread,
        },
        ...previews.flatMap((message) => messageEvents(message, now)),
        {
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${row.thread_id}:shell`),
          type: "thread.metadata-updated",
          threadId: thread.id,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: thread.updatedAt,
          payload: thread,
        },
      ];
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* Effect.forEach(
            previews,
            (message) =>
              sql`
                INSERT INTO orchestration_v2_turn_item_positions (
                  thread_id,
                  turn_item_id,
                  ordinal
                )
                VALUES (
                  ${thread.id},
                  ${TurnItemId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${message.message_id}`)},
                  ${message.ordinal}
                )
                ON CONFLICT(thread_id, turn_item_id) DO NOTHING
              `,
            { discard: true },
          );
          yield* eventSink.write({ events });
          yield* sql`
            INSERT INTO orchestration_v2_legacy_imports (
              thread_id,
              source_updated_at,
              shell_imported_at,
              transcript_imported_at,
              imported_message_count,
              last_error
            )
            VALUES (
              ${thread.id},
              ${row.updated_at},
              ${DateTime.formatIso(now)},
              NULL,
              ${previews.length},
              NULL
            )
            ON CONFLICT(thread_id) DO NOTHING
          `;
        }),
      );
      changedThreadIds.add(thread.id);
      importedMessageCount += previews.length;
    }
    yield* reconcileWorkerLineage(changedThreadIds, now);
    return { importedThreadCount: changedThreadIds.size, importedMessageCount };
  });

  const reconcileShells = reconcileShellsBase.pipe(
    Effect.mapError((cause) =>
      isLegacyV1ThreadImportError(cause)
        ? cause
        : new LegacyV1ThreadImportError({ operation: "import", cause }),
    ),
  );

  const pendingThreadCount = sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count
    FROM (
      SELECT thread.thread_id
      FROM projection_threads AS thread
      WHERE NOT EXISTS (
        SELECT 1
        FROM orchestration_events AS event INDEXED BY orchestration_events_v2_created_threads_idx
        WHERE event.application_event_version = 2
          AND event.aggregate_kind = 'thread'
          AND event.stream_id = thread.thread_id
          AND event.event_type = 'thread.created'
      )
      UNION
      SELECT legacy_import.thread_id
      FROM orchestration_v2_legacy_imports AS legacy_import
      WHERE legacy_import.transcript_imported_at IS NULL
    )
  `.pipe(
    NodeSqliteClient.readOnly,
    Effect.map((rows) => rows[0]?.count ?? 0),
    Effect.mapError(
      (cause) => new LegacyV1ThreadImportError({ operation: "inspect pending", cause }),
    ),
  );

  const hydrateReasoningTranscript = (
    threadId: ThreadId,
    messages: ReadonlyArray<LegacyMessageRow>,
    existing: ReadonlySet<string>,
    importedAt: DateTime.Utc,
    completed: boolean,
  ) =>
    eventSink.withProviderBatch(
      Effect.gen(function* () {
        const positions = yield* sql<LegacyTurnItemPosition>`
          SELECT position.turn_item_id, position.ordinal, item.payload_json
          FROM orchestration_v2_turn_item_positions AS position
          LEFT JOIN orchestration_v2_projection_turn_items AS item
            ON item.thread_id = position.thread_id AND item.turn_item_id = position.turn_item_id
          WHERE position.thread_id = ${threadId}
        `;
        const byId = new Map(positions.map((row) => [row.turn_item_id, row]));
        const source = new Map(
          messages.map((message) => [
            `${IMPORT_EVENT_PREFIX}:turn-item:${message.message_id}`,
            message,
          ]),
        );
        const ordered = Array.from(source).flatMap(([id, message]) =>
          byId.get(id)?.payload_json != null ||
          (!existing.has(id) && (!completed || message.role === "reasoning"))
            ? [{ id, ordinal: message.ordinal }]
            : [],
        );
        const steps = planLegacyTurnPositions(ordered, positions);
        const inserted = new Set<string>();
        for (const { id, ordinal } of steps) {
          const previous = byId.get(id)?.payload_json;
          yield* sql`
            INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
            VALUES (${threadId}, ${id}, ${ordinal})
            ON CONFLICT(thread_id, turn_item_id) DO UPDATE SET ordinal = excluded.ordinal
          `;
          if (previous != null || inserted.has(id)) {
            const payload = previous != null
              ? yield* decodeLegacyTurnItem(previous)
              : messageEvents(source.get(id)!, importedAt).find(
                  (event) => event.type === "turn-item.updated",
                )!.payload;
            yield* eventSink.write({
              events: [
                {
                  id: EventId.make(`${id}:reasoning-position:${ordinal}`),
                  type: "turn-item.updated",
                  threadId,
                  occurredAt: importedAt,
                  payload: { ...payload, ordinal },
                },
              ],
            });
          } else {
            yield* eventSink.write({
              events: messageEvents({ ...source.get(id)!, ordinal }, importedAt),
            });
            inserted.add(id);
          }
        }
        // A reserved position with no event may already match the plan after an interrupted import.
        for (const { id, ordinal } of ordered) {
          if (inserted.has(id) || existing.has(id) || byId.get(id)?.payload_json != null) continue;
          yield* eventSink.write({
            events: messageEvents({ ...source.get(id)!, ordinal }, importedAt),
          });
          inserted.add(id);
        }
        if (!completed || steps.length > 0 || inserted.size > 0) {
          yield* sql`
            UPDATE orchestration_v2_legacy_imports
            SET transcript_imported_at = COALESCE(transcript_imported_at, ${DateTime.formatIso(importedAt)}),
                imported_message_count = ${messages.length}, last_error = NULL
            WHERE thread_id = ${threadId}
          `;
        }
        return {
          importedThreadCount: !completed || steps.length > 0 || inserted.size > 0 ? 1 : 0,
          importedMessageCount: inserted.size,
        };
      }),
    );

  // V1 source rows are frozen after cutover. Cache only after hydration or repair commits.
  const confirmedTranscriptThreadIds = new Set<ThreadId>();

  const ensureTranscriptBase = (threadId: ThreadId) =>
    transcriptImports.withLock(
      threadId,
      Effect.gen(function* () {
        const imports = yield* sql<LegacyImportRow>`
          SELECT thread_id, transcript_imported_at
          FROM orchestration_v2_legacy_imports
          WHERE thread_id = ${threadId}
          LIMIT 1
        `.pipe(NodeSqliteClient.readOnly);
        const imported = imports[0];
        if (imported === undefined) {
          confirmedTranscriptThreadIds.add(threadId);
          return { importedThreadCount: 0, importedMessageCount: 0 };
        }
        const importedAt = yield* DateTime.now;
        const messages = yield* listMessages(threadId);
        const completed = imported.transcript_imported_at !== null;
        const hasReasoning = messages.some((message) => message.role === "reasoning");
        if (completed && !hasReasoning) {
          confirmedTranscriptThreadIds.add(threadId);
          return { importedThreadCount: 0, importedMessageCount: 0 };
        }
        // Hint the index to skip V1 events without scanning their payloads.
        const existingRows = yield* sql<{ readonly event_id: string }>`
          SELECT event_id
          FROM orchestration_events INDEXED BY idx_orchestration_events_agent_stream_sequence
          WHERE application_event_version = 2
            AND aggregate_kind = 'thread'
            AND stream_id = ${threadId}
            AND event_id LIKE ${`${IMPORT_EVENT_PREFIX}:turn-item:%`}
        `.pipe(NodeSqliteClient.readOnly);
        const existing = new Set(existingRows.map((row) => row.event_id));
        if (hasReasoning) {
          const result = yield* hydrateReasoningTranscript(
            threadId,
            messages,
            existing,
            importedAt,
            completed,
          );
          confirmedTranscriptThreadIds.add(threadId);
          return result;
        }
        const missing = messages.filter(
          (message) => !existing.has(`${IMPORT_EVENT_PREFIX}:turn-item:${message.message_id}`),
        );
        for (const batch of chunks(missing, TRANSCRIPT_EVENT_BATCH_SIZE / 2)) {
          const positioned = yield* Effect.forEach(batch, (message) =>
            Effect.gen(function* () {
              const itemId = TurnItemId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${message.message_id}`);
              // Earlier builds may have reserved preview ordinals without counting reasoning.
              // Keep those positions and append a displaced item instead of failing hydration.
              const [position] = yield* sql<{ readonly ordinal: number }>`
                INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
                VALUES (
                  ${threadId},
                  ${itemId},
                  CASE WHEN EXISTS (
                    SELECT 1 FROM orchestration_v2_turn_item_positions
                    WHERE thread_id = ${threadId} AND ordinal = ${message.ordinal}
                  ) THEN (
                    SELECT MAX(ordinal) + 1 FROM orchestration_v2_turn_item_positions
                    WHERE thread_id = ${threadId}
                  ) ELSE ${message.ordinal} END
                )
                ON CONFLICT(thread_id, turn_item_id) DO UPDATE SET ordinal = ordinal
                RETURNING ordinal
              `;
              return { ...message, ordinal: position!.ordinal };
            }),
          );
          yield* eventSink.write({
            events: positioned.flatMap((message) => messageEvents(message, importedAt)),
          });
          yield* Effect.yieldNow;
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          UPDATE orchestration_v2_legacy_imports
          SET
            transcript_imported_at = ${now},
            imported_message_count = ${messages.length},
            last_error = NULL
          WHERE thread_id = ${threadId}
        `;
        confirmedTranscriptThreadIds.add(threadId);
        return {
          importedThreadCount: 1,
          importedMessageCount: missing.length,
        };
      }),
    );

  const ensureTranscript = (threadId: ThreadId) =>
    confirmedTranscriptThreadIds.has(threadId)
      ? Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 })
      : ensureTranscriptBase(threadId).pipe(
          Effect.mapError(
            (cause) =>
              new LegacyV1ThreadImportError({
                operation: "hydrate transcript for",
                threadId,
                cause,
              }),
          ),
        );

  const importPendingTranscripts = Effect.gen(function* () {
    const rows = yield* sql<LegacyImportRow>`
      SELECT thread_id, transcript_imported_at
      FROM orchestration_v2_legacy_imports
      WHERE transcript_imported_at IS NULL
        OR EXISTS (
          SELECT 1 FROM projection_thread_messages AS message
          WHERE message.thread_id = orchestration_v2_legacy_imports.thread_id
            AND message.role = 'reasoning'
        )
      ORDER BY shell_imported_at ASC, thread_id ASC
    `.pipe(NodeSqliteClient.readOnly);
    let importedThreadCount = 0;
    let importedMessageCount = 0;
    for (const row of rows) {
      const result = yield* ensureTranscript(ThreadId.make(row.thread_id)).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) =>
            Effect.logWarning("Failed to hydrate migrated v1 thread transcript", {
              threadId: row.thread_id,
              cause,
            }).pipe(
              Effect.andThen(() =>
                sql`
                    UPDATE orchestration_v2_legacy_imports
                    SET last_error = 'Transcript hydration failed; retry on next open.'
                    WHERE thread_id = ${row.thread_id}
                  `.pipe(
                  Effect.catchCauseIf(
                    (cause) => !Cause.hasInterrupts(cause),
                    () => Effect.void,
                  ),
                ),
              ),
              Effect.as({ importedThreadCount: 0, importedMessageCount: 0 }),
            ),
        ),
      );
      importedThreadCount += result.importedThreadCount;
      importedMessageCount += result.importedMessageCount;
      yield* Effect.yieldNow;
    }
    return { importedThreadCount, importedMessageCount };
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)))
        : Effect.logWarning("Legacy v1 transcript background import stopped", { cause }).pipe(
            Effect.as({ importedThreadCount: 0, importedMessageCount: 0 }),
          ),
    ),
  );

  return LegacyV1ThreadImporter.of({
    readOpenCodeHistory: Effect.fn("LegacyV1ThreadImporter.readOpenCodeHistory")((threadId, instanceId) => readNativeHistory(threadId, instanceId, "opencode")
      .pipe(Effect.map((history) => history?.nativeId))),
    readGrokHistory: Effect.fn("LegacyV1ThreadImporter.readGrokHistory")((threadId, instanceId) => readNativeHistory(threadId, instanceId, "grok")
      .pipe(Effect.map((history) => history?.nativeId))),
    readClaudeHistory: Effect.fn("LegacyV1ThreadImporter.readClaudeHistory")((threadId, instanceId) => readNativeHistory(threadId, instanceId, "claudeAgent")
      .pipe(Effect.map((history) => history?.storeCwd == null
        ? undefined
        : { ...history, storeCwd: history.storeCwd }))),
    readCodexHistory: Effect.fn("LegacyV1ThreadImporter.readCodexHistory")((threadId, instanceId) => readNativeHistory(threadId, instanceId, "codex")
      .pipe(Effect.map((history) => history?.storeCwd == null
        ? undefined
        : { nativeId: history.nativeId, storeCwd: history.storeCwd }))),
    readAntigravityHistory: Effect.fn("LegacyV1ThreadImporter.readAntigravityHistory")((threadId, instanceId) => readNativeHistory(threadId, instanceId, "antigravity")
      .pipe(Effect.map((history) => history?.storeCwd == null
        ? undefined
        : { nativeId: history.nativeId, storeCwd: history.storeCwd }))),
    readCursorHistory: Effect.fn("LegacyV1ThreadImporter.readCursorHistory")((threadId, instanceId) => readNativeHistory(threadId, instanceId, "cursor")
      .pipe(Effect.map((history) => history?.storeCwd == null
        ? undefined
        : { nativeId: history.nativeId, storeCwd: history.storeCwd }))),
    pendingThreadCount,
    reconcileShells,
    ensureTranscript,
    importPendingTranscripts,
  });
});

export const layer: Layer.Layer<
  LegacyV1ThreadImporter,
  never,
  EventSink.EventSinkV2 | SqlClient.SqlClient
> = Layer.effect(LegacyV1ThreadImporter, make);
