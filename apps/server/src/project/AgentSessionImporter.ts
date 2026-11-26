import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  isRuntimeModeAbove,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionScanError,
  AgentSessionSource,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type AgentSessionImportSource,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@j1code/contracts";
import { modelSelectionsEqual } from "@j1code/shared/model";
import { normalizeProjectPathForComparison } from "@j1code/shared/path";
import { resolveProjectSettings } from "@j1code/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@j1code/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as ServerSettings from "../serverSettings.ts";
import { agentHistorySourceMessageId } from "./AgentSessionHistory.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const isProjectionStoreThreadNotFoundError = Schema.is(
  ProjectionStore.ProjectionStoreThreadNotFoundError,
);

const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const importCursor = Schema.is(
  Schema.Struct({ threadId: Schema.String, resume: Schema.optionalKey(Schema.String) }),
);

function isTranscriptExtension(saved: AgentSessionImportSource, source: AgentSessionImportSource) {
  return (
    saved.provider === source.provider &&
    saved.providerInstanceId === source.providerInstanceId &&
    saved.providerSessionId === source.providerSessionId &&
    saved.filePath === source.filePath &&
    (saved.fileId === undefined || saved.fileId === source.fileId) &&
    saved.device === source.device &&
    String(saved.inode) === String(source.inode) &&
    saved.birthtimeMs === source.birthtimeMs &&
    saved.mtimeMs !== -1 &&
    source.mtimeMs !== -1 &&
    (saved.mtimeMs === null || (source.mtimeMs !== null && source.mtimeMs >= saved.mtimeMs)) &&
    source.size >= saved.size
  );
}

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedError<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' belongs to project '${this.actualProjectId}', not '${this.expectedProjectId}'.`;
  }
}

class AgentSessionThreadModifiedError extends Schema.TaggedError<AgentSessionThreadModifiedError>()(
  "AgentSessionThreadModifiedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' already contains non-imported activity.`;
  }
}

export class AgentSessionFirstPromptError extends Schema.TaggedError<AgentSessionFirstPromptError>()(
  "AgentSessionFirstPromptError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "The imported session is busy, unavailable, or has changed. Its first prompt was not sent.";
  }
}

// ACP imports read the history while holding the session-mutation lock, and an agent can
// leave session/resume or initialize unanswered. Longer than session/load's own deadline.
const NATIVE_HISTORY_READ_TIMEOUT = "2 minutes";

/**
 * Whether a thread bound to a native session still lacks its native history.
 * Once a turn has run, the native session also holds that turn's messages, so
 * its history can no longer be imported as run-less items.
 */
export function isNativeHistoryPending(input: {
  readonly historyOrigin: OrchestrationV2AppThread["historyOrigin"];
  readonly hasRun: boolean;
}): boolean {
  return input.historyOrigin !== "v1_import" && !input.hasRun;
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

type HistoryMessage = Omit<AgentSessionScanner.AgentSessionThreadMessage, "role"> & {
  readonly role: AgentSessionScanner.AgentSessionThreadMessage["role"] | "reasoning";
};

function importedMessageId(threadId: ThreadId, index: number): MessageId {
  return MessageId.make(`${threadId}:${String(index).padStart(6, "0")}`);
}

/** Check the persisted prefix under the provider batch lock before appending any events. */
export function matchesImportedHistoryPrefix(
  threadId: ThreadId,
  saved: ReadonlyArray<Pick<
    OrchestrationV2ConversationMessage,
    "id" | "runId" | "creationSource" | "role" | "text" | "createdAt" | "streaming"
  >>,
  incoming: ReadonlyArray<Pick<HistoryMessage, "role" | "text" | "sourceMessageId" | "createdAt">>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem> = [],
): boolean {
  // Prefer saved turn-item order. Native transcripts can contain equal or backwards timestamps.
  const ordinals = new Map<MessageId, number>();
  for (const item of turnItems) {
    if (item.type === "user_message" || item.type === "assistant_message") {
      ordinals.set(item.messageId, item.ordinal);
    }
  }
  const ordered = saved.every(({ id }) => ordinals.has(id))
    ? saved.toSorted((left, right) => ordinals.get(left.id)! - ordinals.get(right.id)!)
    : saved;
  const seen = new Set<MessageId>();
  return ordered.every((message, index) => {
    const candidate = incoming[index];
    if (candidate === undefined || seen.has(message.id)) return false;
    seen.add(message.id);
    const matchingId = message.id === importedMessageId(threadId, index) ||
      (candidate.sourceMessageId !== undefined &&
        message.id === agentHistorySourceMessageId(threadId, candidate.sourceMessageId));
    const incomingTime = DateTime.make(candidate.createdAt);
    return matchingId && message.runId === null && !message.streaming &&
      message.creationSource === "server" && message.role === candidate.role &&
      message.text === candidate.text && Option.isSome(incomingTime) &&
      DateTime.toEpochMillis(message.createdAt) === DateTime.toEpochMillis(incomingTime.value);
  });
}

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: HistoryMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = importedMessageId(input.threadId, input.index);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItemEvent = (payload: OrchestrationV2TurnItem): OrchestrationV2DomainEvent => ({
    id: EventId.make(turnItemId),
    type: "turn-item.updated",
    threadId: input.threadId,
    occurredAt: at,
    payload,
  });
  if (input.message.role === "reasoning") {
    return [
      turnItemEvent({ ...common, type: "reasoning", text: input.message.text, streaming: false }),
    ];
  }
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    turnItemEvent(turnItem),
  ];
}

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const ceiling = settingsService.managedPolicy?.limits?.maxRuntimeMode;
  const importRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
    sourcesOnly = false,
    eligibleThreadIds?: ReadonlySet<ThreadId>,
    lockedFirstPromptThreadId?: ThreadId,
  ) {
    const homeImport = input.projectId === Orchestrator.HOME_PROJECT_ID;
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (
      input.expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
    ) {
      return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
    }
    // Imports run in full access, except under a policy ceiling: then in the project's default,
    // which the policy keeps under it, so imported threads never sit above the ceiling.
    const runtimeMode =
      ceiling === undefined
        ? DEFAULT_RUNTIME_MODE
        : yield* settingsService.getSettings.pipe(
            Effect.mapError(
              (cause) => new AgentSessionScanError({ operation: "read-settings", cause }),
            ),
            Effect.map((settings) => {
              const mode = resolveProjectSettings(settings, input.projectId, project).settings
                .defaultRuntimeMode;
              return isRuntimeModeAbove(mode, ceiling) ? ceiling : mode;
            }),
          );
    const runtimeRows = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    // The thread's project owns its transcripts: a linked worktree import records the worktree as cwd.
    const completedSources = (yield* Effect.forEach(runtimeRows, (runtime) => {
      if (sourcesOnly && eligibleThreadIds !== undefined && !eligibleThreadIds.has(runtime.threadId)) {
        return Effect.succeed([]);
      }
      const imported = AgentSessionScanner.decodeImportedTranscriptPayload(
        runtime.runtimePayload,
      ).pipe(Option.flatMapNullishOr((payload) => payload.importedTranscripts));
      if (Option.isNone(imported) || imported.value.length === 0) return Effect.succeed([]);
      return orchestrator.getThreadRecords(runtime.threadId, []).pipe(
        Effect.map(({ thread }) => (thread.projectId === input.projectId ? imported.value : [])),
        Effect.catch((cause) =>
          isProjectionStoreThreadNotFoundError(cause.cause)
            ? Effect.succeed([])
            : Effect.fail(new AgentSessionScanError({ operation: "read-projects", cause })),
        ),
      );
    })).flat();
    let outcomes = scanner.recentThreads(
      project.workspaceRoot, completedSources, sourcesOnly, lockedFirstPromptThreadId !== undefined,
    );
    if (lockedFirstPromptThreadId !== undefined) {
      const candidates = yield* outcomes.pipe(Stream.take(2), Stream.runCollect);
      const candidate = candidates[0];
      if (candidates.length !== 1 || candidate?._tag !== "Importable") {
        return { importedCount: 0, skippedCount: 1 } satisfies AgentSessionImportResult;
      }
      outcomes = Stream.succeed(candidate);
    }
    const importedThreadIds = new Set<ThreadId>();
    let importedCount = 0;
    let skippedCount = 0;

    yield* Stream.runForEach(outcomes, (outcome) =>
      Effect.gen(function* () {
        if (outcome._tag === "Skipped") {
          skippedCount += 1;
          return;
        }
        const source = outcome.source;
        const threadId = ThreadId.make(
          `import:${source.providerInstanceId}:${source.providerSessionId}`,
        );
        if (
          source.mtimeMs === -1 ||
          (sourcesOnly && eligibleThreadIds !== undefined && !eligibleThreadIds.has(threadId))
        ) {
          skippedCount += 1;
          return;
        }
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          return;
        }
        if (outcome._tag === "Duplicate") {
          if (importedThreadIds.has(threadId)) {
            yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(Effect.ignore);
          }
          return;
        }

        const importThread = Effect.gen(function* () {
          const thread = outcome.thread;
          if (
            thread.source !== source.provider ||
            thread.providerInstanceId !== source.providerInstanceId ||
            thread.providerSessionId !== source.providerSessionId
          ) return false;
          if (
            thread.source === "claudeAgent" &&
            !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
          ) {
            return yield* new AgentSessionUnresumableSessionError({
              source: thread.source,
              providerSessionId: thread.providerSessionId,
            });
          }
          const driver = ProviderDriverKind.make(thread.source);
          // Pi resumes by session file path; its session UUID only names the thread.
          const nativeThreadId =
            thread.source === "pi" ? source.filePath : thread.providerSessionId;
          const cwd = outcome.worktree?.path ?? project.workspaceRoot;
          const resumeCursor = thread.source === "claudeAgent"
            ? { threadId, resume: thread.providerSessionId }
            : { threadId: nativeThreadId };
          const persistRuntime = runtimes.upsert(
            {
              threadId,
              providerName: driver,
              providerInstanceId: thread.providerInstanceId,
              adapterKey: driver,
              runtimeMode,
              status: "stopped",
              lastSeenAt: thread.updatedAt,
              resumeCursor,
              runtimePayload: { cwd },
            },
            { onConflict: "ignore" },
          );
          const existing = yield* eventSink.withProviderBatch(Effect.gen(function* () {
              const current = yield* orchestrator
                .getThreadRecords(threadId, [
                  "messages",
                  "providerThreads",
                  "runs",
                  "runtimeRequests",
                  "plans",
                  "turnItems",
                ])
                .pipe(
                  Effect.asSome,
                  Effect.catchIf(
                    (cause) => isProjectionStoreThreadNotFoundError(cause.cause),
                    () => Effect.succeedNone,
                  ),
                );
              if (Option.isNone(current)) return "new" as const;
              const {
                thread: saved,
                messages,
                providerThreads,
                runs,
                runtimeRequests,
                plans,
                turnItems,
              } = current.value;
              if (saved.projectId !== input.projectId) {
                return yield* new AgentSessionThreadProjectConflictError({
                  threadId,
                  expectedProjectId: input.projectId,
                  actualProjectId: saved.projectId,
                });
              }
              if (saved.historyOrigin !== "v1_import" || saved.bot !== undefined ||
                  saved.archivedAt !== null || saved.deletedAt !== null ||
                  saved.providerInstanceId !== thread.providerInstanceId ||
                  saved.modelSelection.instanceId !== thread.providerInstanceId ||
                  runs.length !== 0 || runtimeRequests.length !== 0) {
                return yield* new AgentSessionThreadModifiedError({ threadId });
              }
              const owner = providerThreads.find(({ id }) => id === saved.activeProviderThreadId);
              if (owner === undefined || owner.appThreadId !== threadId ||
                  owner.providerInstanceId !== thread.providerInstanceId || owner.driver !== driver ||
                  owner.nativeThreadRef?.driver !== driver ||
                  owner.nativeThreadRef.nativeId !== nativeThreadId ||
                  owner.providerSessionId !== null || owner.status !== "idle" ||
                  (owner.pendingBackgroundTasks?.length ?? 0) !== 0) return false;

              if (!matchesImportedHistoryPrefix(threadId, messages, thread.messages, turnItems)) return false;
              const binding = Option.getOrUndefined(yield* runtimes.getByThreadId({ threadId }));
              if (binding !== undefined &&
                  (binding.providerName !== driver || binding.adapterKey !== driver ||
                    binding.providerInstanceId !== thread.providerInstanceId ||
                    binding.status !== "stopped" || !importCursor(binding.resumeCursor) ||
                    binding.resumeCursor.threadId !== resumeCursor.threadId ||
                    binding.resumeCursor.resume !== resumeCursor.resume)) return false;
              const prior = AgentSessionScanner.decodeImportedTranscriptPayload(binding?.runtimePayload)
                .pipe(Option.getOrUndefined);
              if (lockedFirstPromptThreadId !== undefined) {
                const recorded = prior?.importedTranscripts?.find(({ filePath }) => filePath === source.filePath);
                if (owner.ownerNodeId !== null || owner.nativeThreadRef?.strength !== "strong" ||
                    binding === undefined || recorded === undefined || recorded.mtimeMs === -1 ||
                    !isTranscriptExtension(recorded, source) ||
                    prior?.cwd === undefined ||
                    normalizeProjectPathForComparison(prior.cwd) !== normalizeProjectPathForComparison(cwd) ||
                    normalizeProjectPathForComparison(saved.worktreePath ?? project.workspaceRoot) !==
                      normalizeProjectPathForComparison(cwd) ||
                    plans.some((plan) => plan.kind === "proposed_plan" && plan.status === "active") ||
                    messages.length === 0 || thread.omittedMessageCount !== 0) {
                  return false;
                }
                const latestProject = yield* projects.getById(input.projectId);
                if (Option.isNone(latestProject) ||
                    latestProject.value.archivedAt != null || latestProject.value.deletedAt != null ||
                    normalizeProjectPathForComparison(latestProject.value.workspaceRoot) !==
                      normalizeProjectPathForComparison(project.workspaceRoot)) return false;
              }
              if (messages.length === thread.messages.length) {
                const recordedSource = prior?.importedTranscripts?.find(({ filePath }) =>
                  filePath === source.filePath);
                if (recordedSource !== undefined && recordedSource.mtimeMs !== -1 &&
                    !isTranscriptExtension(recordedSource, source)) return false;
                // Keep the upstream repair for a new import whose runtime write failed.
                yield* persistRuntime;
                yield* runtimes.recordImportedTranscript({ threadId, source });
                return null;
              }

              if (
                messages.length === 0 || thread.omittedMessageCount !== 0 ||
                owner.nativeThreadRef?.strength !== "strong" ||
                turnItems.some((item) =>
                  (item.type !== "user_message" && item.type !== "assistant_message") ||
                  item.ordinal > messages.length) ||
                prior?.cwd === undefined ||
                normalizeProjectPathForComparison(prior.cwd) !== normalizeProjectPathForComparison(cwd) ||
                !prior.importedTranscripts?.some((previous) => isTranscriptExtension(previous, source))
              ) return false;
              const latestProject = yield* projects.getById(input.projectId);
              if (Option.isNone(latestProject) ||
                  normalizeProjectPathForComparison(latestProject.value.workspaceRoot) !==
                    normalizeProjectPathForComparison(project.workspaceRoot)) return false;
              const suffix = thread.messages.slice(messages.length);
              const events = suffix.flatMap((message, offset) =>
                messageEvents({ threadId, index: messages.length + offset, message }));
              const committed = yield* eventSink.write({ unlessNativeThreadOwned: owner, events });
              if (committed.length !== events.length) {
                return yield* new AgentSessionThreadModifiedError({ threadId });
              }
              yield* runtimes.recordImportedTranscript({ threadId, source });
              return null;
          }));
          if (existing !== "new") {
            if (existing === null) importedThreadIds.add(threadId);
            return existing;
          }
          if (sourcesOnly) return false;

          const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
          const providerThreadId = idAllocator.derive.providerThread({
            driver,
            providerInstanceId: thread.providerInstanceId,
            nativeThreadId,
          });
          const createdAt = dateTime(thread.createdAt);
          const updatedAt = dateTime(thread.updatedAt);
          // Scanner metadata reflects the source file's mtime. Historical settlement reflects
          // the latest imported message, even when transcript timestamps are out of order.
          const settledAt = thread.messages.reduce<DateTime.Utc | undefined>((latest, message) => {
            const at = dateTime(message.createdAt);
            return latest === undefined || DateTime.toEpochMillis(at) > DateTime.toEpochMillis(latest)
              ? at
              : latest;
          }, undefined) ?? updatedAt;
          const appThread: OrchestrationV2AppThread = {
            createdBy: "system",
            creationSource: "server",
            id: threadId,
            projectId: input.projectId,
            title: thread.title.trim() === "" ? "Untitled thread" : thread.title,
            providerInstanceId: thread.providerInstanceId,
            modelSelection: { instanceId: thread.providerInstanceId, model },
            runtimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: outcome.worktree?.branch ?? null,
            worktreePath: outcome.worktree?.path ?? null,
            linkedPullRequest: null,
            branchPullRequest: null,
            activeProviderThreadId: providerThreadId,
            historyOrigin: "v1_import",
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: threadId,
            },
            forkedFrom: null,
            createdAt,
            updatedAt: settledAt,
            archivedAt: null,
            settledOverride: "settled",
            settledAt,
            unsettledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            activeOrderKey: null,
            lastVisitedAt: null,
            deletedAt: null,
          };
          const providerThread: OrchestrationV2ProviderThread = {
            id: providerThreadId,
            driver,
            providerInstanceId: thread.providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver,
              nativeId: nativeThreadId,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            createdAt,
            updatedAt,
          };

          const writeImport = eventSink.write({
            unlessNativeThreadOwned: providerThread,
            events: [
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
                type: "thread.created",
                threadId,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: createdAt,
                payload: appThread,
              },
              ...(thread.omittedMessageCount > 0
                ? [
                    {
                      id: EventId.make(`${IMPORT_EVENT_PREFIX}:history-truncated:${threadId}`),
                      type: "turn-item.updated" as const,
                      threadId,
                      occurredAt: createdAt,
                      payload: {
                        id: TurnItemId.make(`${IMPORT_EVENT_PREFIX}:history-truncated:${threadId}`),
                        threadId,
                        runId: null,
                        nodeId: null,
                        providerThreadId: null,
                        providerTurnId: null,
                        nativeItemRef: null,
                        parentItemId: null,
                        ordinal: 0,
                        status: "completed" as const,
                        title: null,
                        startedAt: createdAt,
                        completedAt: createdAt,
                        updatedAt: createdAt,
                        type: "system_notice" as const,
                        message: `${thread.omittedMessageCount} earlier ${thread.omittedMessageCount === 1 ? "message was" : "messages were"} not imported. This thread keeps the first user message and the most recent history. The original session transcript is unchanged.`,
                      },
                    },
                  ]
                : []),
              ...thread.messages.flatMap((message, index) =>
                messageEvents({ threadId, index, message }),
              ),
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}`),
                type: "provider-thread.updated",
                threadId,
                driver,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: settledAt,
                payload: providerThread,
              },
            ],
          }).pipe(Effect.flatMap((committed) => Effect.gen(function* () {
            if (committed.length === 0) return null;
            yield* persistRuntime;
            yield* runtimes.recordImportedTranscript({ threadId, source });
            return true;
          })));
          if (!homeImport) return yield* writeImport;
          return yield* eventSink.withProviderBatch(Effect.gen(function* () {
            if (yield* projections.hasUndeletedListedProjectThread(input.projectId)) return false;
            return yield* writeImport;
          }));
        });
        const lockedImport = lockedFirstPromptThreadId === threadId
          ? importThread
          : threadCommands.withLock(threadId, importThread);
        // First-prompt and background refresh can only append to an existing thread.
        const admission = homeImport && !sourcesOnly
          ? threadCommands.withHomeAdmissionLock(lockedImport)
          : lockedImport;
        const imported = yield* admission.pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not import an agent session", {
              provider: outcome.thread.source,
              sessionId: outcome.thread.providerSessionId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (imported === true) {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else if (imported === false) {
          skippedCount += 1;
        }
      }),
    );

    if (lockedFirstPromptThreadId !== undefined && !importedThreadIds.has(lockedFirstPromptThreadId)) {
      skippedCount += 1;
    }
    return { importedCount, skippedCount } satisfies AgentSessionImportResult;
  });

  /**
   * Loading a native session replays its history only into the adapter's own
   * snapshot, so copy that snapshot into the thread as run-less history. The
   * `v1_import` origin keeps it in forks and marks the import done, so a call
   * after a failed read repairs the thread and any later call does nothing.
   */
  const importNativeHistory = Effect.fn("importNativeHistoryV2")(function* (input: {
    readonly threadId: ThreadId;
    readonly workspaceRoot: string;
  }) {
    const pendingThread = Effect.map(
      orchestrator.getThreadRecords(input.threadId, ["providerThreads", "runs"]),
      (records) =>
        isNativeHistoryPending({
          historyOrigin: records.thread.historyOrigin,
          hasRun: records.runs.length > 0,
        })
          ? records
          : null,
    );
    const records = yield* pendingThread;
    if (records === null) return 0;
    const { thread, providerThreads } = records;
    const providerThread = providerThreads.find((candidate) =>
      candidate.id === thread.activeProviderThreadId &&
      candidate.appThreadId === input.threadId && candidate.ownerNodeId === null &&
      candidate.providerInstanceId === thread.providerInstanceId &&
      candidate.providerInstanceId === thread.modelSelection.instanceId &&
      candidate.nativeThreadRef?.strength === "strong" &&
      candidate.nativeThreadRef.driver === candidate.driver,
    );
    const nativeThreadId = providerThread?.nativeThreadRef?.nativeId;
    if (thread.bot !== undefined || thread.archivedAt !== null || thread.deletedAt !== null ||
        providerThread === undefined || nativeThreadId == null) return 0;

    const projectMatches = projects.getById(thread.projectId).pipe(
      Effect.map((project) => Option.isSome(project) &&
        project.value.archivedAt == null && project.value.deletedAt == null &&
        normalizeProjectPathForComparison(project.value.workspaceRoot) ===
          normalizeProjectPathForComparison(input.workspaceRoot)),
    );
    if (!(yield* projectMatches))
      return yield* new AgentSessionImportProjectChangedError({ projectId: thread.projectId });

    // The lock preserves unrelated thread edits while checking that the loaded history still belongs here.
    const commit = (messages: ReadonlyArray<HistoryMessage>) =>
      threadCommands.withLock(
        input.threadId,
        Effect.gen(function* () {
          const current = yield* pendingThread;
          if (current === null) return 0;
          const saved = current.thread;
          const owner = current.providerThreads.find((candidate) => candidate.id === providerThread.id);
          if (saved.projectId !== thread.projectId || saved.bot !== undefined ||
              saved.archivedAt !== null || saved.deletedAt !== null ||
              saved.worktreePath !== thread.worktreePath || saved.runtimeMode !== thread.runtimeMode ||
              saved.interactionMode !== thread.interactionMode ||
              saved.providerInstanceId !== thread.providerInstanceId ||
              !modelSelectionsEqual(saved.modelSelection, thread.modelSelection) ||
              saved.activeProviderThreadId !== providerThread.id ||
              owner?.appThreadId !== input.threadId || owner.ownerNodeId !== null ||
              owner.providerInstanceId !== providerThread.providerInstanceId ||
              owner.providerSessionId !== providerThread.providerSessionId || owner.driver !== providerThread.driver ||
              owner.nativeThreadRef?.driver !== providerThread.driver ||
              owner.nativeThreadRef.strength !== "strong" || owner.nativeThreadRef.nativeId !== nativeThreadId ||
              !(yield* projectMatches)) return 0;
          yield* eventSink.write({
            events: [
              ...messages.flatMap((message, index) =>
                messageEvents({ threadId: input.threadId, index, message }),
              ),
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${input.threadId}:native-history`),
                type: "thread.metadata-updated",
                threadId: input.threadId,
                providerInstanceId: current.thread.providerInstanceId,
                occurredAt: yield* DateTime.now,
                payload: { ...current.thread, historyOrigin: "v1_import" },
              },
            ],
          });
          return messages.length;
        }),
      );
    const providerSessionId = yield* idAllocator.allocate.providerSession({
      providerInstanceId: providerThread.providerInstanceId,
      threadId: input.threadId,
    });
    // The registry admits this open against sign-in changes, like any other open.
    const adapter = yield* registry.get(thread.modelSelection.instanceId);
    const snapshot = yield* adapter
      .openSession({
        threadId: input.threadId,
        providerSessionId,
        modelSelection: thread.modelSelection,
        runtimePolicy: {
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          cwd: thread.worktreePath ?? input.workspaceRoot,
        },
        initialNativeThreadId: nativeThreadId,
        ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
          ? {}
          : {
              initialProviderItemIdentityVersion: providerThread.nativeMetadata.itemIdentityVersion,
            }),
      })
      .pipe(
        Effect.flatMap((session) => session.readThreadSnapshot({ providerThread })),
        Effect.timeout(NATIVE_HISTORY_READ_TIMEOUT),
        Effect.scoped,
      );
    const reasoningIds = new Set(snapshot.reasoningMessageIds);
    const messages = snapshot.messages.flatMap((message) =>
      (message.role === "user" || message.role === "assistant") && message.text.trim() !== ""
        ? [
            {
              role: reasoningIds.has(message.id) ? ("reasoning" as const) : message.role,
              text: message.text,
              createdAt: DateTime.formatIso(message.createdAt),
            },
          ]
        : [],
    );
    // Loading the session can take a while, and the thread is usable meanwhile.
    return yield* commit(messages);
  });

  // Invoked inside the orchestrator's thread lock, before a prompt or run is committed.
  const refreshBeforeFirstPrompt = Effect.fn("AgentSessionImporter.refreshBeforeFirstPrompt")(function* (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId?: OrchestrationV2AppThread["providerInstanceId"];
  }) {
    if (!input.threadId.startsWith("import:")) return;
    const { thread, runs } = yield* orchestrator.getThreadRecords(input.threadId, ["runs"]);
    if (thread.historyOrigin !== "v1_import" || runs.length > 0) return;
    if (input.providerInstanceId !== undefined && input.providerInstanceId !== thread.providerInstanceId) {
      return yield* new AgentSessionFirstPromptError({ threadId: input.threadId });
    }
    const result = yield* importRecentAgentThreads(
      { projectId: thread.projectId },
      true,
      new Set([input.threadId]),
      input.threadId,
    ).pipe(
      Effect.timeout("15 seconds"),
      Effect.mapError(() => new AgentSessionFirstPromptError({ threadId: input.threadId })),
    );
    if (result.skippedCount > 0) {
      return yield* new AgentSessionFirstPromptError({ threadId: input.threadId });
    }
  });

  return { importRecentAgentThreads, importNativeHistory, refreshBeforeFirstPrompt };
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("@j1code/server/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
