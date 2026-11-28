// @effect-diagnostics nodeBuiltinImport:off - FileSystem loses Windows bigint file indexes; retain them at this boundary.
/**
 * Discover working directories from provider transcripts. The scan is read-only
 * and skips unreadable records. Project creation stays with the client.
 */
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";
import * as NodeZlib from "node:zlib";

import {
  AgentSessionImportSource,
  AgentSessionScanError,
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type AgentSessionProjectCandidate,
  type AgentSessionProjectGit,
  type AgentSessionScanResult,
  type ProviderInstanceConfig,
} from "@j1code/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Pull from "effect/Pull";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { isBareGitConfig, parseOriginUrlFromGitConfig } from "@j1code/shared/git";
import { normalizeProjectPathForComparison } from "@j1code/shared/path";
import * as HostProcess from "@j1code/shared/HostProcess";
import { repositoryPathFromRemoteUrl } from "@j1code/source-control-core/server/SourceControlProvider";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { mergeProviderInstanceEnvironment } from "@j1code/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@j1code/provider-core/server/pathExpansion";
import { piHome, resolvePiSessionsDir } from "@j1code/provider-pi/server/usage";
import * as ServerSettings from "../serverSettings.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import {
  createTranscriptJsonReader,
  createTranscriptJsonSelector,
  TranscriptJsonLimitError,
} from "./AgentSessionJson.ts";

interface TranscriptHandle {
  readonly stat: () => Promise<NodeFS.BigIntStats>;
  readonly read: (size: number) => Promise<Uint8Array>;
  readonly close: () => Promise<void>;
}

export const TranscriptFiles = Context.Reference<{
  readonly stat: (filePath: string) => Promise<NodeFS.BigIntStats>;
  readonly open: (filePath: string) => Promise<TranscriptHandle>;
}>("AgentSessionScanner/TranscriptFiles", {
  defaultValue: () => ({
    stat: (filePath) => NodeFSP.stat(filePath, { bigint: true }),
    open: async (filePath) => {
      const handle = await NodeFSP.open(filePath, "r");
      return {
        stat: () => handle.stat({ bigint: true }),
        read: async (size) => {
          const buffer = new Uint8Array(size);
          const { bytesRead } = await handle.read(buffer, 0, size, null);
          return buffer.subarray(0, bytesRead);
        },
        close: () => handle.close(),
      };
    },
  }),
});

const TRANSCRIPT_PREFIX_BYTES = 32 * 1024;

class TranscriptParseError extends Schema.TaggedError<TranscriptParseError>()(
  "TranscriptParseError",
  { filePath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not parse the transcript at ${this.filePath}.`;
  }
}

class CodexStateReadError extends Schema.TaggedError<CodexStateReadError>()("CodexStateReadError", {
  databasePath: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Could not read Codex projects from ${this.databasePath}.`;
  }
}

class TranscriptReadError extends Schema.TaggedError<TranscriptReadError>()("TranscriptReadError", {
  filePath: Schema.String,
  cause: Schema.Defect(),
}) {}
const METADATA_READ_BYTES = 8 * 1024;
const MAX_TRANSCRIPT_SCAN_BYTES = 1024 * 1024;
const MAX_CODEX_SESSION_INDEX_BYTES = 1024 * 1024;
const MAX_CODEX_PROJECT_ROOT_ROWS = 100_000;

const MAX_TRANSCRIPTS_PER_SOURCE = 5000;

const MAX_DISCOVERY_OPERATIONS_PER_SOURCE = MAX_TRANSCRIPTS_PER_SOURCE * 4;
const MAX_METADATA_BYTES_PER_SOURCE = 64 * 1024 * 1024;
const MAX_METADATA_OPERATIONS_PER_SOURCE = MAX_TRANSCRIPTS_PER_SOURCE * 4;
const MAX_METADATA_RECORDS_PER_SOURCE = 100_000;
const MAX_METADATA_RECORDS_PER_TRANSCRIPT = 1_000;
const RECENT_THREAD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// Screenshot-heavy transcripts can reach GiB; select fields while streaming to avoid allocating payloads.
const MAX_IMPORTED_TRANSCRIPT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_IMPORTED_MESSAGES = 200;
const MAX_IMPORT_HISTORY_BYTES = 32 * 1024 * 1024;
const MAX_IMPORT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_IMPORT_TRANSCRIPTS = 100;
const MAX_IMPORT_RECORDS = 100_000;

/**
 * open() of a file under macOS privacy protection waits on a consent prompt
 * that a headless server never gets, and a FIFO waits for a writer. Either
 * pins a libuv pool thread that interruption cannot free, so git files of
 * arbitrary transcript cwds are read by a `cat` child we can kill instead.
 */
const GIT_FILE_READ_DEADLINE = "2 seconds";
const MAX_GIT_FILE_BYTES = 1024 * 1024;
// Reads run concurrently, so each phase waits one deadline per batch of this
// many blocked files rather than one per blocked file.
const GIT_FILE_READ_CONCURRENCY = 16;
// A blocked path is skipped for a while, then read again in case it was fixed.
const BLOCKED_GIT_FILE_RETRY_MS = 5 * 60 * 1000;
const MAX_BLOCKED_GIT_FILE_PATHS = 1024;

const TranscriptContentBlock = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
});

const TranscriptMessage = Schema.Struct({
  role: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(TranscriptContentBlock)])),
  model: Schema.optional(Schema.String),
});

const CodexTurnMetadata = Schema.Struct({
  turn_id: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
});

const TranscriptRecord = Schema.Struct({
  uuid: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  // Pi entries form a tree through id/parentId; session_info entries carry its name.
  id: Schema.optional(Schema.String),
  parentId: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  aiTitle: Schema.optional(Schema.String),
  customTitle: Schema.optional(Schema.String),
  isSidechain: Schema.optional(Schema.Boolean),
  isMeta: Schema.optional(Schema.Boolean),
  isCompactSummary: Schema.optional(Schema.Boolean),
  message: Schema.optional(TranscriptMessage),
  payload: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      session_id: Schema.optional(Schema.String),
      originator: Schema.optional(Schema.String),
      thread_source: Schema.optional(Schema.String),
      parent_thread_id: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
      role: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
      history_base: Schema.optional(Schema.Unknown),
      content: Schema.optional(Schema.Array(TranscriptContentBlock)),
      internal_chat_message_metadata_passthrough: Schema.optional(Schema.Unknown),
    }),
  ),
});

const CodexSessionIndexEntry = Schema.Struct({
  id: Schema.String,
  thread_name: Schema.String,
});

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const isAgentSessionScanError = Schema.is(AgentSessionScanError);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const decodeTranscriptRecord = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptRecord));
const decodeTranscriptValue = Schema.decodeUnknownOption(TranscriptRecord);
const decodePiEntryLinks = Schema.decodeUnknownOption(
  Schema.Struct({
    type: TranscriptRecord.fields.type,
    id: TranscriptRecord.fields.id,
    parentId: TranscriptRecord.fields.parentId,
  }),
);
const selectTranscriptPath = createTranscriptJsonSelector(TranscriptRecord);
const decodeCodexTurnMetadata = Schema.decodeUnknownOption(CodexTurnMetadata);
export const decodeImportedTranscriptPayload = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.optional(Schema.String),
    importedTranscripts: Schema.optional(Schema.Array(AgentSessionImportSource)),
  }),
);
const decodeCodexHistoryBase = Schema.decodeUnknownOption(
  Schema.Struct({ thread_id: Schema.String, end_byte_offset: Schema.Number }),
);
// Original rollouts end in their thread ID, rewound ones in `<thread ID>_<rollout ID>`.
const CODEX_ROLLOUT_ID_PATTERN =
  /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?\.jsonl(?:\.zst)?$/i;
// Codex zstd-compresses older rollouts; their byte limits and offsets count decompressed bytes.
const COMPRESSED_TRANSCRIPT_SUFFIX = ".jsonl.zst";
const isCompressedTranscript = (filePath: string) =>
  filePath.endsWith(COMPRESSED_TRANSCRIPT_SUFFIX);
// Codex records a chat's project only here; moving a chat leaves its rollout cwd unchanged.
const CODEX_STATE_DATABASE = "state_5.sqlite";
const decodeCodexSessionIndexEntry = Schema.decodeUnknownOption(
  Schema.fromJsonString(CodexSessionIndexEntry),
);

type DecodedTranscriptRecord = typeof TranscriptRecord.Type;

interface AgentSessionTranscriptMetadata {
  readonly fullHistory?: boolean;
  readonly source: AgentSessionSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly fallbackSessionId: string;
  readonly lastActiveAtMs: number;
}

export interface AgentSessionThreadMessage {
  readonly sourceMessageId?: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface AgentSessionThread {
  readonly source: AgentSessionSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: string;
  readonly title: string;
  readonly model: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<AgentSessionThreadMessage>;
  readonly omittedMessageCount: number;
}

export type AgentSessionRecentThread =
  | {
      readonly _tag: "Importable";
      readonly thread: AgentSessionThread;
      readonly source: AgentSessionImportSource;
      /** The root's linked worktree the session ran in, or null when it ran in the root. */
      readonly worktree: { readonly path: string; readonly branch: string | null } | null;
    }
  | { readonly _tag: "AlreadyImported"; readonly source: AgentSessionImportSource }
  | { readonly _tag: "Duplicate"; readonly source: AgentSessionImportSource }
  | { readonly _tag: "Skipped" };

export class AgentSessionScanner extends Context.Service<
  AgentSessionScanner,
  {
    readonly scan: Effect.Effect<AgentSessionScanResult, AgentSessionScanError>;
    readonly recentThreads: (
      workspaceRoot: string,
      completedSources?: ReadonlyArray<AgentSessionImportSource>,
      sourcesOnly?: boolean,
      verifyCompleteSource?: boolean,
    ) => Stream.Stream<AgentSessionRecentThread, AgentSessionScanError>;
  }
>()("@j1code/server/project/AgentSessionScanner") {}

type AgentSessionSource = AgentSessionProjectCandidate["sources"][number];

interface RawCandidate {
  readonly cwd: string;
  readonly source: AgentSessionSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly homePath: string;
  readonly threadCount: number;
  readonly lastActiveAtMs: number | null;
  readonly transcripts: ReadonlyArray<{
    readonly filePath: string;
    readonly mtimeMs: number | null;
    readonly projectRoots?: ReadonlyArray<string> | undefined;
  }>;
}

interface TranscriptCandidate {
  readonly filePath: string;
  readonly mtimeMs: number;
  readonly providerInstanceId: ProviderInstanceId;
  readonly homePath: string;
  readonly identity: TranscriptIdentity;
  readonly projectRoots?: ReadonlyArray<string> | undefined;
}

interface MetadataReadBudget {
  bytesRemaining: number;
  operationsRemaining: number;
  recordsRemaining: number;
  truncated: boolean;
}

function splitOperationBudget(budget: number, count: number): Array<number> {
  return Array.from(
    { length: count },
    (_, index) => Math.floor(budget / count) + (index < budget % count ? 1 : 0),
  );
}

function selectMetadataTranscripts(transcripts: ReadonlyArray<TranscriptCandidate>) {
  const selected: Array<TranscriptCandidate> = [];
  let pending = Array.from(
    Map.groupBy(transcripts, (transcript) => transcript.providerInstanceId).values(),
    (entries) => entries.values(),
  );
  while (pending.length > 0 && selected.length < MAX_TRANSCRIPTS_PER_SOURCE) {
    const nextRound: typeof pending = [];
    for (const iterator of pending) {
      if (selected.length === MAX_TRANSCRIPTS_PER_SOURCE) break;
      const next = iterator.next();
      if (next.done) continue;
      selected.push(next.value);
      nextRound.push(iterator);
    }
    pending = nextRound;
  }
  return selected;
}

function splitTranscriptRecords(contents: string, limit: number): string[] {
  const records = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  return records.split("\n", limit);
}

function isTextContentBlock(block: typeof TranscriptContentBlock.Type): boolean {
  return block.type === "text" || block.type === "input_text" || block.type === "output_text";
}

function extractText(
  content: string | ReadonlyArray<typeof TranscriptContentBlock.Type> | undefined,
): string {
  if (typeof content === "string") return content.trim();
  if (content === undefined) return "";
  return content
    .filter(isTextContentBlock)
    .map((block) => block.text?.trim() ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
}

function normalizeTimestamp(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : fallback;
}

function codexTurnId(metadata: unknown): string | null {
  const decoded = decodeCodexTurnMetadata(metadata);
  if (
    Option.isNone(decoded) ||
    typeof decoded.value.turn_id !== "string" ||
    decoded.value.turn_id.trim().length === 0
  ) {
    return null;
  }
  return decoded.value.turn_id;
}

function isHiddenClaudeRecord(record: DecodedTranscriptRecord): boolean {
  return record.isSidechain === true || record.isMeta === true || record.isCompactSummary === true;
}

function claudeOutputEnd(text: string): number {
  // Sticky matching walks adjacent blocks once. Quoted content stays in the message.
  const block =
    /<(local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr|task-notification|tools-used-before-summary)>[\s\S]*?<\/\1>\s*/y;
  let end = 0;
  while (block.test(text)) end = block.lastIndex;
  return end;
}

function isClaudeOutput(text: string): boolean {
  if (!text.startsWith("<")) return false;
  // Shell output can itself contain closing tags. Use the entire outer envelope.
  if (text.startsWith("<bash-stderr>") && text.endsWith("</bash-stderr>")) return true;
  if (
    text.startsWith("<bash-stdout>") &&
    (text.endsWith("</bash-stdout>") ||
      (text.endsWith("</bash-stderr>") && /<\/bash-stdout>\s*<bash-stderr>/.test(text)))
  ) {
    return true;
  }
  return claudeOutputEnd(text) === text.length;
}

const CLAUDE_COMMAND_TITLE_PREAMBLE =
  /^(?:<command-(name|message|args)>[\s\S]*?<\/command-\1>\s*)+/;

// Claude repeats session fields on records that need not be retained.
interface ClaudeFields {
  readonly sessionId: string | undefined;
  readonly title: string | undefined;
  readonly customTitle: string | null;
  readonly model: string | undefined;
}

const emptyClaudeFields: ClaudeFields = {
  sessionId: undefined,
  title: undefined,
  customTitle: null,
  model: undefined,
};

function foldClaudeFields(fields: ClaudeFields, record: DecodedTranscriptRecord): ClaudeFields {
  if (isHiddenClaudeRecord(record)) return fields;
  const model = record.message?.model?.trim();
  return {
    sessionId: record.sessionId?.trim() || fields.sessionId,
    title: record.aiTitle?.trim() || fields.title,
    // Claude flushes the AI title after the user's rename; an empty rename clears it.
    customTitle:
      record.customTitle === undefined ? fields.customTitle : record.customTitle.trim() || null,
    // Claude uses this sentinel for local error responses. It is not a
    // model ID that can be selected when the imported session resumes.
    model: model && model !== "<synthetic>" ? model : fields.model,
  };
}

// Codex records setup context as user text ahead of the real request. Skip
// these leading blocks when deriving a title; imported messages keep them.
const CODEX_TITLE_PREAMBLE =
  /^(?:\s*(?:<(recommended_plugins|environment_context|user_instructions|INSTRUCTIONS|in-app-browser-context|external_codex_apps_open_page)(?:\s[^>]*)?>[\s\S]*?<\/\1>|# AGENTS\.md instructions\b[^\n]*|## My request for Codex:))+/;

// Codex appends an entry per rename; like Codex, the newest nonempty name wins.
function parseCodexThreadNames(contents: string): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const line of contents.split("\n")) {
    const entry = Option.getOrUndefined(decodeCodexSessionIndexEntry(line));
    const name = entry?.thread_name.trim();
    if (entry !== undefined && name) names.set(entry.id, name);
  }
  return names;
}

// A rewound paginated Codex thread continues in a new rollout that inherits a
// byte prefix of the rollout it replaced.
function codexHistoryBase(records: ReadonlyArray<DecodedTranscriptRecord>) {
  const base = Option.getOrUndefined(
    decodeCodexHistoryBase(
      records.find((record) => record.type === "session_meta")?.payload?.history_base,
    ),
  );
  return base !== undefined &&
    Number.isSafeInteger(base.end_byte_offset) &&
    base.end_byte_offset >= 0
    ? base
    : undefined;
}

// Agent-started sessions wrap the prompt in a `<wake reason=â€¦ current-time=â€¦>`
// envelope; title them after the prompt inside it.
const WAKE_ENVELOPE = /^\s*<wake(?:\s[^>]*)?>([\s\S]*?)(?:<\/wake>|$)/;

function deriveTitle(source: AgentSessionSource, text: string): string | undefined {
  const prompt =
    source === "codex"
      ? text.replace(CODEX_TITLE_PREAMBLE, "")
      : source === "claudeAgent" && text.startsWith("<")
        ? text.slice(claudeOutputEnd(text)).replace(CLAUDE_COMMAND_TITLE_PREAMBLE, "") || text
        : text;
  const request = prompt.replace(WAKE_ENVELOPE, "$1");
  const line = request.trim().split("\n")[0] ?? "";
  return (
    line
      .slice(0, 100)
      .replace(/[\uD800-\uDBFF]$/u, "")
      .trim() || undefined
  );
}

// Pi keeps abandoned branches in the file; its active branch runs from the last entry to the root.
function activePiBranch(
  records: ReadonlyArray<DecodedTranscriptRecord>,
): ReadonlyArray<DecodedTranscriptRecord> {
  const entries = records.filter((record) => record.type !== "session");
  const leaf = entries.at(-1);
  // Version 1 sessions predate the tree and are linear.
  if (leaf?.id === undefined) return entries;
  const byId = new Map(
    entries.flatMap((entry) => (entry.id === undefined ? [] : [[entry.id, entry] as const])),
  );
  const branch: Array<DecodedTranscriptRecord> = [];
  for (
    let entry: DecodedTranscriptRecord | undefined = leaf;
    entry !== undefined && branch.length < entries.length;
    entry = entry.parentId ? byId.get(entry.parentId) : undefined
  ) {
    branch.push(entry);
  }
  return branch.toReversed();
}

function isPiConversationRecord(
  record: DecodedTranscriptRecord,
): record is DecodedTranscriptRecord & {
  readonly message: typeof TranscriptMessage.Type & { readonly role: "user" | "assistant" };
} {
  return (
    record.type === "message" &&
    (record.message?.role === "user" || record.message?.role === "assistant")
  );
}

export function parseAgentSessionTranscript(
  input: AgentSessionTranscriptMetadata & {
    readonly contents: string;
  },
  lines = splitTranscriptRecords(input.contents, MAX_IMPORT_RECORDS + 1),
): AgentSessionThread | null {
  if (lines.length > MAX_IMPORT_RECORDS) return null;
  const records = lines.flatMap((line) => Option.toArray(decodeTranscriptRecord(line)));
  const claudeFields =
    input.source === "claudeAgent"
      ? records.reduce(foldClaudeFields, emptyClaudeFields)
      : emptyClaudeFields;
  const thread = parseAgentSessionRecords(input, records, claudeFields, 0);
  return thread === "empty" ? null : thread;
}

function parseAgentSessionRecords(
  input: AgentSessionTranscriptMetadata,
  records: ReadonlyArray<DecodedTranscriptRecord>,
  claudeFields: ClaudeFields,
  droppedMessageCount: number,
): AgentSessionThread | "empty" | null {
  const fallbackTimestamp = DateTime.formatIso(DateTime.makeUnsafe(input.lastActiveAtMs));
  // Claude filenames are session IDs. Codex rollout filenames include extra
  // timestamp text, so only transcript metadata can provide a resumable ID.
  let providerSessionId =
    input.source === "codex"
      ? ""
      : input.source === "pi"
        ? records.find((record) => record.type === "session")?.id?.trim() || input.fallbackSessionId
        : (claudeFields.sessionId ?? input.fallbackSessionId);
  // Pi titles a session by its latest session_info on any branch; an empty name clears it.
  const title =
    input.source === "pi"
      ? records.findLast((record) => record.type === "session_info")?.name?.trim() || null
      : (claudeFields.title ?? null);
  let model = claudeFields.model ?? null;
  let derivedTitle: string | undefined;
  let hasCodexSessionId = false;
  const messages: Array<AgentSessionThreadMessage & { readonly codexResponseUser: boolean }> = [];
  let firstUserMessage:
    | (AgentSessionThreadMessage & { readonly codexResponseUser: boolean })
    | undefined;
  const canonicalCodexResponseUserIndices = new Set<number>();
  let canonicalUserTextsInTurn = new Set<string>();
  let responseUsersInTurn: Array<{
    readonly index: number;
    readonly turnId: string;
    readonly text: string;
  }> = [];
  const finishCodexTurn = () => {
    const canonicalTurnIds = new Set(
      responseUsersInTurn.flatMap((responseUser) =>
        canonicalUserTextsInTurn.has(responseUser.text) ? [responseUser.turnId] : [],
      ),
    );
    for (const responseUser of responseUsersInTurn) {
      if (canonicalTurnIds.has(responseUser.turnId)) {
        canonicalCodexResponseUserIndices.add(responseUser.index);
      }
    }
    canonicalUserTextsInTurn = new Set();
    responseUsersInTurn = [];
  };
  if (input.source === "codex") {
    let recordIndex = -1;
    for (const record of records) {
      recordIndex += 1;
      if (
        record.type === "response_item" &&
        record.payload?.type === "message" &&
        record.payload.role === "assistant"
      ) {
        finishCodexTurn();
        continue;
      }
      if (record.type === "event_msg" && record.payload?.type === "user_message") {
        const text = record.payload.message?.trim() ?? "";
        if (text.length > 0) canonicalUserTextsInTurn.add(text);
        continue;
      }
      if (
        record.type === "response_item" &&
        record.payload?.type === "message" &&
        record.payload.role === "user"
      ) {
        const turnId = codexTurnId(record.payload.internal_chat_message_metadata_passthrough);
        const text = extractText(record.payload.content);
        if (turnId !== null && text.length > 0) {
          responseUsersInTurn.push({ index: recordIndex, turnId, text });
        }
      }
    }
    finishCodexTurn();
  }

  let conversationMessageCount = 0;
  const retainMessage = (
    message: AgentSessionThreadMessage & { readonly codexResponseUser: boolean },
  ) => {
    if (firstUserMessage === undefined && message.role === "user") {
      firstUserMessage = message;
    }
    if (derivedTitle === undefined && message.role === "user") {
      derivedTitle = deriveTitle(input.source, message.text);
    }
    conversationMessageCount += 1;
    messages.push(message);
    if (!input.fullHistory && messages.length > MAX_IMPORTED_MESSAGES) messages.shift();
  };

  const hasMatchingCodexEventInTurn = (text: string) => {
    const comparisonText = text.trim();
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role === "assistant") return false;
      if (
        message?.role === "user" &&
        !message.codexResponseUser &&
        message.text.trim() === comparisonText
      ) {
        return true;
      }
    }
    return false;
  };

  let recordIndex = -1;
  for (const record of input.source === "pi" ? activePiBranch(records) : records) {
    recordIndex += 1;
    if (input.source === "pi") {
      if (!isPiConversationRecord(record)) continue;
      const text = extractText(record.message.content);
      if (text.length === 0) continue;
      retainMessage({
        role: record.message.role,
        text,
        createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
        codexResponseUser: false,
      });
      continue;
    }
    if (input.source === "claudeAgent") {
      if (isHiddenClaudeRecord(record)) continue;
      if (record.type !== "user" && record.type !== "assistant") continue;
      const text = extractText(record.message?.content);
      if (text.length === 0 || (record.type === "user" && isClaudeOutput(text))) continue;
      retainMessage({
        ...(input.fullHistory && record.uuid ? { sourceMessageId: record.uuid } : {}),
        role: record.type,
        text,
        createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
        codexResponseUser: false,
      });
      continue;
    }

    if (record.type === "session_meta") {
      // J1 already owns these chats. Refresh must not import its provider logs
      // as new top-level conversations, including normal non-worker sessions.
      if (record.payload?.originator === "J1 Code") return null;
      // Spawned workers and guardian reviewers are children of a real chat, not chats.
      if (record.payload?.thread_source === "subagent" || record.payload?.parent_thread_id) {
        return null;
      }
      const sessionId = record.payload?.id?.trim() || record.payload?.session_id?.trim();
      if (!hasCodexSessionId && sessionId) {
        providerSessionId = sessionId;
        hasCodexSessionId = true;
      }
      continue;
    }
    if (record.type === "turn_context" && record.payload?.model?.trim()) {
      model = record.payload.model.trim();
      continue;
    }
    if (record.type === "event_msg" && record.payload?.type === "user_message") {
      const text = record.payload.message ?? "";
      if (text.trim().length === 0) continue;
      // Codex can duplicate prompts across formats; remove only matching response copies.
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message?.role === "assistant") break;
        if (message?.codexResponseUser === true && message.text.trim() === text.trim()) {
          if (firstUserMessage === message) firstUserMessage = undefined;
          messages.splice(index, 1);
          conversationMessageCount -= 1;
          break;
        }
      }
      retainMessage({
        role: "user",
        text,
        createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
        codexResponseUser: false,
      });
      continue;
    }
    if (
      record.type !== "response_item" ||
      record.payload?.type !== "message" ||
      (record.payload.role !== "user" && record.payload.role !== "assistant")
    ) {
      continue;
    }

    const extractedText = extractText(record.payload.content);
    if (extractedText.length === 0) continue;
    // Codex injects project instructions as a user message; it is not something the user typed.
    if (
      record.payload.role === "user" &&
      extractedText.startsWith("# AGENTS.md instructions for ")
    ) {
      continue;
    }
    if (record.payload.role === "user" && canonicalCodexResponseUserIndices.has(recordIndex)) {
      continue;
    }
    if (record.payload.role === "user" && hasMatchingCodexEventInTurn(extractedText)) {
      continue;
    }
    retainMessage({
      role: record.payload.role,
      text: extractedText,
      createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
      codexResponseUser: record.payload.role === "user",
    });
  }

  if (messages.length === 0 && droppedMessageCount === 0) return "empty";
  const visibleMessages = messages.map(
    ({ codexResponseUser: _codexResponseUser, ...message }) => message,
  );
  if (providerSessionId.trim().length === 0 || firstUserMessage === undefined) return null;
  // Workers spawned by J1's own delegation tool are already saved under their lead chat
  // (see mcp/AgentDelegation.ts); their provider sessions must not come back as top-level chats.
  if (firstUserMessage.text.startsWith("You are a delegated worker for lead chat ")) return null;
  const firstUserMessageRetained = messages.includes(firstUserMessage);
  const { codexResponseUser: _codexResponseUser, ...visibleFirstUserMessage } = firstUserMessage;
  const retainedMessages = firstUserMessageRetained
    ? visibleMessages
    : [visibleFirstUserMessage, ...visibleMessages.slice(-(MAX_IMPORTED_MESSAGES - 1))];
  const seenSourceIds = new Set<string>();
  const fallbackOccurrences = new Map<string, number>();

  return {
    source: input.source,
    providerInstanceId: input.providerInstanceId,
    providerSessionId,
    title: claudeFields.customTitle ?? title ?? derivedTitle ?? "Imported thread",
    model,
    createdAt: retainedMessages[0]?.createdAt ?? fallbackTimestamp,
    updatedAt: fallbackTimestamp,
    messages: input.fullHistory
      ? retainedMessages
          .map((message) => {
            const fingerprint = NodeCrypto.createHash("sha256")
              .update(JSON.stringify([message.role, message.text, message.createdAt]))
              .digest("hex");
            const occurrence = fallbackOccurrences.get(fingerprint) ?? 0;
            fallbackOccurrences.set(fingerprint, occurrence + 1);
            return {
              ...message,
              sourceMessageId: message.sourceMessageId ?? `${fingerprint}:${occurrence}`,
            };
          })
          .filter((message) => {
            if (seenSourceIds.has(message.sourceMessageId)) return false;
            seenSourceIds.add(message.sourceMessageId);
            return true;
          })
      : retainedMessages,
    omittedMessageCount: conversationMessageCount + droppedMessageCount - retainedMessages.length,
  };
}

function extractDecodedCwd(record: DecodedTranscriptRecord): string | null {
  const cwd = record.cwd?.trim() || record.payload?.cwd?.trim();
  return cwd && cwd.length > 0 ? cwd : null;
}

function shouldRetainDecodedRecord(
  source: AgentSessionSource,
  record: DecodedTranscriptRecord,
): boolean {
  // Any Pi entry can be a link on the active branch.
  if (source === "pi") return true;
  if (source === "claudeAgent") {
    if (isHiddenClaudeRecord(record) || (record.type !== "user" && record.type !== "assistant")) {
      return false;
    }
    const content = record.message?.content;
    if (record.type === "user") {
      const text = extractText(content);
      return text.length > 0 && !isClaudeOutput(text);
    }
    return typeof content === "string"
      ? content.trim().length > 0
      : (content?.some(
          (block) => isTextContentBlock(block) && (block.text?.trim().length ?? 0) > 0,
        ) ?? false);
  }
  if (extractDecodedCwd(record) !== null) return true;
  return (
    record.type === "session_meta" ||
    record.type === "turn_context" ||
    (record.type === "event_msg" && record.payload?.type === "user_message") ||
    (record.type === "response_item" &&
      record.payload?.type === "message" &&
      (record.payload.role === "user" || record.payload.role === "assistant"))
  );
}

// The import shows only the first user message and the latest messages, so a
// long Claude session holds just those and counts the rest as dropped.
function createClaudeHistoryWindow() {
  const recent: Array<{ readonly record: DecodedTranscriptRecord; readonly bytes: number }> = [];
  let firstUser: DecodedTranscriptRecord | undefined;
  let droppedMessageCount = 0;
  return {
    // Takes a record shouldRetainDecodedRecord kept; returns the bytes it released.
    push: (record: DecodedTranscriptRecord, bytes: number): number => {
      if (firstUser === undefined && record.type === "user") firstUser = record;
      recent.push({ record, bytes });
      if (recent.length <= MAX_IMPORTED_MESSAGES) return 0;
      const evicted = recent.shift();
      if (evicted === undefined || evicted.record === firstUser) return 0;
      droppedMessageCount += 1;
      return evicted.bytes;
    },
    records: () => {
      const held = recent.map((entry) => entry.record);
      return firstUser === undefined || held.includes(firstUser) ? held : [firstUser, ...held];
    },
    droppedMessageCount: () => droppedMessageCount,
  };
}

/**
 * Skip disposable worktrees under the configured root or any `.t3/worktrees`.
 * Callers check the recorded path and real path so symlinks cannot evade the match.
 */
function normalizeForWorktreeMatch(value: string, caseFold: boolean): string {
  const normalized = `${value.replaceAll("\\", "/")}/`;
  return caseFold ? normalized.toLowerCase() : normalized;
}

function isJ1ManagedWorktree(
  candidatePath: string,
  worktreesDir: string,
  caseFold: boolean,
): boolean {
  const normalized = normalizeForWorktreeMatch(candidatePath, caseFold);
  return (
    normalized.startsWith(normalizeForWorktreeMatch(worktreesDir, caseFold)) ||
    normalized.includes("/.t3/worktrees/")
  );
}

// false stops metadata scanning for an excluded rollout, even if later records contain a cwd.
function extractCwd(line: string, source: AgentSessionSource): string | null | false {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (typeof record.cwd === "string" && record.cwd.trim().length > 0) {
    return record.cwd;
  }
  const payload = record.payload;
  if (typeof payload === "object" && payload !== null) {
    if (source === "codex" && record.type === "session_meta") {
      const sessionSource = (payload as Record<string, unknown>).source;
      if (
        typeof sessionSource === "object" &&
        sessionSource !== null &&
        !Array.isArray(sessionSource) &&
        (Object.hasOwn(sessionSource, "subagent") || Object.hasOwn(sessionSource, "subAgent"))
      ) {
        return false;
      }
    }
    const nested = (payload as Record<string, unknown>).cwd;
    if (typeof nested === "string" && nested.trim().length > 0) {
      return nested;
    }
  }
  return null;
}

type TranscriptIdentity = Pick<
  AgentSessionImportSource,
  "filePath" | "fileId" | "size" | "mtimeMs" | "device" | "inode" | "birthtimeMs"
>;
function transcriptIdentity(
  filePath: string,
  stats: FileSystem.File.Info,
  fileId?: string,
): TranscriptIdentity {
  return {
    filePath,
    ...(fileId === undefined ? {} : { fileId }),
    size: Number(stats.size),
    mtimeMs: Option.match(stats.mtime, { onNone: () => null, onSome: (date) => date.getTime() }),
    device: Number(stats.dev),
    inode: Option.match(stats.ino, { onNone: () => null, onSome: String }),
    birthtimeMs: Option.match(stats.birthtime, {
      onNone: () => null,
      onSome: (date) => date.getTime(),
    }),
  };
}

const fileIdKey = (inode: TranscriptIdentity["inode"]) => (inode === null ? null : String(inode));

function sameTranscriptIdentity(left: TranscriptIdentity, right: TranscriptIdentity): boolean {
  // Unsafe legacy numbers may already have lost file ID precision.
  if (
    (typeof left.inode === "number" && !Number.isSafeInteger(left.inode)) ||
    (typeof right.inode === "number" && !Number.isSafeInteger(right.inode))
  ) {
    return false;
  }
  return (
    left.filePath === right.filePath &&
    left.fileId === right.fileId &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.device === right.device &&
    fileIdKey(left.inode) === fileIdKey(right.inode) &&
    left.birthtimeMs === right.birthtimeMs
  );
}

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const transcriptFiles = yield* TranscriptFiles;
  const incompleteLiveReads = new Map<string, TranscriptIdentity>();
  // Windows file indexes can exceed Number.MAX_SAFE_INTEGER, so Effect's
  // numeric inode becomes None. Preserve the native bigint identity as text.
  const identityAt = Effect.fn("AgentSessionScanner.identityAt")(function* (
    filePath: string,
    stats: { readonly size: bigint },
    handle?: TranscriptHandle,
  ) {
    const catchRead = (cause: unknown) => new TranscriptReadError({ filePath, cause });
    const native = yield* Effect.tryPromise({
      try: () => transcriptFiles.stat(filePath),
      catch: catchRead,
    });
    const opened =
      handle === undefined
        ? native
        : yield* Effect.tryPromise({ try: () => handle.stat(), catch: catchRead });
    if (
      native.dev !== opened.dev ||
      native.ino !== opened.ino ||
      native.size !== opened.size ||
      native.mtimeNs !== opened.mtimeNs ||
      native.birthtimeNs !== opened.birthtimeNs ||
      Number(opened.size) !== Number(stats.size)
    ) {
      return yield* new TranscriptReadError({
        filePath,
        cause: "Transcript path no longer names the opened snapshot",
      });
    }
    return {
      filePath,
      fileId: `${opened.dev}:${opened.ino}`,
      inode: String(opened.ino),
      size: Number(opened.size),
      mtimeMs: Number(opened.mtimeMs),
      device: Number(opened.dev),
      birthtimeMs: Number(opened.birthtimeMs),
    };
  });
  // Different project imports can arrive concurrently from multiple clients.
  // Only one transcript may hold its selected-history budget at a time.
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const importReadLock = yield* Semaphore.make(1);
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const baseDir = path.resolve(serverConfig.baseDir);
  const worktreesDir = path.resolve(serverConfig.worktreesDir);
  const platform = yield* HostProcess.Platform;
  const isWindows = platform === "win32";
  const foldWorktreeCase = isWindows;
  const hostEnvironment = yield* HostProcess.Environment;
  const homeDir = yield* HostProcess.HomeDirectory;
  // `/private/tmp` is what macOS reports for sessions started in `/tmp`.
  const excludedProjectRoots = new Set(
    [homeDir, NodeOS.tmpdir(), "/tmp", "/private/tmp"].map((directory) =>
      normalizeProjectPathForComparison(path.resolve(directory)),
    ),
  );
  const excludedProjectAncestors = [
    path.join(homeDir, "Downloads"),
    path.join(homeDir, "Documents", "Codex"),
  ];

  const isExcludedProjectPath = (candidatePath: string) =>
    excludedProjectRoots.has(normalizeProjectPathForComparison(candidatePath)) ||
    excludedProjectAncestors.some((ancestor) =>
      normalizeForWorktreeMatch(candidatePath, foldWorktreeCase).startsWith(
        normalizeForWorktreeMatch(ancestor, foldWorktreeCase),
      ),
    ) ||
    normalizeForWorktreeMatch(candidatePath, foldWorktreeCase).startsWith(
      normalizeForWorktreeMatch(baseDir, foldWorktreeCase),
    ) ||
    isJ1ManagedWorktree(candidatePath, worktreesDir, foldWorktreeCase);

  const listDirectory = (directory: string) =>
    fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  const statOption = (target: string) =>
    fileSystem.stat(target).pipe(Effect.asSome, Effect.orElseSucceed(Option.none));

  const transcriptChunkReader = Effect.fn("AgentSessionScanner.transcriptChunkReader")(function* (
    file: {
      readonly readAlloc: (
        size: number,
      ) => Effect.Effect<
        Option.Option<Uint8Array>,
        PlatformError.PlatformError | TranscriptReadError
      >;
    },
    filePath: string,
  ) {
    if (!isCompressedTranscript(filePath)) return (size: number) => file.readAlloc(size);
    const pull = yield* Stream.toPull(
      Stream.fromEffectRepeat(file.readAlloc(METADATA_READ_BYTES)).pipe(
        Stream.takeWhile(Option.isSome),
        Stream.map(Option.getOrThrow),
        NodeStream.pipeThroughSimple(() => NodeZlib.createZstdDecompress()),
      ),
    );
    let pending: Array<Uint8Array> = [];
    let done = false;
    // Untraced: called once per chunk inside the caller's traced read.
    return Effect.fnUntraced(function* (size: number) {
      while (pending.length === 0) {
        if (done) return Option.none<Uint8Array>();
        const next = yield* pull.pipe(Pull.catchDone(() => Effect.undefined));
        if (next === undefined) done = true;
        else pending = [...next];
      }
      const chunk = pending.shift();
      if (chunk === undefined) return Option.none<Uint8Array>();
      if (chunk.byteLength > size) pending.unshift(chunk.subarray(size));
      return Option.some(chunk.subarray(0, size));
    });
  });

  const directoryIdentity = Effect.fn("AgentSessionScanner.directoryIdentity")(function* (
    target: string,
    knownStats?: FileSystem.File.Info,
  ) {
    const resolved = path.resolve(target);
    const stats = knownStats === undefined ? yield* statOption(resolved) : Option.some(knownStats);
    if (Option.isSome(stats) && Option.isSome(stats.value.ino) && stats.value.ino.value > 0n) {
      return `inode:${stats.value.dev}:${stats.value.ino.value}`;
    }
    const realPath = yield* fileSystem
      .realPath(resolved)
      .pipe(Effect.orElseSucceed(() => resolved));
    return `path:${normalizeProjectPathForComparison(realPath)}`;
  });

  /** Stats a directory that may be offered as a project, or none when it is missing or excluded. */
  const projectDirectoryStats = Effect.fn("AgentSessionScanner.projectDirectoryStats")(function* (
    directory: string,
  ) {
    if (isExcludedProjectPath(directory)) return Option.none<FileSystem.File.Info>();
    const stats = yield* statOption(directory);
    if (Option.isNone(stats) || stats.value.type !== "Directory") return Option.none();
    const realPath = yield* fileSystem
      .realPath(directory)
      .pipe(Effect.orElseSucceed(() => directory));
    // Symlinks can disguise excluded worktree paths; re-check their targets.
    return isExcludedProjectPath(realPath) ? Option.none() : stats;
  });

  // Paths whose own read outlived the deadline, mapped to when they may be read
  // again. Without this every later scan would wait out the deadline again for
  // each phase that touches them.
  const blockedGitFilePaths = new Map<string, number>();

  /** Reads small files without the libuv pool; "" when missing, unreadable or blocked. */
  const readGitFiles = Effect.fn("AgentSessionScanner.readGitFiles")(function* (
    filePaths: ReadonlyArray<string>,
  ) {
    const unique = Array.from(new Set(filePaths));
    const now = yield* Clock.currentTimeMillis;
    const contents = yield* Effect.forEach(
      unique,
      (filePath) => {
        // No privacy prompts or FIFOs to block open() here.
        if (isWindows) {
          return fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
        }
        if ((blockedGitFilePaths.get(filePath) ?? 0) > now) return Effect.succeed("");
        blockedGitFilePaths.delete(filePath);
        return processRunner
          .run({
            command: "cat",
            args: ["--", filePath],
            timeout: GIT_FILE_READ_DEADLINE,
            timeoutBehavior: "timedOutResult",
            maxOutputBytes: MAX_GIT_FILE_BYTES,
            outputMode: "truncate",
          })
          .pipe(
            Effect.map((result) => {
              if (result.timedOut) {
                if (blockedGitFilePaths.size >= MAX_BLOCKED_GIT_FILE_PATHS) {
                  blockedGitFilePaths.delete(blockedGitFilePaths.keys().next().value!);
                }
                blockedGitFilePaths.set(filePath, now + BLOCKED_GIT_FILE_RETRY_MS);
              }
              return result.code === 0 ? result.stdout : "";
            }),
            Effect.orElseSucceed(() => ""),
          );
      },
      { concurrency: isWindows ? 1 : GIT_FILE_READ_CONCURRENCY },
    );
    return new Map(unique.map((filePath, index) => [filePath, contents[index]!]));
  });

  /** Reads every directory's git identity in three phases of concurrent reads. */
  const readGitIdentities = Effect.fn("AgentSessionScanner.readGitIdentities")(function* (
    directories: ReadonlyArray<string>,
  ) {
    type GitIdentity =
      | { readonly _tag: "Repository"; readonly git: AgentSessionProjectGit | null }
      | {
          readonly _tag: "Worktree";
          readonly gitDir: string;
          readonly mainCheckout: string | null;
          readonly git: AgentSessionProjectGit | null;
        }
      | { readonly _tag: "NotGit" };
    const identities = new Map<string, GitIdentity>();
    const repositories: Array<{
      directory: string;
      gitDir: string;
      worktreeGitDir: string | null;
    }> = [];
    const pointers: Array<{ directory: string; gitPath: string }> = [];
    for (const directory of directories) {
      const gitPath = path.join(directory, ".git");
      const gitStats = yield* statOption(gitPath);
      if (Option.isNone(gitStats)) identities.set(directory, { _tag: "NotGit" });
      else if (gitStats.value.type === "Directory") {
        repositories.push({ directory, gitDir: gitPath, worktreeGitDir: null });
      } else pointers.push({ directory, gitPath });
    }

    const pointerTexts = yield* readGitFiles(pointers.map(({ gitPath }) => gitPath));
    const linkedWorktrees: Array<{ directory: string; gitDir: string }> = [];
    for (const { directory, gitPath } of pointers) {
      const target = /^gitdir:\s*(.+)$/m.exec(pointerTexts.get(gitPath) ?? "")?.[1]?.trim();
      if (target === undefined || target.length === 0) {
        identities.set(directory, { _tag: "NotGit" });
        continue;
      }
      const gitDir = path.resolve(directory, target);
      if (/[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(gitDir)) {
        linkedWorktrees.push({ directory, gitDir });
      } else repositories.push({ directory, gitDir, worktreeGitDir: null });
    }

    const commonDirTexts = yield* readGitFiles(
      linkedWorktrees.map(({ gitDir }) => path.join(gitDir, "commondir")),
    );
    for (const { directory, gitDir } of linkedWorktrees) {
      const commonDir = (commonDirTexts.get(path.join(gitDir, "commondir")) ?? "").trim();
      if (commonDir.length === 0) {
        identities.set(directory, { _tag: "Worktree", gitDir, mainCheckout: null, git: null });
      } else
        repositories.push({
          directory,
          gitDir: path.resolve(gitDir, commonDir),
          worktreeGitDir: gitDir,
        });
    }

    const configTexts = yield* readGitFiles(
      repositories.map(({ gitDir }) => path.join(gitDir, "config")),
    );
    for (const { directory, gitDir, worktreeGitDir } of repositories) {
      const configText = configTexts.get(path.join(gitDir, "config")) ?? "";
      const originUrl = parseOriginUrlFromGitConfig(configText);
      const git: AgentSessionProjectGit = {
        remoteKey:
          originUrl === null ? null : sourceControlDefinitions.repositoryKeyFromRemote(originUrl),
        repository: repositoryPathFromRemoteUrl(originUrl),
      };
      // Bare repositories have no main checkout, so offer their linked worktrees independently.
      if (worktreeGitDir !== null && !isBareGitConfig(configText)) {
        identities.set(directory, {
          _tag: "Worktree",
          gitDir: worktreeGitDir,
          // Only a common dir named .git sits inside its main checkout, and an
          // unreadable config can't rule out a bare repository.
          mainCheckout:
            configText.length > 0 && path.basename(gitDir) === ".git" ? path.dirname(gitDir) : null,
          git,
        });
        continue;
      }
      identities.set(directory, { _tag: "Repository", git });
    }
    return identities;
  });

  /** Maps each directory to the project it counts toward: a linked worktree counts toward its main checkout. */
  const resolveDirectoryProjects = Effect.fn("AgentSessionScanner.resolveDirectoryProjects")(
    function* (resolvedDirectories: ReadonlyArray<string>) {
      // Stat every directory first so one batch reads all git identities.
      const directories = new Map<string, Option.Option<FileSystem.File.Info>>();
      for (const resolved of resolvedDirectories) {
        if (directories.has(resolved)) continue;
        directories.set(resolved, yield* projectDirectoryStats(resolved));
      }
      const directoryGitIdentities = yield* readGitIdentities(
        Array.from(directories).flatMap(([directory, stats]) =>
          Option.isSome(stats) ? [directory] : [],
        ),
      );
      const projects = new Map<
        string,
        {
          readonly key: string;
          readonly path: string;
          readonly git: AgentSessionProjectGit | null;
          readonly worktreeGitDir: string | null;
        } | null
      >();
      for (const [resolved, stats] of directories) {
        const gitIdentity = directoryGitIdentities.get(resolved);
        if (Option.isNone(stats) || gitIdentity === undefined) {
          projects.set(resolved, null);
        } else if (gitIdentity._tag === "Worktree") {
          const { mainCheckout } = gitIdentity;
          const mainStats =
            mainCheckout === null ? Option.none() : yield* projectDirectoryStats(mainCheckout);
          projects.set(
            resolved,
            mainCheckout !== null && Option.isSome(mainStats)
              ? {
                  key: yield* directoryIdentity(mainCheckout, mainStats.value),
                  path: mainCheckout,
                  git: gitIdentity.git,
                  worktreeGitDir: gitIdentity.gitDir,
                }
              : null,
          );
        } else {
          projects.set(resolved, {
            key: yield* directoryIdentity(resolved, stats.value),
            path: resolved,
            git: gitIdentity._tag === "Repository" ? gitIdentity.git : null,
            worktreeGitDir: null,
          });
        }
      }
      return projects;
    },
  );

  const readCwd = Effect.fn("AgentSessionScanner.readCwd")(function* (
    source: AgentSessionSource,
    transcript: TranscriptCandidate,
    budget: MetadataReadBudget,
  ) {
    if (transcript.identity.size === 0) return null;
    if (
      budget.bytesRemaining === 0 ||
      budget.operationsRemaining < 2 ||
      budget.recordsRemaining === 0
    ) {
      budget.truncated = true;
      return null;
    }
    budget.operationsRemaining -= 1;
    return yield* Effect.scoped(
      fileSystem.open(transcript.filePath, { flag: "r" }).pipe(
        Effect.flatMap((file) =>
          Effect.gen(function* () {
            const readChunk = yield* transcriptChunkReader(file, transcript.filePath);
            const size = isCompressedTranscript(transcript.filePath)
              ? Number.POSITIVE_INFINITY
              : transcript.identity.size;
            const decoder = new TextDecoder();
            let remaining = "";
            let bytesRead = 0;
            let recordsRead = 0;
            const maxBytes = Math.min(MAX_TRANSCRIPT_SCAN_BYTES, size);
            const reserveRecord = () => {
              if (
                recordsRead === MAX_METADATA_RECORDS_PER_TRANSCRIPT ||
                budget.recordsRemaining === 0
              ) {
                budget.truncated = true;
                return false;
              }
              recordsRead += 1;
              budget.recordsRemaining -= 1;
              return true;
            };
            const readLastRecord = () => {
              const record = remaining + decoder.decode();
              return record.length === 0 || !reserveRecord()
                ? null
                : extractCwd(record.trim(), source);
            };

            while (bytesRead < maxBytes) {
              if (budget.bytesRemaining === 0 || budget.operationsRemaining === 0) {
                budget.truncated = true;
                return null;
              }
              const readSize = Math.min(
                METADATA_READ_BYTES,
                maxBytes - bytesRead,
                budget.bytesRemaining,
              );
              budget.operationsRemaining -= 1;
              budget.bytesRemaining -= readSize;
              const next = yield* readChunk(readSize);
              if (Option.isNone(next)) {
                return readLastRecord();
              }

              bytesRead += next.value.byteLength;
              remaining += decoder.decode(next.value, { stream: true });
              const lines = remaining.split("\n");
              remaining = lines.pop() ?? "";

              for (const line of lines) {
                if (!reserveRecord()) return null;
                const cwd = extractCwd(line.trim(), source);
                if (cwd !== null) return cwd;
              }
            }

            if (bytesRead < size) {
              budget.truncated = true;
              return null;
            }
            return readLastRecord();
          }),
        ),
      ),
    ).pipe(Effect.orElseSucceed(() => null));
  });

  const readTranscript = Effect.fn("AgentSessionScanner.readTranscript")(function* (
    filePath: string,
    expected: ReturnType<typeof transcriptIdentity>,
    source: AgentSessionSource,
    prefix?: { readonly endByteOffset: number; readonly historyBytes: number },
    fullHistory = false,
    recordBudget?: { remaining: number },
  ) {
    const compressed = isCompressedTranscript(filePath);
    const readBytes =
      prefix?.endByteOffset ?? (compressed ? MAX_IMPORTED_TRANSCRIPT_BYTES : expected.size);
    if ((!compressed && readBytes > expected.size) || readBytes > MAX_IMPORTED_TRANSCRIPT_BYTES) {
      return null;
    }

    const catchRead = (cause: unknown) => new TranscriptReadError({ filePath, cause });
    return yield* Effect.scoped(
      Effect.acquireRelease(
        Effect.tryPromise({ try: () => transcriptFiles.open(filePath), catch: catchRead }),
        (handle) => Effect.promise(() => handle.close()),
      ).pipe(
        Effect.flatMap((handle) =>
          Effect.gen(function* () {
            const readAlloc = (size: number) =>
              Effect.tryPromise({ try: () => handle.read(size), catch: catchRead }).pipe(
                Effect.map((chunk) =>
                  chunk.length === 0 ? Option.none<Uint8Array>() : Option.some(chunk),
                ),
              );
            if (
              !sameTranscriptIdentity(
                expected,
                yield* identityAt(filePath, { size: BigInt(expected.size) }, handle),
              )
            ) {
              return null;
            }
            const readChunk = yield* transcriptChunkReader({ readAlloc }, filePath);
            const records: Array<DecodedTranscriptRecord> = [];
            const claudeHistory = createClaudeHistoryWindow();
            let cwd = Option.none<string>();
            let claudeFields = emptyClaudeFields;
            let historyBytes = prefix?.historyBytes ?? 0;
            let recordBytes = 0;
            let recordCount = 0;
            let bytesRead = 0;
            const reserve = (bytes: number) => {
              recordBytes += bytes;
              if (historyBytes + recordBytes > MAX_IMPORT_HISTORY_BYTES) {
                throw new TranscriptJsonLimitError({
                  message: "Transcript selected history exceeds the 32 MiB memory budget",
                });
              }
            };
            let reader = createTranscriptJsonReader(reserve, selectTranscriptPath);
            let decoder = new TextDecoder();
            let recordStarted = false;
            let lastRecordComplete = true;

            const finishRecord = () => {
              reader.write(decoder.decode());
              if (recordBudget !== undefined) {
                if (recordBudget.remaining === 0) return false;
                recordBudget.remaining -= 1;
              }
              recordCount += 1;
              // Claude keeps a bounded window, so only the byte budgets limit its length.
              if (recordCount > MAX_IMPORT_RECORDS && (fullHistory || source !== "claudeAgent"))
                return false;
              const value = reader.finish();
              lastRecordComplete = value !== undefined;
              const decoded = decodeTranscriptValue(value);
              if (Option.isNone(decoded) && source === "pi") {
                // Pi accepts messages this schema rejects, such as null content; keep their tree links.
                records.push(...Option.toArray(decodePiEntryLinks(value)));
              } else if (Option.isSome(decoded)) {
                if (Option.isNone(cwd)) cwd = Option.fromNullOr(extractDecodedCwd(decoded.value));
                if (source === "claudeAgent") {
                  claudeFields = foldClaudeFields(claudeFields, decoded.value);
                }
                if (shouldRetainDecodedRecord(source, decoded.value)) {
                  if (source === "claudeAgent" && !fullHistory) {
                    historyBytes += recordBytes - claudeHistory.push(decoded.value, recordBytes);
                  } else if (
                    source === "pi" &&
                    decoded.value.type === "message" &&
                    !isPiConversationRecord(decoded.value)
                  ) {
                    // Tool output can dwarf the conversation; keep only the tree links.
                    const { message: _message, ...links } = decoded.value;
                    records.push(links);
                  } else {
                    records.push(decoded.value);
                    historyBytes += recordBytes;
                  }
                }
              }
              recordBytes = 0;
              reader = createTranscriptJsonReader(reserve, selectTranscriptPath);
              decoder = new TextDecoder();
              recordStarted = false;
              return true;
            };

            while (bytesRead < readBytes) {
              const next = yield* readChunk(
                Math.min(TRANSCRIPT_PREFIX_BYTES, readBytes - bytesRead),
              );
              if (Option.isNone(next)) {
                // A compressed rollout's decompressed length is only known at its end.
                if (compressed && prefix === undefined) break;
                return null;
              }

              bytesRead += next.value.byteLength;
              const withinBudget = yield* Effect.try({
                try: () => {
                  let start = 0;
                  while (start < next.value.byteLength) {
                    const newline = next.value.indexOf(10, start);
                    const end = newline === -1 ? next.value.byteLength : newline;
                    recordStarted = true;
                    reader.write(decoder.decode(next.value.subarray(start, end), { stream: true }));
                    if (newline === -1) break;
                    if (!finishRecord()) return false;
                    start = newline + 1;
                  }
                  return true;
                },
                catch: (cause) => new TranscriptParseError({ filePath, cause }),
              });
              if (!withinBudget) return null;
            }

            // A writer may have flushed only part of the last JSON record.
            // Never mark that byte range completed; the next refresh retries it.
            let complete = true;
            if (recordStarted) {
              if (
                !(yield* Effect.try({
                  try: finishRecord,
                  catch: (cause) => new TranscriptParseError({ filePath, cause }),
                }))
              )
                return null;
              complete = lastRecordComplete;
            }
            const actual = yield* identityAt(
              filePath,
              {
                size: (yield* Effect.tryPromise({ try: () => handle.stat(), catch: catchRead }))
                  .size,
              },
              handle,
            );
            const appendOnlyGrowth =
              actual.size > expected.size &&
              actual.fileId === expected.fileId &&
              actual.device === expected.device &&
              actual.inode === expected.inode &&
              actual.birthtimeMs === expected.birthtimeMs;
            return sameTranscriptIdentity(expected, actual) || appendOnlyGrowth
              ? {
                  records:
                    source === "claudeAgent" && !fullHistory ? claudeHistory.records() : records,
                  recordCount,
                  complete,
                  droppedMessageCount: claudeHistory.droppedMessageCount(),
                  cwd,
                  claudeFields,
                  historyBytes,
                }
              : null;
          }),
        ),
      ),
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not read imported transcript", { filePath, cause }).pipe(
          Effect.as(null),
        ),
      ),
    );
  });

  const readCodexThreadNames = Effect.fn("AgentSessionScanner.readCodexThreadNames")(function* (
    homePath: string,
  ) {
    const indexPath = path.join(homePath, "session_index.jsonl");
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(indexPath, { flag: "r" });
        const size = Number((yield* file.stat).size);
        const start = Math.max(0, size - MAX_CODEX_SESSION_INDEX_BYTES);
        yield* file.seek(BigInt(start), "start");
        const bytes = yield* file.readAlloc(size - start);
        const contents = Option.match(bytes, {
          onNone: () => "",
          onSome: (value) => new TextDecoder().decode(value),
        });
        // A tail read can start mid-record.
        return parseCodexThreadNames(
          start > 0 ? contents.slice(contents.indexOf("\n") + 1) : contents,
        );
      }),
    ).pipe(Effect.orElseSucceed((): ReadonlyMap<string, string> => new Map()));
  });

  const resolveClaudeConfigDir = (homePath: string, environmentHome?: string): string => {
    const configured = homePath.trim();
    if (configured.length > 0) {
      return path.resolve(expandHomePath(configured, homeDir));
    }
    const fromEnvironment = environmentHome?.trim() ?? "";
    if (fromEnvironment.length > 0) {
      return path.resolve(expandHomePath(fromEnvironment, homeDir));
    }
    return path.join(homeDir, ".claude");
  };

  const discoverClaudeTranscripts = Effect.fn("AgentSessionScanner.discoverClaudeTranscripts")(
    function* (homePath: string, providerInstanceId: ProviderInstanceId, operationBudget: number) {
      const projectsDir = path.join(homePath, "projects");
      let operationsRemaining = operationBudget;
      let truncated = false;
      const readDirectory = (directory: string) => {
        if (operationsRemaining <= 0) {
          truncated = true;
          return Effect.succeed<ReadonlyArray<string>>([]);
        }
        operationsRemaining -= 1;
        return listDirectory(directory);
      };
      // Folder names carry no date, so read the newest folders first: a budget that runs out
      // then drops the oldest sessions. Dating has its own allowance, apart from the reads.
      let datesRemaining = operationBudget;
      const dated: Array<{ readonly name: string; readonly mtimeMs: number }> = [];
      const undated: Array<string> = [];
      for (const name of yield* readDirectory(projectsDir)) {
        if (datesRemaining <= 0) {
          undated.push(name);
          continue;
        }
        datesRemaining -= 1;
        const stats = yield* statOption(path.join(projectsDir, name));
        if (Option.isNone(stats) || stats.value.type !== "Directory") continue;
        dated.push({
          name,
          mtimeMs: Option.match(stats.value.mtime, {
            onNone: () => 0,
            onSome: (mtime) => mtime.getTime(),
          }),
        });
      }
      const projectDirectories = [
        ...dated
          .toSorted(
            (left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name),
          )
          .map((entry) => entry.name),
        ...undated,
      ];
      const transcripts: Array<TranscriptCandidate> = [];

      for (const projectDirectory of projectDirectories) {
        if (operationsRemaining <= 0) {
          truncated = true;
          break;
        }
        const directory = path.join(projectsDir, projectDirectory);
        const directoryTranscripts = (yield* readDirectory(directory))
          .filter((entry) => entry.endsWith(".jsonl"))
          .map((entry) => path.join(directory, entry));

        for (const filePath of directoryTranscripts) {
          if (operationsRemaining <= 0) {
            truncated = true;
            break;
          }
          operationsRemaining -= 1;
          const stats = yield* statOption(filePath);
          if (
            Option.isNone(stats) ||
            stats.value.type !== "File" ||
            Option.isNone(stats.value.mtime)
          ) {
            continue;
          }
          transcripts.push({
            filePath,
            mtimeMs: stats.value.mtime.value.getTime(),
            providerInstanceId,
            homePath,
            identity: transcriptIdentity(filePath, stats.value),
          });
        }
      }
      return { transcripts, truncated, operationsUsed: operationBudget - operationsRemaining };
    },
  );

  const readCodexProjectRoots = Effect.fn("AgentSessionScanner.readCodexProjectRoots")(function* (
    homePath: string,
  ) {
    const rootsByThread = new Map<string, Array<string>>();
    const databasePath = path.join(homePath, CODEX_STATE_DATABASE);
    return yield* Effect.try({
      try: () => {
        const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
        try {
          database.exec("PRAGMA busy_timeout = 100");
          const rows = database
            .prepare(
              `SELECT threads.id AS id, project_roots.path AS path
               FROM threads JOIN project_roots ON project_roots.project_id = threads.project_id
               ORDER BY threads.rowid DESC, project_roots.position LIMIT ?`,
            )
            .all(MAX_CODEX_PROJECT_ROOT_ROWS);
          for (const { id, path: root } of rows) {
            if (typeof id !== "string" || typeof root !== "string" || root.trim().length === 0) {
              continue;
            }
            const roots = rootsByThread.get(id);
            if (roots === undefined) rootsByThread.set(id, [root]);
            else roots.push(root);
          }
          return rootsByThread;
        } finally {
          database.close();
        }
      },
      catch: (cause) => new CodexStateReadError({ databasePath, cause }),
    }).pipe(Effect.orElseSucceed((): ReadonlyMap<string, ReadonlyArray<string>> => new Map()));
  });

  // Only chats left in an excluded folder, such as Codex's scratch folder, take their project's root.
  const projectCwd = (cwd: string, projectRoots: ReadonlyArray<string> | undefined) =>
    projectRoots !== undefined &&
    isExcludedProjectPath(path.resolve(expandHomePath(cwd.trim(), homeDir)))
      ? projectRoots[0]!
      : cwd;

  const discoverCodexTranscripts = Effect.fn("AgentSessionScanner.discoverCodexTranscripts")(
    function* (homePath: string, providerInstanceId: ProviderInstanceId, operationBudget: number) {
      const sessionsDir = path.join(homePath, "sessions");

      const transcripts: Array<TranscriptCandidate> = [];
      let operationsRemaining = operationBudget;
      let truncated = false;
      const readDirectory = (directory: string) => {
        if (operationsRemaining <= 0) {
          truncated = true;
          return Effect.succeed<ReadonlyArray<string>>([]);
        }
        operationsRemaining -= 1;
        return listDirectory(directory);
      };
      for (const year of (yield* readDirectory(sessionsDir)).toSorted().toReversed()) {
        if (operationsRemaining <= 0) {
          truncated = true;
          break;
        }
        for (const month of (yield* readDirectory(path.join(sessionsDir, year)))
          .toSorted()
          .toReversed()) {
          if (operationsRemaining <= 0) {
            truncated = true;
            break;
          }
          for (const day of (yield* readDirectory(path.join(sessionsDir, year, month)))
            .toSorted()
            .toReversed()) {
            if (operationsRemaining <= 0) {
              truncated = true;
              break;
            }
            const directory = path.join(sessionsDir, year, month, day);
            for (const entry of (yield* readDirectory(directory)).toSorted().toReversed()) {
              if (
                !entry.startsWith("rollout-") ||
                !(entry.endsWith(".jsonl") || isCompressedTranscript(entry))
              ) {
                continue;
              }
              if (operationsRemaining <= 0) {
                truncated = true;
                break;
              }
              const filePath = path.join(directory, entry);
              operationsRemaining -= 1;
              const stats = yield* statOption(filePath);
              if (
                Option.isSome(stats) &&
                stats.value.type === "File" &&
                Option.isSome(stats.value.mtime)
              ) {
                transcripts.push({
                  filePath,
                  mtimeMs: stats.value.mtime.value.getTime(),
                  providerInstanceId,
                  homePath,
                  identity: transcriptIdentity(filePath, stats.value),
                });
              }
            }
          }
        }
      }
      const projectRoots = yield* readCodexProjectRoots(homePath);
      return {
        transcripts: transcripts.map((transcript) => {
          const threadId = CODEX_ROLLOUT_ID_PATTERN.exec(transcript.filePath)?.[1];
          const roots = threadId === undefined ? undefined : projectRoots.get(threadId);
          return roots === undefined ? transcript : { ...transcript, projectRoots: roots };
        }),
        truncated,
        operationsUsed: operationBudget - operationsRemaining,
      };
    },
  );

  // Pi nests sessions in one directory per cwd, but a custom session directory holds them flat.
  const discoverPiTranscripts = Effect.fn("AgentSessionScanner.discoverPiTranscripts")(function* (
    sessionsDir: string,
    providerInstanceId: ProviderInstanceId,
    operationBudget: number,
  ) {
    let operationsRemaining = operationBudget;
    let truncated = false;
    const readDirectory = (directory: string) => {
      if (operationsRemaining <= 0) {
        truncated = true;
        return Effect.succeed<ReadonlyArray<string>>([]);
      }
      operationsRemaining -= 1;
      return listDirectory(directory);
    };
    const transcripts: Array<TranscriptCandidate> = [];
    for (const entry of yield* readDirectory(sessionsDir)) {
      if (operationsRemaining <= 0) {
        truncated = true;
        break;
      }
      const entryPath = path.join(sessionsDir, entry);
      const filePaths = entry.endsWith(".jsonl")
        ? [entryPath]
        : (yield* readDirectory(entryPath))
            .filter((nested) => nested.endsWith(".jsonl"))
            .map((nested) => path.join(entryPath, nested));

      for (const filePath of filePaths) {
        if (operationsRemaining <= 0) {
          truncated = true;
          break;
        }
        operationsRemaining -= 1;
        const stats = yield* statOption(filePath);
        if (
          Option.isSome(stats) &&
          stats.value.type === "File" &&
          Option.isSome(stats.value.mtime)
        ) {
          transcripts.push({
            filePath,
            mtimeMs: stats.value.mtime.value.getTime(),
            providerInstanceId,
            homePath: sessionsDir,
            identity: transcriptIdentity(filePath, stats.value),
          });
        }
      }
    }
    return { transcripts, truncated, operationsUsed: operationBudget - operationsRemaining };
  });

  const groupTranscriptsByCwd = Effect.fn("AgentSessionScanner.groupTranscriptsByCwd")(function* (
    source: AgentSessionSource,
    transcripts: ReadonlyArray<TranscriptCandidate>,
    budget: MetadataReadBudget,
    importedByFile: ReadonlyMap<
      string,
      ReadonlyArray<{ readonly cwd: string; readonly source: AgentSessionImportSource }>
    >,
  ) {
    const byOwnerAndCwd = new Map<
      string,
      {
        cwd: string;
        providerInstanceId: ProviderInstanceId;
        homePath: string;
        lastActiveAtMs: number;
        transcripts: Array<TranscriptCandidate>;
      }
    >();

    for (const transcript of transcripts) {
      // Unchanged imported transcripts keep their import cwd, so they never spend the read budget.
      // Codex is excluded: its first record carries the cwd and the subagent marker, and
      // rollouts imported before subagents were skipped must still be excluded by it.
      const completed =
        source === "codex"
          ? undefined
          : importedByFile.get(`${transcript.providerInstanceId}\0${transcript.filePath}`);
      let importedCwd: string | undefined;
      if (completed !== undefined && budget.operationsRemaining > 0) {
        budget.operationsRemaining -= 1;
        // Discovery stats cannot reliably represent a Windows file index. Match cursors
        // from the same native stat API used to record them, before trusting their cwd.
        const identity = yield* identityAt(transcript.filePath, {
          size: BigInt(transcript.identity.size),
        }).pipe(Effect.orElseSucceed(() => null));
        if (identity !== null) {
          importedCwd = completed.find(
            (imported) =>
              imported.source.provider === source &&
              sameTranscriptIdentity(imported.source, identity),
          )?.cwd;
        }
      }
      const rolloutCwd = importedCwd ?? (yield* readCwd(source, transcript, budget));
      if (rolloutCwd === null || rolloutCwd === false) continue;
      const cwd = projectCwd(rolloutCwd, transcript.projectRoots);
      const key = `${transcript.providerInstanceId}\0${cwd}`;
      const existing = byOwnerAndCwd.get(key);
      if (existing) {
        existing.lastActiveAtMs = Math.max(existing.lastActiveAtMs, transcript.mtimeMs);
        existing.transcripts.push(transcript);
      } else {
        byOwnerAndCwd.set(key, {
          cwd,
          providerInstanceId: transcript.providerInstanceId,
          homePath: transcript.homePath,
          lastActiveAtMs: transcript.mtimeMs,
          transcripts: [transcript],
        });
      }
    }

    return Array.from(byOwnerAndCwd.values(), (group): RawCandidate => ({
      cwd: group.cwd,
      source,
      providerInstanceId: group.providerInstanceId,
      homePath: group.homePath,
      threadCount: group.transcripts.length,
      lastActiveAtMs: group.lastActiveAtMs,
      transcripts: group.transcripts,
    }));
  });

  const collectCandidates = Effect.fn("AgentSessionScanner.collectCandidates")(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-settings", cause })),
    );

    const runtimeRows = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const importedByFile = Map.groupBy(
      runtimeRows.flatMap((runtime) => {
        const payload = decodeImportedTranscriptPayload(runtime.runtimePayload);
        if (Option.isNone(payload) || payload.value.cwd === undefined) return [];
        const cwd = payload.value.cwd;
        return (payload.value.importedTranscripts ?? []).map((source) => ({ cwd, source }));
      }),
      ({ source }) => `${source.providerInstanceId}\0${source.filePath}`,
    );
    const raw: Array<RawCandidate> = [];
    let truncated = false;
    let metadataTruncated = false;

    for (const source of ["claudeAgent", "codex", "pi"] as const) {
      const instances: Array<{
        readonly instanceId: ProviderInstanceId;
        readonly config: ProviderInstanceConfig;
      }> = Object.entries(settings.providerInstances)
        .filter(
          ([, instance]) => instance.driver === source && resolveProviderInstanceEnabled(instance),
        )
        .map(([instanceId, config]) => ({
          instanceId: ProviderInstanceId.make(instanceId),
          config,
        }));
      if (!Object.hasOwn(settings.providerInstances, source)) {
        const defaultInstance = {
          instanceId: ProviderInstanceId.make(source),
          config: { driver: ProviderDriverKind.make(source) },
        };
        if (resolveProviderInstanceEnabled(defaultInstance.config)) {
          instances.push(defaultInstance);
        }
      }

      instances.sort((left, right) => {
        const leftDefault = left.instanceId === source ? 0 : 1;
        const rightDefault = right.instanceId === source ? 0 : 1;
        return leftDefault - rightDefault;
      });
      const homes: Array<{ homePath: string; providerInstanceId: ProviderInstanceId }> = [];
      const seenHomes = new Set<string>();
      for (const { instanceId, config: instance } of instances) {
        const environmentHome = (name: "CLAUDE_CONFIG_DIR" | "CODEX_HOME") => {
          const configured = instance.environment?.findLast(
            (variable) => variable.name === name,
          )?.value;
          return typeof configured === "string" ? configured : hostEnvironment[name];
        };

        let homePath: string;
        if (source === "pi") {
          const environment = yield* mergeProviderInstanceEnvironment(
            instance.environment,
            hostEnvironment,
          ).pipe(Effect.provideService(HostProcess.HomeDirectory, homeDir));
          homePath = resolvePiSessionsDir(
            environment,
            piHome(environment, homeDir, platform),
            path,
          );
        } else if (source === "claudeAgent") {
          const config = decodeClaudeSettings(instance.config ?? {});
          if (Option.isNone(config)) continue;
          homePath = resolveClaudeConfigDir(
            config.value.homePath,
            environmentHome("CLAUDE_CONFIG_DIR"),
          );
        } else {
          const config = decodeCodexSettings(instance.config ?? {});
          if (Option.isNone(config)) continue;
          const codexHome = environmentHome("CODEX_HOME");
          const codexSettings =
            config.value.homePath.trim().length === 0 &&
            config.value.shadowHomePath.trim().length === 0 &&
            codexHome?.trim()
              ? { ...config.value, homePath: codexHome }
              : config.value;
          const layout = yield* resolveCodexHomeLayout(codexSettings).pipe(
            Effect.provideService(Path.Path, path),
          );
          homePath = layout.sharedHomePath;
        }

        const homeKey = `${source}\0${yield* directoryIdentity(homePath)}`;
        if (seenHomes.has(homeKey)) continue;
        seenHomes.add(homeKey);
        homes.push({ homePath, providerInstanceId: instanceId });
      }

      const transcriptCandidates: Array<TranscriptCandidate> = [];
      const discover =
        source === "claudeAgent"
          ? discoverClaudeTranscripts
          : source === "codex"
            ? discoverCodexTranscripts
            : discoverPiTranscripts;
      const shares = splitOperationBudget(MAX_DISCOVERY_OPERATIONS_PER_SOURCE, homes.length);
      const discovered: Array<{
        readonly transcripts: ReadonlyArray<TranscriptCandidate>;
        readonly truncated: boolean;
        readonly operationsUsed: number;
      }> = [];
      for (const [index, home] of homes.entries()) {
        const operationBudget = shares[index] ?? 0;
        discovered.push(
          operationBudget === 0
            ? { transcripts: [], truncated: true, operationsUsed: 0 }
            : yield* discover(home.homePath, home.providerInstanceId, operationBudget),
        );
      }
      // Budget that small homes left unused goes to the homes that ran out, which rescan with it.
      // Each takes an even split of what is still unused; a pass in which no home finishes spends
      // it all, so every repeat has fewer starved homes.
      let unused =
        MAX_DISCOVERY_OPERATIONS_PER_SOURCE -
        discovered.reduce((total, result) => total + result.operationsUsed, 0);
      let starved = discovered.flatMap((result, index) => (result.truncated ? [index] : []));
      while (unused > 0 && starved.length > 0) {
        for (const [position, index] of starved.entries()) {
          if (unused <= 0) break;
          const home = homes[index]!;
          const before = discovered[index]!.operationsUsed;
          const extra = Math.ceil(unused / (starved.length - position));
          const result = yield* discover(home.homePath, home.providerInstanceId, before + extra);
          discovered[index] = result;
          unused -= result.operationsUsed - before;
        }
        starved = starved.filter((index) => discovered[index]!.truncated);
      }
      for (const result of discovered) {
        truncated ||= result.truncated;
        transcriptCandidates.push(...result.transcripts);
      }

      transcriptCandidates.sort(
        (left, right) =>
          right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath),
      );
      if (transcriptCandidates.length > MAX_TRANSCRIPTS_PER_SOURCE) {
        truncated = true;
      }
      const selectedTranscripts = selectMetadataTranscripts(transcriptCandidates);
      const metadataBudget: MetadataReadBudget = {
        bytesRemaining: MAX_METADATA_BYTES_PER_SOURCE,
        operationsRemaining: MAX_METADATA_OPERATIONS_PER_SOURCE,
        recordsRemaining: MAX_METADATA_RECORDS_PER_SOURCE,
        truncated: false,
      };
      raw.push(
        ...(yield* groupTranscriptsByCwd(
          source,
          selectedTranscripts,
          metadataBudget,
          importedByFile,
        )),
      );
      metadataTruncated ||= metadataBudget.truncated;
    }

    return { candidates: raw, truncated: truncated || metadataTruncated, metadataTruncated };
  });

  let cachedCandidates: Effect.Success<ReturnType<typeof collectCandidates>> | null = null;

  const scan: AgentSessionScanner["Service"]["scan"] = Effect.gen(function* () {
    cachedCandidates = yield* collectCandidates();
    const { candidates: raw, truncated } = cachedCandidates;

    const merged = new Map<
      string,
      {
        path: string;
        sources: Array<AgentSessionSource>;
        threadCount: number;
        lastActiveAtMs: number | null;
        git: AgentSessionProjectGit | null;
      }
    >();
    const directoryProjects = yield* resolveDirectoryProjects(
      raw.flatMap((candidate) => {
        const expanded = expandHomePath(candidate.cwd.trim(), homeDir);
        return path.isAbsolute(expanded) ? [path.resolve(expanded)] : [];
      }),
    );

    for (const candidate of raw) {
      const expanded = expandHomePath(candidate.cwd.trim(), homeDir);
      if (!path.isAbsolute(expanded)) continue;
      const project = directoryProjects.get(path.resolve(expanded));
      if (project === undefined || project === null) continue;

      const existing = merged.get(project.key);
      if (!existing) {
        merged.set(project.key, {
          path: project.path,
          sources: [candidate.source],
          threadCount: candidate.threadCount,
          lastActiveAtMs: candidate.lastActiveAtMs,
          git: project.git,
        });
        continue;
      }
      if (!existing.sources.includes(candidate.source)) {
        existing.sources.push(candidate.source);
      }
      existing.threadCount += candidate.threadCount;
      existing.lastActiveAtMs =
        existing.lastActiveAtMs === null || candidate.lastActiveAtMs === null
          ? (existing.lastActiveAtMs ?? candidate.lastActiveAtMs)
          : Math.max(existing.lastActiveAtMs, candidate.lastActiveAtMs);
    }

    // Resolve persisted roots too; transcripts may use different symlinks to the same directory.
    const importedProjects = yield* projectStore
      .listShells()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const importedProjectsByRoot = new Map<string, (typeof importedProjects)[number]>();
    for (const project of importedProjects) {
      const projectRoot = path.resolve(expandHomePath(project.workspaceRoot, homeDir));
      importedProjectsByRoot.set(normalizeProjectPathForComparison(projectRoot), project);
      importedProjectsByRoot.set(yield* directoryIdentity(projectRoot), project);
    }

    const candidates: Array<AgentSessionProjectCandidate> = [];
    for (const [key, entry] of merged.entries()) {
      const importedProject =
        importedProjectsByRoot.get(normalizeProjectPathForComparison(entry.path)) ??
        importedProjectsByRoot.get(key);
      const candidatePath = importedProject?.workspaceRoot ?? entry.path;
      candidates.push({
        path: candidatePath,
        title: path.basename(candidatePath) || candidatePath,
        ...(importedProject === undefined ? {} : { projectId: importedProject.id }),
        sources: entry.sources,
        threadCount: entry.threadCount,
        lastActiveAt:
          entry.lastActiveAtMs === null
            ? null
            : DateTime.formatIso(DateTime.makeUnsafe(entry.lastActiveAtMs)),
        alreadyImported: importedProject !== undefined,
        git: entry.git,
      });
    }

    candidates.sort((left, right) => {
      if (left.lastActiveAt === right.lastActiveAt) return left.path.localeCompare(right.path);
      if (left.lastActiveAt === null) return 1;
      if (right.lastActiveAt === null) return -1;
      return right.lastActiveAt.localeCompare(left.lastActiveAt);
    });

    return {
      candidates,
      scannedAt: DateTime.formatIso(yield* DateTime.now),
      ...(truncated ? { truncated: true } : {}),
    };
  });

  const prepareRecentThreads = Effect.fn("AgentSessionScanner.prepareRecentThreads")(function* (
    workspaceRoot: string,
    completedSources: ReadonlyArray<AgentSessionImportSource>,
    sourcesOnly: boolean,
    verifyCompleteSource: boolean,
  ) {
    if (sourcesOnly && completedSources.length === 0) return Stream.empty;
    const root = path.resolve(expandHomePath(workspaceRoot, homeDir));
    const realRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
    if (isExcludedProjectPath(root) || isExcludedProjectPath(realRoot)) return Stream.empty;
    const rootIdentity = yield* directoryIdentity(root);
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const cutoffMs = nowMs - RECENT_THREAD_WINDOW_MS;

    // Imports recorded since a budget-truncated collection can free budget for transcripts it cut off.
    const collection =
      cachedCandidates === null || cachedCandidates.metadataTruncated
        ? yield* collectCandidates()
        : cachedCandidates;
    cachedCandidates = collection;
    const liveHomes = new Map<ProviderInstanceId, string>();
    if (sourcesOnly) {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-settings", cause }),
        ),
      );
      for (const source of completedSources) {
        if (source.provider !== "codex" || liveHomes.has(source.providerInstanceId)) continue;
        const instance = settings.providerInstances[source.providerInstanceId];
        const config = decodeCodexSettings(instance?.config ?? {});
        if (Option.isNone(config)) continue;
        const configuredHome = instance?.environment?.findLast(
          (entry) => entry.name === "CODEX_HOME",
        )?.value;
        const environmentHome =
          typeof configuredHome === "string" ? configuredHome : hostEnvironment.CODEX_HOME;
        const configured =
          config.value.homePath.trim().length === 0 &&
          config.value.shadowHomePath.trim().length === 0 &&
          environmentHome?.trim()
            ? { ...config.value, homePath: environmentHome }
            : config.value;
        const layout = yield* resolveCodexHomeLayout(configured).pipe(
          Effect.provideService(Path.Path, path),
        );
        liveHomes.set(source.providerInstanceId, layout.sharedHomePath);
      }
    }
    const candidates: ReadonlyArray<RawCandidate> = sourcesOnly
      ? completedSources.map((source) => ({
          cwd: workspaceRoot,
          source: source.provider,
          providerInstanceId: source.providerInstanceId,
          homePath: liveHomes.get(source.providerInstanceId) ?? path.dirname(source.filePath),
          threadCount: 1,
          lastActiveAtMs: source.mtimeMs,
          transcripts: [{ filePath: source.filePath, mtimeMs: nowMs }],
        }))
      : collection.candidates;

    // The scan counts a linked worktree's sessions toward its main checkout, so import them with it.
    const candidateDirectories = candidates.flatMap((candidate) => {
      const expanded = expandHomePath(candidate.cwd.trim(), homeDir);
      return path.isAbsolute(expanded) ? [path.resolve(expanded)] : [];
    });
    const directoryProjects = yield* resolveDirectoryProjects(candidateDirectories);
    const belongsToRoot = Effect.fn("AgentSessionScanner.belongsToRoot")(function* (
      resolved: string,
    ) {
      if ((yield* directoryIdentity(resolved)) === rootIdentity) return true;
      if (!directoryProjects.has(resolved)) {
        const project = (yield* resolveDirectoryProjects([resolved])).get(resolved) ?? null;
        directoryProjects.set(resolved, project);
      }
      return directoryProjects.get(resolved)?.key === rootIdentity;
    });
    const worktreesByDirectory = new Map<string, { path: string; branch: string | null } | null>();
    const rootWorktree = Effect.fn("AgentSessionScanner.rootWorktree")(function* (
      resolved: string,
    ) {
      const known = worktreesByDirectory.get(resolved);
      if (known !== undefined) return known;
      const gitDir =
        (yield* directoryIdentity(resolved)) === rootIdentity
          ? null
          : (directoryProjects.get(resolved)?.worktreeGitDir ?? null);
      let worktree: { path: string; branch: string | null } | null = null;
      if (gitDir !== null) {
        const headPath = path.join(gitDir, "HEAD");
        const head = (yield* readGitFiles([headPath])).get(headPath) ?? "";
        worktree = {
          path: resolved,
          branch: /^ref: refs\/heads\/(.+)$/.exec(head.trim())?.[1] ?? null,
        };
      }
      worktreesByDirectory.set(resolved, worktree);
      return worktree;
    });

    const eligibleTranscripts: Array<{
      readonly candidate: RawCandidate;
      readonly transcript: RawCandidate["transcripts"][number] & { readonly mtimeMs: number };
    }> = [];
    for (const candidate of candidates) {
      const expanded = expandHomePath(candidate.cwd.trim(), homeDir);
      if (!path.isAbsolute(expanded)) continue;
      const resolved = path.resolve(expanded);
      if (!(yield* belongsToRoot(resolved))) continue;

      for (const transcript of candidate.transcripts) {
        if (
          transcript.mtimeMs === null ||
          transcript.mtimeMs < cutoffMs ||
          transcript.mtimeMs > nowMs
        ) {
          continue;
        }
        eligibleTranscripts.push({
          candidate,
          transcript: { ...transcript, mtimeMs: transcript.mtimeMs },
        });
      }
    }

    eligibleTranscripts.sort((left, right) => {
      if (left.transcript.mtimeMs !== right.transcript.mtimeMs) {
        return right.transcript.mtimeMs - left.transcript.mtimeMs;
      }
      return left.transcript.filePath.localeCompare(right.transcript.filePath);
    });

    const completedByFile = Map.groupBy(
      completedSources,
      (source) => `${source.providerInstanceId}\0${source.filePath}`,
    );
    const importedSessions = new Set<string>();
    const codexThreadNamesByHome = new Map<string, ReadonlyMap<string, string>>();
    let bytesRemaining = MAX_IMPORT_BYTES;
    let transcriptsRemaining = MAX_IMPORT_TRANSCRIPTS;
    const liveRecordBudget = sourcesOnly ? { remaining: MAX_IMPORT_RECORDS } : undefined;
    const codexRolloutPaths = new Map<ProviderInstanceId, ReadonlyMap<string, string>>();
    const codexRolloutPath = (providerInstanceId: ProviderInstanceId, rolloutId: string) => {
      let paths = codexRolloutPaths.get(providerInstanceId);
      if (paths === undefined) {
        paths = new Map(
          (sourcesOnly ? collection.candidates : candidates).flatMap((candidate) =>
            candidate.source === "codex" &&
            (candidate.providerInstanceId === providerInstanceId ||
              (sourcesOnly && candidate.homePath === liveHomes.get(providerInstanceId)))
              ? candidate.transcripts.flatMap((transcript) => {
                  const match = CODEX_ROLLOUT_ID_PATTERN.exec(transcript.filePath);
                  const id = match?.[2] ?? match?.[1];
                  return id === undefined ? [] : [[id, transcript.filePath] as const];
                })
              : [],
          ),
        );
        codexRolloutPaths.set(providerInstanceId, paths);
      }
      return paths.get(rolloutId);
    };
    // Reads the prefixes a rewound rollout inherits, oldest first. Without all of
    // them the rollout is imported on its own, as before.
    const readCodexHistoryBase = Effect.fn("AgentSessionScanner.readCodexHistoryBase")(function* (
      providerInstanceId: ProviderInstanceId,
      records: ReadonlyArray<DecodedTranscriptRecord>,
      historyBytes: number,
    ) {
      const prefixes: Array<ReadonlyArray<DecodedTranscriptRecord>> = [];
      const visited = new Set<string>();
      for (let base = codexHistoryBase(records); base !== undefined;) {
        const filePath = visited.has(base.thread_id)
          ? undefined
          : codexRolloutPath(providerInstanceId, base.thread_id);
        if (filePath === undefined || base.end_byte_offset > bytesRemaining) return null;
        visited.add(base.thread_id);
        const stats = yield* statOption(filePath);
        if (Option.isNone(stats) || stats.value.type !== "File") return null;
        bytesRemaining -= base.end_byte_offset;
        const inherited = yield* readTranscript(
          filePath,
          yield* identityAt(filePath, stats.value),
          "codex",
          { endByteOffset: base.end_byte_offset, historyBytes },
          sourcesOnly,
          liveRecordBudget,
        );
        if (inherited === null) return null;
        historyBytes = inherited.historyBytes;
        // The rollout's own session_meta names the thread; inherited ones may name a fork parent.
        prefixes.unshift(inherited.records.filter((record) => record.type !== "session_meta"));
        base = codexHistoryBase(inherited.records);
      }
      return prefixes.flat();
    });
    return Stream.fromIteratorSucceed(eligibleTranscripts.values(), 1).pipe(
      Stream.mapEffect(({ candidate, transcript }) =>
        Effect.gen(function* () {
          const completed = completedByFile.get(
            `${candidate.providerInstanceId}\0${transcript.filePath}`,
          );
          if (completed === undefined && (transcriptsRemaining === 0 || bytesRemaining === 0)) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          const stats = yield* statOption(transcript.filePath);
          if (Option.isNone(stats) || stats.value.type !== "File") {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          const identity = yield* identityAt(transcript.filePath, stats.value).pipe(
            Effect.orElseSucceed(() => null),
          );
          if (identity === null) return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          const completedSource = completed?.find(
            (source) =>
              source.provider === candidate.source && sameTranscriptIdentity(source, identity),
          );
          const waitingSource = completed?.find((source) => source.provider === candidate.source);
          const pendingWrite = incompleteLiveReads.get(transcript.filePath);
          if (
            !verifyCompleteSource &&
            sourcesOnly &&
            waitingSource !== undefined &&
            pendingWrite !== undefined &&
            sameTranscriptIdentity(pendingWrite, identity)
          ) {
            return Option.some<AgentSessionRecentThread>({
              _tag: "AlreadyImported",
              source: waitingSource,
            });
          }
          if (!verifyCompleteSource && completedSource !== undefined) {
            const sessionKey = `${completedSource.providerInstanceId}\0${completedSource.providerSessionId}`;
            if (importedSessions.has(sessionKey)) return Option.none<AgentSessionRecentThread>();
            importedSessions.add(sessionKey);
            return Option.some<AgentSessionRecentThread>({
              _tag: "AlreadyImported",
              source: completedSource,
            });
          }
          if (
            transcriptsRemaining === 0 ||
            identity.size > MAX_IMPORTED_TRANSCRIPT_BYTES ||
            identity.size > bytesRemaining
          ) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          transcriptsRemaining -= 1;
          bytesRemaining -= identity.size;
          const snapshot = yield* readTranscript(
            transcript.filePath,
            identity,
            candidate.source,
            undefined,
            sourcesOnly,
            liveRecordBudget,
          );
          if (snapshot === null || (verifyCompleteSource && !snapshot.complete)) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          if (sourcesOnly) {
            if (snapshot.complete) incompleteLiveReads.delete(transcript.filePath);
            else incompleteLiveReads.set(transcript.filePath, identity);
          }

          if (Option.isNone(snapshot.cwd)) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          const expandedCwd = expandHomePath(
            projectCwd(snapshot.cwd.value, transcript.projectRoots).trim(),
            homeDir,
          );
          if (!path.isAbsolute(expandedCwd) || !(yield* belongsToRoot(path.resolve(expandedCwd)))) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          const worktree = yield* rootWorktree(path.resolve(expandedCwd));

          const inheritedRecords =
            candidate.source === "codex"
              ? yield* readCodexHistoryBase(
                  candidate.providerInstanceId,
                  snapshot.records,
                  snapshot.historyBytes,
                )
              : null;
          if (sourcesOnly && candidate.source === "codex" && inheritedRecords === null) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          const parsedThread = parseAgentSessionRecords(
            {
              source: candidate.source,
              providerInstanceId: candidate.providerInstanceId,
              fallbackSessionId: path.basename(
                transcript.filePath,
                isCompressedTranscript(transcript.filePath)
                  ? COMPRESSED_TRANSCRIPT_SUFFIX
                  : ".jsonl",
              ),
              lastActiveAtMs: identity.birthtimeMs ?? identity.mtimeMs ?? transcript.mtimeMs,
              fullHistory: sourcesOnly,
            },
            inheritedRecords === null
              ? snapshot.records
              : [...inheritedRecords, ...snapshot.records],
            snapshot.claudeFields,
            snapshot.droppedMessageCount,
          );
          if (parsedThread === "empty") {
            // null means an unreadable history base, which may hold the conversation.
            if (candidate.source === "codex" && inheritedRecords === null) {
              return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
            }
            // Never recorded as imported, so charging them would starve real sessions every run.
            transcriptsRemaining += 1;
            return Option.none<AgentSessionRecentThread>();
          }
          if (parsedThread === null) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          if (
            sourcesOnly &&
            !completed?.some(
              (source) =>
                source.providerSessionId === parsedThread.providerSessionId &&
                source.provider === parsedThread.source,
            )
          ) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          let savedTitle: string | undefined;
          if (candidate.source === "codex") {
            const names =
              codexThreadNamesByHome.get(candidate.homePath) ??
              (yield* readCodexThreadNames(candidate.homePath));
            codexThreadNamesByHome.set(candidate.homePath, names);
            savedTitle = names.get(parsedThread.providerSessionId);
          }

          const source: AgentSessionImportSource = {
            ...identity,
            // Retry an unfinished trailing record even when its stat is unchanged.
            ...(snapshot.complete ? {} : { mtimeMs: -1 }),
            provider: parsedThread.source,
            providerInstanceId: parsedThread.providerInstanceId,
            providerSessionId: parsedThread.providerSessionId,
          };
          const sessionKey = `${parsedThread.providerInstanceId}\0${parsedThread.providerSessionId}`;
          if (importedSessions.has(sessionKey)) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Duplicate", source });
          }
          importedSessions.add(sessionKey);
          return Option.some<AgentSessionRecentThread>({
            _tag: "Importable",
            thread:
              savedTitle === undefined ? parsedThread : { ...parsedThread, title: savedTitle },
            source,
            worktree,
          });
        }).pipe(importReadLock.withPermits(1)),
      ),
      Stream.map(Option.toArray),
      Stream.flattenIterable,
    );
  });

  const recentThreads: AgentSessionScanner["Service"]["recentThreads"] = (
    workspaceRoot,
    completedSources = [],
    sourcesOnly = false,
    verifyCompleteSource = false,
  ) =>
    Stream.unwrap(
      prepareRecentThreads(workspaceRoot, completedSources, sourcesOnly, verifyCompleteSource),
    ).pipe(
      Stream.mapError((cause) =>
        isAgentSessionScanError(cause)
          ? cause
          : new AgentSessionScanError({ operation: "read-projects", cause }),
      ),
    );

  return AgentSessionScanner.of({ scan, recentThreads });
});

export const layer = Layer.effect(AgentSessionScanner, make).pipe(
  Layer.provide(ProcessRunner.layer),
);
