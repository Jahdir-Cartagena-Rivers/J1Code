import { modelSelectionsEqual } from "@j1code/shared/model";
import { stableStringify } from "@j1code/shared/relaySigning";
import { projectComposerContextForProvider } from "@j1code/shared/composerContextReferences";
import {
  CommandId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  latestProviderTurnForAttempt,
  type OrchestrationV2Subagent,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  isCompactionCommandMessage,
  parseGoalCommand,
  RunId,
  RunAttemptId,
  NodeId,
  ThreadId,
} from "@j1code/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import { ownsSourceImportedNativeHistory } from "../project/AgentSessionHistory.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import {
  captureBotExecutionContext,
  type CapturedBotExecutionContext,
} from "../mausbot/ExecutionContext.ts";
import { resolveBotTurnContext } from "./botTurnContext.ts";
import { prepareHiveTurnRecall, type HiveTurnCapture } from "./HiveTurnRecall.ts";
import { matchesMausbotOrigin } from "./MausbotOrigin.ts";
import { mausbotHistoryMessageId } from "./MausbotHistoryImport.ts";
import {
  CLAUDE_PROVIDER,
  CLAUDE_QUERY_ENDED_BEFORE_TURN_DETAIL,
} from "./Adapters/ClaudeAdapterV2.ts";
import { withTurnStartReservation, withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeRestoreMissingWorktree } from "../workspace/restoreMissingWorktree.ts";
import * as EventSink from "./EventSink.ts";
import { V2RouteAdmission } from "../routing/v2RouteAdmission.ts";
import {
  delegatedTaskOwner,
  strictSteerFingerprint,
  timedDelegationStartAllowed,
} from "./ProviderTurnControlService.ts";
import * as ProviderUsageAnalytics from "../telemetry/ProviderUsageAnalytics.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import { isActiveRun } from "./CommandPolicy.ts";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffTokenCapConfig,
  handoffBudget,
  attachmentTokenAllowance,
  estimateTextTokens,
  contextUsageForHandoff,
  historicalMessage,
  latestNativeContextUsage,
} from "@j1code/provider-core/server/handoffBudget";
import { deliverContextHandoffs, withInlineContext } from "./ContextHandoffDelivery.ts";
import { isProviderCommand, outputInstructions } from "./runOutput.ts";
import * as ProviderAdapter from "@j1code/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@j1code/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import { unsentManualContinuationSource } from "./manualContinuation.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import {
  ContextHandoffBackgroundWorkError,
  knownProviderFailureMessage,
  makeProviderFailure,
} from "@j1code/provider-core/server/failure";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import {
  isRestartNoteContinuation,
  pendingRestartCancelledBackgroundWork,
  restartCancelledBackgroundWorkNote,
} from "./RestartBackgroundNote.ts";

export class ProviderTurnStartError extends Schema.TaggedError<ProviderTurnStartError>()(
  "ProviderTurnStartError",
  {
    runId: RunId,
    cause: Schema.optional(Schema.Defect()),
    attemptId: Schema.optional(RunAttemptId),
    rootNodeId: Schema.optional(NodeId),
  },
) {}

/** Runs that ended without completing: their provider turn may still project as running. */
const NON_COMPLETING_TERMINAL_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);

export const isProviderTurnStartError = Schema.is(ProviderTurnStartError);
const isProviderAdapterProtocolError = Schema.is(ProviderAdapter.ProviderAdapterProtocolError);
const isProviderAdapterOpenSessionError = Schema.is(
  ProviderAdapter.ProviderAdapterOpenSessionError,
);

/**
 * Claude refuses these before it reads the prompt: replacing a process running background work,
 * launch arguments whose appended system prompt or settings cannot be read, or MCP registration
 * that never answers while the query opens. A query that ends before the turn attaches (such as a
 * rejected resume point) never received the prompt either.
 */
const PROMPT_REFUSAL_TAGS = [
  "ClaudeBackgroundWorkBlocksQueryReplacementError",
  "ClaudeAppendSystemPromptFileError",
  "ClaudeAppendSystemPromptMissingValueError",
  "ClaudeSettingsLaunchArgError",
  "ClaudeMcpRegistrationTimeoutError",
] as const;

const refusedBeforePrompt = (error: unknown): boolean =>
  PROMPT_REFUSAL_TAGS.some((tag) => Predicate.isTagged(error, tag)) ||
  (isProviderAdapterProtocolError(error) &&
    error.driver === CLAUDE_PROVIDER &&
    error.detail === CLAUDE_QUERY_ENDED_BEFORE_TURN_DETAIL) ||
  (Predicate.hasProperty(error, "cause") && refusedBeforePrompt(error.cause));

/** Missing execution records cannot be repaired by retrying a start. */
export class ProviderTurnStartRunStateMissingError extends Schema.TaggedError<ProviderTurnStartRunStateMissingError>()(
  "ProviderTurnStartRunStateMissingError",
  {
    runId: RunId,
  },
) {}

export const isProviderTurnStartRunStateMissingError = Schema.is(
  ProviderTurnStartRunStateMissingError,
);

const START_GAVE_UP_MESSAGE =
  "T3 Code could not start this turn. Send the message again; if it keeps failing, check the server logs.";

const startFailureMessage = (error: Error): string => {
  const nestedCause = "cause" in error ? error.cause : undefined;
  return (
    knownProviderFailureMessage(error) ??
    (nestedCause instanceof Error
      ? nestedCause.message
      : typeof nestedCause === "string"
        ? nestedCause
        : error.message)
  );
};

export interface ProviderTurnStartServiceV2Shape {
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly willRetry?: boolean;
    readonly workerClaim?: {
      readonly effectId: string;
      readonly leaseOwner: string;
      readonly attemptCount: number;
    };
  }) => Effect.Effect<void, ProviderTurnStartError>;
  readonly failStartingRun: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly attemptId: RunAttemptId;
    readonly rootNodeId: NodeId;
  }) => Effect.Effect<void, ProviderTurnStartError | ProviderTurnStartRunStateMissingError>;
}

export function matchesDelegationDeadline(
  original: OrchestrationV2Subagent | undefined,
  saved: OrchestrationV2Subagent | undefined,
  now: DateTime.Utc,
): boolean {
  if (original?.deadlineAt === undefined) return true;
  return (
    saved?.deadlineAt !== undefined &&
    original.id === saved.id &&
    original.threadId === saved.threadId &&
    original.childThreadId === saved.childThreadId &&
    DateTime.toEpochMillis(original.deadlineAt) === DateTime.toEpochMillis(saved.deadlineAt) &&
    timedDelegationStartAllowed(saved, now)
  );
}

export function idleWorkerLease(
  claim: Parameters<ProviderTurnStartServiceV2Shape["start"]>[0]["workerClaim"],
  commandId: CommandId,
  runId: RunId,
): string | null {
  return claim?.attemptCount === 1 &&
    claim.effectId === `effect:${commandId}:provider-turn.start:${runId}` &&
    claim.leaseOwner.trim() !== ""
    ? claim.leaseOwner
    : null;
}

export class ProviderTurnStartServiceV2 extends Context.Service<
  ProviderTurnStartServiceV2,
  ProviderTurnStartServiceV2Shape
>()("@j1code/server/orchestration-v2/ProviderTurnStartService/ProviderTurnStartServiceV2") {}

export const layer: Layer.Layer<
  ProviderTurnStartServiceV2,
  never,
  | EventSink.EventSinkV2
  | ContextHandoffService.ContextHandoffServiceV2
  | IdAllocator.IdAllocatorV2
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService
  | GitWorkflowService.GitWorkflowService
  | ProjectService.ProjectService
  | ProviderAuthService.ProviderAuthService
  | ProjectionStore.ProjectionStoreV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | RunExecutionService.RunExecutionServiceV2
  | RuntimePolicy.RuntimePolicyV2
  | TurnItemPositionStore.TurnItemPositionStoreV2
> = Layer.effect(
  ProviderTurnStartServiceV2,
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const turnAnalytics = yield* ProviderUsageAnalytics.ProviderTurnAnalytics;
    const contextHandoffService = yield* ContextHandoffService.ContextHandoffServiceV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { stateDir, attachmentsDir } = yield* ServerConfig.ServerConfig;
    const projects = yield* ProjectService.ProjectService;
    const providerAuth = yield* ProviderAuthService.ProviderAuthService;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
    const legacyImporter = Option.getOrUndefined(
      yield* Effect.serviceOption(LegacyV1ThreadImporter.LegacyV1ThreadImporter),
    );
    const routeAdmission = yield* Effect.serviceOption(V2RouteAdmission);
    const restoreMissingWorktree = yield* makeRestoreMissingWorktree;
    const turnItemPositions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;

    // Build draining callbacks outside startup scope so they cannot retain full thread history.
    const makeRunControls = (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly attemptId: OrchestrationV2RunAttempt["id"];
      readonly providerThreadId: OrchestrationV2ProviderThread["id"];
      readonly runOrdinal: number;
      readonly worktreePath: string | null;
      readonly inheritedBackgroundTurnItems: ReturnType<
        typeof RunExecutionService.selectInheritedBackgroundTurnItems
      >;
    }) => {
      const isCurrentAttemptIn = (statuses: ReadonlyArray<OrchestrationV2Run["status"]>) =>
        projectionStore
          .getRun(input.threadId, input.runId)
          .pipe(
            Effect.map(
              (run) => run?.activeAttemptId === input.attemptId && statuses.includes(run.status),
            ),
          );
      const isCurrentAttemptInStatus = (expectedStatus: OrchestrationV2Run["status"]) =>
        isCurrentAttemptIn([expectedStatus]);
      return {
        isCurrentAttemptInStatus,
        loadInheritedBackgroundTurnItems: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) =>
              RunExecutionService.selectInheritedBackgroundTurnItems({
                threadId: input.threadId,
                currentProviderThreadId: input.providerThreadId,
                currentRunOrdinal: input.runOrdinal,
                runs: current.runs,
                turnItems: current.turnItems,
              }),
            ),
            Effect.catchCause(() => Effect.succeed(input.inheritedBackgroundTurnItems)),
          ),
        shouldStartProviderTurn: () => isCurrentAttemptInStatus("running"),
        shouldFinalizeRun: () => isCurrentAttemptIn(["starting", "running"]),
        hasUnpairedRunInterruptRequest: () =>
          projectionStore
            .hasUnpairedRunInterruptRequest(
              input.threadId,
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-request",
              }),
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-result",
              }),
            )
            .pipe(Effect.catchCause(() => Effect.succeed(false))),
        hasWorkspaceMoved: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) => current.thread.worktreePath !== input.worktreePath),
            Effect.catchCause(() => Effect.succeed(false)),
          ),
        loadUnsettledWork: (threadId: ThreadId, nodeIds: ReadonlyArray<NodeId>) =>
          projectionStore
            .getThreadRecords(threadId, ["subagents", "nodes", "turnItems"], {
              nodeIds,
              subagentIds: nodeIds,
              turnItemStatuses: ["pending", "running", "waiting"],
            })
            .pipe(
              Effect.catchTags({
                ProjectionStoreThreadNotFoundError: () =>
                  Effect.succeed({ subagents: [], nodes: [], turnItems: [] }),
              }),
            ),
        loadRunInterruptReason: () =>
          projectionStore
            .getThreadRecords(input.threadId, ["turnItems"], {
              turnItemTypes: ["run_interrupt_request"],
              turnItemRunIds: [input.runId],
            })
            .pipe(
              Effect.map(({ turnItems }) => {
                const request = turnItems.find((item) => item.type === "run_interrupt_request");
                return request?.type === "run_interrupt_request" ? request.message : undefined;
              }),
              Effect.catchCause(() => Effect.undefined),
            ),
      };
    };

    const makeDeliverySession = (
      session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
      startWithHandoffs: (
        input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact?: boolean,
      ) => ReturnType<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>,
    ) => {
      let deliver: typeof startWithHandoffs | undefined = startWithHandoffs;
      const start = (
        input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact = false,
      ) =>
        Effect.suspend(() => {
          if (deliver !== undefined) return deliver(input, compact);
          return compact && session.compactThread !== undefined
            ? session.compactThread(input)
            : session.startTurn(input);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              deliver = undefined;
            }),
          ),
        );
      return {
        ...session,
        startTurn: (input: Parameters<typeof session.startTurn>[0]) => start(input),
        ...(session.resumeTurn === undefined
          ? {}
          : {
              resumeTurn: (input: ProviderAdapter.ProviderAdapterV2ResumeTurnInput) =>
                start(ProviderAdapter.resumeTurnInput(input)),
            }),
        ...(session.compactThread === undefined
          ? {}
          : {
              compactThread: (input: Parameters<typeof session.startTurn>[0]) => start(input, true),
            }),
      };
    };

    const settleRunBeforeStart = Effect.fn("orchestrationV2.providerTurnStart.settleBeforeStart")(
      function* (input: {
        readonly run: OrchestrationV2Run;
        readonly rootNode: OrchestrationV2ExecutionNode;
        readonly attempt: OrchestrationV2RunAttempt;
        readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
        readonly signal: string;
        readonly status: "completed" | "failed";
        readonly now: DateTime.Utc;
        readonly startedAt?: DateTime.Utc;
        readonly providerInstanceId: OrchestrationV2Run["providerInstanceId"];
        readonly itemProviderThreadId: OrchestrationV2ProviderThread["id"] | null;
        readonly item:
          | Pick<Extract<OrchestrationV2TurnItem, { type: "error" }>, "type" | "title" | "failure">
          | Pick<
              Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
              "type" | "title" | "input" | "output" | "exitCode"
            >;
        readonly providerThreadUpdate?: OrchestrationV2ProviderThread;
      }) {
        const { run, rootNode, attempt, turnItems, now, status } = input;
        const runId = run.id;
        const started = input.startedAt === undefined ? {} : { startedAt: input.startedAt };
        const item: OrchestrationV2TurnItem = {
          id: idAllocator.derive.runSignalTurnItem({ runId, signal: input.signal }),
          threadId: run.threadId,
          runId,
          nodeId: rootNode.id,
          providerThreadId: input.itemProviderThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal:
            Math.max(
              0,
              ...turnItems.filter((item) => item.runId === runId).map((item) => item.ordinal),
            ) + 1,
          status,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          ...input.item,
        };
        const eventPayloads = [
          { type: "turn-item.updated", payload: item },
          { type: "run.updated", payload: { ...run, status, ...started, completedAt: now } },
          {
            type: "run-attempt.updated",
            payload: { ...attempt, status, ...started, completedAt: now },
          },
          {
            type: "node.updated",
            payload: { ...rootNode, status, ...started, completedAt: now },
          },
          ...(input.providerThreadUpdate === undefined
            ? []
            : [
                {
                  type: "provider-thread.updated" as const,
                  payload: input.providerThreadUpdate,
                },
              ]),
        ] as const;
        const events = yield* Effect.forEach(eventPayloads, (event) =>
          Effect.gen(function* () {
            return {
              ...event,
              id: yield* idAllocator.allocate.event({ threadId: run.threadId }),
              threadId: run.threadId,
              runId,
              nodeId: rootNode.id,
              providerInstanceId: input.providerInstanceId,
              occurredAt: now,
            } satisfies OrchestrationV2DomainEvent;
          }),
        );
        const written = yield* eventSink.writeIfRunCurrent({
          threadId: run.threadId,
          runId,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events,
        });
        // A steering restart that cannot start still ends a run whose earlier turns counted.
        if (written.committed) {
          yield* turnAnalytics.runSettled({
            runId,
            status,
            completedAt: now,
            childrenRunning: false,
          });
        }
      },
    );

    const start = Effect.fn("orchestrationV2.providerTurnStart.start")(function* (
      input: Parameters<ProviderTurnStartServiceV2Shape["start"]>[0],
      captureStartingRun: (run: OrchestrationV2Run) => void,
      capturedBot: CapturedBotExecutionContext | undefined,
    ) {
      const { runId } = input;
      const projection = yield* projectionStore.getTurnStartContext(input.threadId, runId);
      const run = projection.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) {
        return yield* new ProviderTurnStartError({ runId, cause: `Run ${runId} was not found.` });
      }
      if (run.status !== "starting") {
        return;
      }
      captureStartingRun(run);
      const savedOwner = yield* delegatedTaskOwner(projectionStore, projection.thread, runId);
      const savedDeadline = savedOwner?.deadlineAt;
      const deadlineRefused = yield* Ref.make(false);
      const deadlineCurrent =
        savedDeadline === undefined
          ? Effect.succeed(true)
          : Effect.gen(function* () {
              const thread = yield* projectionStore.getThread(input.threadId);
              const current = yield* delegatedTaskOwner(projectionStore, thread, runId);
              return matchesDelegationDeadline(savedOwner, current, yield* DateTime.now);
            });
      if (!(yield* deadlineCurrent)) return;
      const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
      const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === run.providerThreadId,
      );
      const savedOrigin = run.mausbotOriginStart;
      const authoredRoot =
        savedOrigin?.rootSource !== undefined && savedOrigin.dispatch === "first";
      const originSource =
        savedOrigin &&
        projection.messages.find(
          (row) =>
            row.id === savedOrigin.sourceMessageId &&
            row.role ===
              (savedOrigin.rootSource || savedOrigin.incidentBatch || savedOrigin.room
                ? "user"
                : "assistant") &&
            row.threadId === run.threadId,
        );
      const message =
        savedOrigin && !authoredRoot
          ? originSource && {
              ...originSource,
              id: run.userMessageId,
              runId: run.id,
              createdBy: "agent" as const,
              text: savedOrigin.text,
              attachments: savedOrigin.attachments,
            }
          : projection.messages.find((candidate) => candidate.id === run.userMessageId);
      const bot = resolveBotTurnContext(projection.thread, run.userMessageId, capturedBot);
      const refuseBotStart = (cause: string) => new ProviderTurnStartError({ runId, cause });
      if (bot.type === "stale")
        return yield* refuseBotStart("The original bot turn no longer owns this message.");
      const botOwner = bot.type === "bridge" ? bot.context : undefined;
      const botOrigin = botOwner?.origin;
      const verifyOrigin = Effect.tryPromise({
        try: async () => Boolean(botOrigin && botOwner?.isCurrent() && (await botOrigin.refresh())),
        catch: (cause) => new ProviderTurnStartError({ runId, cause }),
      }).pipe(Effect.orElseSucceed(() => false));
      if (
        savedOrigin?.consultation &&
        (!botOwner || botOwner.tools.length || providerThread?.driver !== "codex")
      )
        return yield* refuseBotStart(
          "The consultation requires the original provider's read-only start and no action tools.",
        );
      const coordinatorContinuation = savedOrigin?.continuation;
      const ownsCoordinatorSession = (provider: OrchestrationV2ProviderThread) =>
        coordinatorContinuation !== undefined &&
        provider.id === coordinatorContinuation.providerThreadId &&
        provider.providerSessionId === coordinatorContinuation.providerSessionId &&
        provider.nativeThreadRef?.strength === "strong" &&
        provider.nativeThreadRef.nativeId === coordinatorContinuation.nativeThreadId;
      if (
        Boolean(savedOrigin) !== Boolean(botOrigin) ||
        (savedOrigin &&
          (!botOrigin ||
            !originSource ||
            !providerThread ||
            !run.mausbotOriginProviderSessionId ||
            providerThread.providerSessionId !== run.mausbotOriginProviderSessionId ||
            (!authoredRoot &&
              (coordinatorContinuation
                ? !ownsCoordinatorSession(providerThread)
                : providerThread.nativeThreadRef != null)) ||
            (savedOrigin.room &&
              !savedOrigin.room.currentRowIds.every((id) =>
                projection.messages.some(
                  (row) =>
                    row.id === mausbotHistoryMessageId(run.threadId, id) &&
                    row.threadId === run.threadId &&
                    row.role === "user" &&
                    row.createdBy === "user",
                ),
              )) ||
            (savedOrigin.incidentBatch &&
              !savedOrigin.incidentBatch.reports.every((report) =>
                projection.messages.some(
                  (row) =>
                    row.id === mausbotHistoryMessageId(run.threadId, report.nativeMessageId) &&
                    row.threadId === run.threadId &&
                    row.role === "user",
                ),
              )) ||
            !matchesMausbotOrigin(savedOrigin, botOrigin.input) ||
            !(yield* verifyOrigin)))
      ) {
        return yield* refuseBotStart(
          "The exact native assignment no longer owns this provider start.",
        );
      }
      const savedResume = run.mausbotPromptless;
      const botResume = savedResume ? botOwner?.resume : undefined;
      if (
        (botOwner?.resume && !botResume) ||
        (savedResume &&
          (!botResume ||
            !providerThread ||
            botResume.sourceRunId !== run.manualContinuationOfRunId ||
            botResume.sourceRunId !== savedResume.sourceRunId ||
            botResume.incidentFailure !== savedResume.incidentFailure ||
            stableStringify(botResume.incidentNote) !== stableStringify(savedResume.incidentNote) ||
            (savedResume.incidentFailure !== undefined && !botResume.verifyIncident) ||
            botResume.providerTurnId !== savedResume.providerTurnId ||
            botResume.nativeTurnId !== savedResume.nativeTurnId ||
            botResume.providerThreadId !== savedResume.providerThreadId ||
            botResume.providerSessionId !== savedResume.providerSessionId ||
            botResume.nativeThreadId !== savedResume.nativeThreadId ||
            botResume.projectId !== projection.thread.projectId ||
            botResume.runtimeMode !== projection.thread.runtimeMode ||
            botResume.interactionMode !== projection.thread.interactionMode ||
            botResume.providerThreadId !== providerThread?.id ||
            botResume.providerSessionId !== providerThread?.providerSessionId ||
            botResume.nativeThreadId !== providerThread?.nativeThreadRef?.nativeId ||
            providerThread.nativeThreadRef?.strength !== "strong"))
      ) {
        return yield* refuseBotStart(
          "The exact original native bot continuation is no longer owned.",
        );
      }
      const isIdleRoute =
        ProviderAdapter.isReservedIdleRouteRun({
          id: run.id,
          userMessageId: run.userMessageId,
          ...(run.restartContinuationOfRunId === undefined
            ? {}
            : { restartContinuationOfRunId: run.restartContinuationOfRunId }),
          ...(run.usageLimitContinuationOfRunId === undefined
            ? {}
            : { usageLimitContinuationOfRunId: run.usageLimitContinuationOfRunId }),
          ...(run.manualContinuationOfRunId === undefined
            ? {}
            : { manualContinuationOfRunId: run.manualContinuationOfRunId }),
        }) || message?.idleRouteFingerprint !== undefined;
      const admission = Option.getOrUndefined(routeAdmission);
      const idleCommand =
        isIdleRoute && admission !== undefined
          ? yield* admission.readIdleClaim(run.id, run.userMessageId)
          : null;
      const workerLease =
        idleCommand === null
          ? null
          : idleWorkerLease(input.workerClaim, idleCommand.commandId, run.id);
      const idleLease =
        idleCommand !== null &&
        workerLease !== null &&
        message?.idleRouteFingerprint === strictSteerFingerprint(idleCommand) &&
        message.text === idleCommand.text &&
        message.attachments.length === 0
          ? yield* admission!.authorizeIdle(idleCommand, "starting", workerLease)
          : null;
      const refuseIdleStart = () =>
        new ProviderTurnStartError({
          runId,
          cause: "The saved idle route no longer authorizes this provider start.",
        });
      if (isIdleRoute && (idleLease === null || idleCommand === null))
        return yield* refuseIdleStart();
      const stillAuthorized = (phase: "starting" | "running") =>
        idleCommand === null || idleLease === null
          ? Effect.succeed(true)
          : admission!
              .authorizeIdle(idleCommand, phase, idleLease)
              .pipe(Effect.map((lease) => lease === idleLease));
      const checkpointScope = projection.checkpointScopes.find(
        (candidate) => candidate.id === rootNode?.checkpointScopeId,
      );
      // Older versions also stored subagent replies as history handoffs. Their
      // queued completion messages carry the results without a history budget.
      const subagentResultTransfers = new Set(
        projection.contextTransfers
          .filter((transfer) => transfer.type === "subagent_result")
          .map((transfer) => transfer.id),
      );
      const isPendingForRun = (handoff: OrchestrationV2ContextHandoff, anyProviderThread = false) =>
        handoff.status === "ready" &&
        (handoff.targetRunId === run.id ||
          ((anyProviderThread || handoff.toProviderThreadId === run.providerThreadId) &&
            projection.runs.some(
              (source) =>
                source.id === handoff.targetRunId &&
                (source.status === "failed" ||
                  source.status === "interrupted" ||
                  source.status === "cancelled" ||
                  (source.status === "completed" &&
                    handoff.delivery === undefined &&
                    // Compaction and /goal turns defer history to the next turn.
                    projection.messages.some(
                      (message) =>
                        message.id === source.userMessageId &&
                        (isCompactionCommandMessage(message) || parseGoalCommand(message) !== null),
                    ))),
            )));
      const isSideChatHandoff = (handoff: OrchestrationV2ContextHandoff) =>
        projection.thread.lineage.sideChat === true &&
        ContextHandoffService.isSideChatContextHandoff(handoff);
      const handoffs = projection.contextHandoffs.filter(
        (handoff) =>
          !isSideChatHandoff(handoff) &&
          (handoff.transferId == null || !subagentResultTransfers.has(handoff.transferId)) &&
          isPendingForRun(handoff),
      );
      // Carried forward until a provider turn accepts it, also after a provider switch.
      const sideChatHandoff = projection.contextHandoffs.find(
        (handoff) =>
          isSideChatHandoff(handoff) &&
          handoff.delivery === undefined &&
          isPendingForRun(handoff, true),
      );
      const nativeForkTransfer = projection.contextTransfers.find(
        (transfer) =>
          transfer.type === "fork" &&
          transfer.targetThreadId === input.threadId &&
          transfer.targetRunId === run.id &&
          transfer.status === "pending" &&
          transfer.resolution === null,
      );
      if (
        rootNode === undefined ||
        attempt === undefined ||
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        message === undefined ||
        checkpointScope === undefined
      ) {
        return yield* new ProviderTurnStartError({
          runId,
          cause: `Run ${runId} is missing its execution projection state.`,
        });
      }
      if (
        isIdleRoute &&
        (nativeForkTransfer !== undefined ||
          run.manualContinuationOfRunId !== undefined ||
          run.restartContinuationOfRunId !== undefined ||
          attempt.reason !== "initial" ||
          attempt.attemptOrdinal !== 1)
      )
        return yield* refuseIdleStart();
      if (
        botOwner !== undefined &&
        (isIdleRoute ||
          nativeForkTransfer !== undefined ||
          (run.manualContinuationOfRunId !== undefined && !botResume) ||
          run.restartContinuationOfRunId !== undefined ||
          run.usageLimitContinuationOfRunId !== undefined ||
          attempt.reason !== "initial" ||
          attempt.attemptOrdinal !== 1 ||
          isCompactionCommandMessage(message) ||
          parseGoalCommand(message) !== null ||
          message.text.trim().toLowerCase() === "/logout")
      ) {
        return yield* refuseBotStart(
          "This bot action needs a separately owner-checked provider operation.",
        );
      }
      const manualResume =
        botResume === undefined &&
        run.manualContinuationOfRunId !== undefined &&
        attempt.reason !== "steering_restart";
      const resumeSource = manualResume
        ? unsentManualContinuationSource(run, projection)
        : undefined;
      const unsentResumeMessage =
        resumeSource !== undefined
          ? projection.messages.find((source) => source.id === resumeSource.userMessageId)
          : undefined;
      const providerMessage = unsentResumeMessage ?? message;
      const settleStartFailure = Effect.fn("ProviderTurnStartService.settleStartFailure")(
        function* (failed: {
          readonly signal: string;
          readonly title: string;
          readonly error: Error;
          readonly message?: string;
        }) {
          yield* settleRunBeforeStart({
            run,
            rootNode,
            attempt,
            turnItems: projection.turnItems,
            signal: failed.signal,
            status: "failed",
            now: yield* DateTime.now,
            providerInstanceId: run.providerInstanceId,
            itemProviderThreadId: providerThread.id,
            item: {
              type: "error",
              title: failed.title,
              failure: makeProviderFailure({
                cause: failed.error,
                message: failed.message ?? startFailureMessage(failed.error),
                class: "provider_error",
              }),
            },
          });
        },
      );
      if (
        providerMessage.attachments.length === 0 &&
        providerMessage.text.trimStart().startsWith("/")
      ) {
        const isEmptyCompaction =
          providerMessage.text.trim().toLowerCase() === "/compact" && !projection.hasConversation;
        // Preparation may select a new provider; account commands still target the last native session.
        const nativeThreads = new Map(
          projection.providerThreads
            .filter(
              (candidate) => candidate.ownerNodeId === null && candidate.nativeThreadRef !== null,
            )
            .map((candidate) => [candidate.id, candidate]),
        );
        const previousNativeRun = projection.runs.reduce<OrchestrationV2Run | undefined>(
          (previous, candidate) =>
            candidate.ordinal < run.ordinal &&
            candidate.providerThreadId !== null &&
            nativeThreads.has(candidate.providerThreadId) &&
            (previous === undefined || candidate.ordinal > previous.ordinal)
              ? candidate
              : previous,
          undefined,
        );
        const nativeThread = nativeThreads.get(
          previousNativeRun?.providerThreadId ??
            projection.thread.activeProviderThreadId ??
            providerThread.id,
        );
        const authInstanceId = nativeThread?.providerInstanceId ?? run.providerInstanceId;
        const authResult = isEmptyCompaction
          ? null
          : yield* Effect.result(
              providerAuth.tryHandlePromptCommand({
                instanceId: authInstanceId,
                text: projectComposerContextForProvider({
                  text: providerMessage.text,
                  records: providerMessage.context?.records ?? [],
                }),
                hasAttachments: false,
              }),
            );
        if (isEmptyCompaction || authResult?._tag === "Failure" || authResult?.success) {
          const now = yield* DateTime.now;
          const failure = isEmptyCompaction
            ? makeProviderFailure({
                class: "validation_error",
                message: "Start a conversation before compacting this thread.",
              })
            : authResult?._tag === "Failure"
              ? makeProviderFailure({
                  class: "permission_error",
                  message: authResult.failure.detail,
                })
              : undefined;
          const status = failure === undefined ? "completed" : "failed";
          yield* settleRunBeforeStart({
            run,
            rootNode,
            attempt,
            turnItems: projection.turnItems,
            signal: isEmptyCompaction ? "empty-compaction" : "provider-sign-out",
            status,
            now,
            startedAt: now,
            providerInstanceId: authInstanceId,
            itemProviderThreadId: nativeThread?.id ?? providerThread.id,
            item:
              failure !== undefined
                ? {
                    type: "error",
                    title: isEmptyCompaction
                      ? "Cannot compact an empty thread"
                      : "Provider sign-out failed",
                    failure,
                  }
                : {
                    type: "command_execution",
                    title: "Provider signed out",
                    input: providerMessage.text.trim(),
                    output: "Provider signed out",
                    exitCode: 0,
                  },
            providerThreadUpdate: {
              ...providerThread,
              status: providerThread.nativeThreadRef === null ? "not_loaded" : "idle",
              updatedAt: now,
            },
          });
          return;
        }
      }
      if (
        isIdleRoute &&
        projection.thread.worktreePath !== null &&
        !(yield* fileSystem.exists(projection.thread.worktreePath))
      )
        return yield* refuseIdleStart();
      const recreateResult = yield* Effect.result(
        isIdleRoute ? Effect.void : restoreMissingWorktree(projection.thread),
      );
      if (recreateResult._tag === "Failure") {
        if (input.willRetry === true) return yield* recreateResult.failure;
        yield* settleStartFailure({
          signal: "worktree-recreate-failure",
          title: "Couldn't recreate thread workspace",
          error: recreateResult.failure,
          message: recreateResult.failure.message,
        });
        return;
      }
      const selectInheritedBackgroundItems = (
        current: ProjectionStore.ProjectionRuntimeRecoveryState,
      ): ReturnType<typeof RunExecutionService.selectInheritedBackgroundTurnItems> =>
        RunExecutionService.selectInheritedBackgroundTurnItems({
          threadId: current.thread.id,
          currentProviderThreadId: providerThread.id,
          currentRunOrdinal: run.ordinal,
          runs: current.runs,
          turnItems: current.turnItems,
        });
      const recoveryResult = yield* Effect.result(
        projectionStore.getRuntimeRecoveryProjection(projection.thread.id),
      );
      if (recoveryResult._tag === "Failure") {
        if (input.willRetry === true) return yield* recoveryResult.failure;
        yield* settleStartFailure({
          signal: "runtime-recovery-read-failure",
          title: "Couldn't read thread state",
          error: recoveryResult.failure,
        });
        return;
      }
      const inheritedBackgroundTurnItems = selectInheritedBackgroundItems(recoveryResult.success);
      const providerSessionId = providerThread.providerSessionId;
      const runControls = makeRunControls({
        threadId: projection.thread.id,
        runId: run.id,
        attemptId: attempt.id,
        providerThreadId: providerThread.id,
        runOrdinal: run.ordinal,
        worktreePath: projection.thread.worktreePath,
        inheritedBackgroundTurnItems,
      });
      const { isCurrentAttemptInStatus } = runControls;
      const canPrepare = () =>
        isCurrentAttemptInStatus("starting").pipe(
          Effect.flatMap((current) => (current ? deadlineCurrent : Effect.succeed(false))),
        );
      const authorizeDelegationWrite =
        savedDeadline === undefined
          ? undefined
          : isCurrentAttemptInStatus("running").pipe(
              Effect.flatMap((active) => (active ? deadlineCurrent : Effect.succeed(false))),
              Effect.orElseSucceed(() => false),
              Effect.tap((allowed) => (allowed ? Effect.void : Ref.set(deadlineRefused, true))),
            );

      const resolvedPolicy = yield* runtimePolicy
        .resolve({
          thread: projection.thread,
          modelSelection: run.modelSelection,
        })
        .pipe(Effect.result);
      if (!(yield* canPrepare())) return;
      if (resolvedPolicy._tag === "Failure") {
        const error = resolvedPolicy.failure;
        if (error._tag !== "RuntimePolicyAboveCeilingError") return yield* error;
        yield* settleStartFailure({
          signal: "runtime-mode-above-ceiling",
          title: "Thread mode is above the policy limit",
          error,
          message: error.message,
        });
        return;
      }
      const resolvedRuntimePolicy = savedOrigin?.consultation
        ? {
            ...resolvedPolicy.success,
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly" },
            nativeToolPolicy: "consultation-no-tools" as const,
          }
        : resolvedPolicy.success;
      if (!(yield* canPrepare())) return;
      const existingSessionProjection = projection.providerSessions.find(
        (candidate) => candidate.id === providerSessionId,
      );
      // A run that ended without completing can leave its provider turn projected as
      // running when the agent ignored Stop or an interrupt timed out. Every attempt
      // of such a run owns a possible abandoned turn, including attempts a steering
      // restart superseded, and the session cannot be reused until those turns stop.
      const abandonedRuns = new Map<string | null, OrchestrationV2Run>();
      for (const previous of projection.runs) {
        if (
          previous.ordinal >= run.ordinal ||
          previous.providerThreadId !== providerThread.id ||
          !NON_COMPLETING_TERMINAL_RUN_STATUSES.has(previous.status)
        ) {
          continue;
        }
        if (previous.activeAttemptId !== null) {
          abandonedRuns.set(previous.activeAttemptId, previous);
        }
        for (const attempt of projection.attempts) {
          if (attempt.runId === previous.id) abandonedRuns.set(attempt.id, previous);
        }
      }
      const abandonedTurns = projection.providerTurns.flatMap((turn) => {
        const previous = abandonedRuns.get(turn.runAttemptId);
        return turn.providerThreadId === providerThread.id &&
          turn.status === "running" &&
          previous !== undefined
          ? [{ turn, run: previous }]
          : [];
      });
      const abandonedTurn = abandonedTurns.at(-1)?.turn;
      if (abandonedTurn !== undefined) {
        if (isIdleRoute) return yield* refuseIdleStart();
        if (botOwner !== undefined)
          return yield* refuseBotStart(
            "A previous provider turn still owns the bot's native conversation.",
          );
        const liveSession = yield* providerSessions.get(providerSessionId);
        if (Option.isSome(liveSession)) {
          // The run already ended without stopping its provider — a failed start, an
          // ignored Stop, or an interrupt that never confirmed. Recover that exact
          // turn before reusing its native conversation.
          const recovered = yield* Effect.result(
            liveSession.value.interruptTurn({
              providerThread,
              providerTurnId: abandonedTurn.id,
              requestRuntimeRestart: true,
            }),
          );
          if (recovered._tag === "Failure") {
            if (input.willRetry === true) return yield* recovered.failure;
            yield* settleStartFailure({
              signal: "provider-turn-recovery-failure",
              title: "Provider turn recovery failed",
              error: recovered.failure,
            });
            return;
          }
        }
        const completedAt = yield* DateTime.now;
        const repaired = yield* eventSink.writeIfRunCurrent({
          threadId: projection.thread.id,
          runId: run.id,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events: yield* Effect.forEach(abandonedTurns, ({ turn, run: abandonedRun }) =>
            Effect.gen(function* () {
              return {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "provider-turn.updated" as const,
                threadId: projection.thread.id,
                runId: abandonedRun.id,
                nodeId: turn.nodeId,
                providerInstanceId: abandonedRun.providerInstanceId,
                occurredAt: completedAt,
                payload: { ...turn, status: "interrupted" as const, completedAt },
              };
            }),
          ),
        });
        if (!repaired.committed) return;
      }
      // Opening a session does not prompt the provider, so the workspace is still unchanged.
      const baseline = yield* runExecution.forkBaseline({
        appThread: projection.thread,
        run,
        checkpointScope,
      });
      if (
        botResume &&
        (!resolvedRuntimePolicy.cwd ||
          path.resolve(resolvedRuntimePolicy.cwd) !== path.resolve(botResume.cwd))
      )
        return yield* refuseBotStart("The original bot workspace changed before Resume.");
      if (
        idleCommand !== null &&
        (strictSteerFingerprint(resolvedRuntimePolicy) !== idleCommand.policyFingerprint ||
          !(yield* stillAuthorized("starting")))
      )
        return yield* refuseIdleStart();
      if (botOwner !== undefined && !botOwner.isCurrent())
        return yield* refuseBotStart("The original bot turn ended before provider startup.");
      if (!(yield* canPrepare())) return;
      const readLegacyId =
        providerThread.driver === "opencode"
          ? legacyImporter?.readOpenCodeHistory
          : providerThread.driver === "grok"
            ? legacyImporter?.readGrokHistory
            : undefined;
      const readLegacyHistory:
        | Effect.Effect<
            | { readonly nativeId: string; readonly storeCwd?: string; readonly headId?: string }
            | undefined,
            LegacyV1ThreadImporter.LegacyV1ThreadImportError
          >
        | undefined =
        run.freshContext === true
          ? undefined
          : providerThread.driver === "cursor"
            ? legacyImporter?.readCursorHistory?.(projection.thread.id, run.providerInstanceId)
            : providerThread.driver === "claudeAgent"
              ? legacyImporter?.readClaudeHistory?.(projection.thread.id, run.providerInstanceId)
              : providerThread.driver === "codex"
                ? legacyImporter?.readCodexHistory?.(projection.thread.id, run.providerInstanceId)
                : providerThread.driver === "antigravity"
                  ? legacyImporter?.readAntigravityHistory?.(
                      projection.thread.id,
                      run.providerInstanceId,
                    )
                  : readLegacyId?.(projection.thread.id, run.providerInstanceId).pipe(
                      Effect.map((nativeId) => (nativeId === undefined ? undefined : { nativeId })),
                    );
      // An explicit fresh run already has a new provider row. Adopting the V1
      // cursor here would reopen the native conversation that it replaced.
      const savedLegacyHistory =
        run.freshContext !== true &&
        readLegacyHistory !== undefined &&
        providerThread.nativeThreadRef === null &&
        providerThread.ownerNodeId === null &&
        projection.thread.historyOrigin === "v1_import" &&
        nativeForkTransfer === undefined &&
        !isIdleRoute &&
        botOwner === undefined
          ? yield* Effect.result(readLegacyHistory)
          : undefined;
      if (savedLegacyHistory?._tag === "Failure") {
        if (input.willRetry === true) return yield* savedLegacyHistory.failure;
        yield* settleStartFailure({
          signal: "legacy-native-history-unverified",
          title: "Could not verify the original provider conversation",
          error: savedLegacyHistory.failure,
        });
        return;
      }
      const legacyNativeId = savedLegacyHistory?.success?.nativeId;
      const legacyStoreCwd = savedLegacyHistory?.success?.storeCwd;
      const claudeLegacyStoreCwd =
        providerThread.driver === "claudeAgent"
          ? (legacyStoreCwd ?? providerThread.nativeMetadata?.claudeLegacyStoreCwd)
          : undefined;
      const codexLegacyStoreCwd =
        providerThread.driver === "codex"
          ? (legacyStoreCwd ?? providerThread.nativeMetadata?.codexLegacyStoreCwd)
          : undefined;
      const antigravityLegacyStoreCwd =
        providerThread.driver === "antigravity"
          ? (legacyStoreCwd ?? providerThread.nativeMetadata?.antigravityLegacyStoreCwd)
          : undefined;
      const originalStoreCwd =
        claudeLegacyStoreCwd ?? codexLegacyStoreCwd ?? antigravityLegacyStoreCwd;
      if (
        originalStoreCwd !== undefined &&
        (resolvedRuntimePolicy.cwd === null ||
          !path.isAbsolute(resolvedRuntimePolicy.cwd) ||
          path.relative(originalStoreCwd, resolvedRuntimePolicy.cwd) !== "")
      ) {
        yield* settleStartFailure({
          signal: "legacy-native-workspace-mismatch",
          title: "Could not reopen the original provider workspace",
          error: new ProviderAdapter.ProviderAdapterProtocolError({
            driver: providerThread.driver,
            detail: "The original provider conversation belongs to a different workspace.",
          }),
        });
        return;
      }
      const legacyGeneration =
        providerThread.driver === "opencode" &&
        (legacyNativeId !== undefined ||
          (providerThread.nativeThreadRef !== null &&
            providerThread.nativeMetadata?.openCodeHistoryGeneration === "v1"));
      const grokLegacyHistory =
        providerThread.driver === "grok" &&
        (legacyNativeId !== undefined ||
          (providerThread.nativeThreadRef !== null &&
            providerThread.nativeMetadata?.grokLegacyHistory === true));
      const cursorLegacyHistory =
        providerThread.driver === "cursor" &&
        (legacyNativeId !== undefined ||
          (providerThread.nativeThreadRef !== null &&
            providerThread.nativeMetadata?.cursorLegacyHistory === true));
      const cursorTransport = cursorLegacyHistory
        ? ("acp" as const)
        : providerThread.nativeMetadata?.cursorTransport;
      const cursorStoreCwd = legacyStoreCwd ?? providerThread.nativeMetadata?.cursorStoreCwd;
      const legacyNativeMetadata =
        claudeLegacyStoreCwd !== undefined
          ? { claudeLegacyStoreCwd }
          : codexLegacyStoreCwd !== undefined
            ? { codexLegacyStoreCwd }
            : antigravityLegacyStoreCwd !== undefined
              ? { antigravityLegacyStoreCwd }
              : legacyGeneration
                ? { openCodeHistoryGeneration: "v1" as const }
                : grokLegacyHistory
                  ? { grokLegacyHistory: true as const }
                  : cursorLegacyHistory
                    ? {
                        cursorLegacyHistory: true as const,
                        cursorTransport: "acp" as const,
                        ...(legacyStoreCwd === undefined ? {} : { cursorStoreCwd: legacyStoreCwd }),
                      }
                    : {};
      if (!(yield* canPrepare())) return;
      const sessionResult = yield* Effect.result(
        providerSessions.open({
          threadId: projection.thread.id,
          providerSessionId,
          ...(botOwner === undefined ? {} : { botExecution: botOwner }),
          modelSelection: run.modelSelection,
          runtimePolicy: resolvedRuntimePolicy,
          ...(existingSessionProjection === undefined
            ? {}
            : { resumeFromSession: existingSessionProjection }),
          ...(legacyNativeId !== undefined
            ? { initialNativeThreadId: legacyNativeId }
            : providerThread.nativeThreadRef?.nativeId == null
              ? {}
              : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
          ...(legacyGeneration ? { initialOpenCodeHistoryGeneration: "v1" as const } : {}),
          ...(grokLegacyHistory || antigravityLegacyStoreCwd !== undefined
            ? { requireExactInitialNativeThread: true as const }
            : {}),
          ...(cursorTransport === undefined ? {} : { initialCursorTransport: cursorTransport }),
          ...(cursorStoreCwd === undefined ? {} : { initialCursorStoreCwd: cursorStoreCwd }),
          ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
            ? {}
            : {
                initialProviderItemIdentityVersion:
                  providerThread.nativeMetadata.itemIdentityVersion,
              }),
        }),
      );
      if (!(yield* canPrepare())) return;
      if (sessionResult._tag === "Failure") {
        const failure = sessionResult.failure;
        if (
          savedOrigin?.consultation &&
          "cause" in failure &&
          failure.cause === ProviderAdapter.CONSULTATION_TOOL_ISOLATION_REQUIRED
        ) {
          yield* settleStartFailure({
            signal: "consultation-tool-isolation-unavailable",
            title: "Consultation could not start",
            error: failure,
            message: ProviderAdapter.CONSULTATION_TOOL_ISOLATION_REQUIRED,
          });
          return;
        }
        const requiresSignIn =
          "cause" in failure &&
          isProviderAdapterOpenSessionError(failure.cause) &&
          failure.cause.requiresSignIn === true;
        if (input.willRetry === true && !requiresSignIn) return yield* failure;
        yield* settleStartFailure({
          signal: "provider-session-open-failure",
          title: "Provider session failed to open",
          error: sessionResult.failure,
        });
        return;
      }
      const openedSession = sessionResult.success;
      let trackHiveRecall:
        | ((turnId: string) => Effect.Effect<HiveTurnCapture | undefined>)
        | undefined;
      const withHiveRecall = Effect.fn("ProviderTurnStartService.withHiveRecall")(function* (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
        botPromptLength: number,
      ) {
        if (
          typeof stateDir !== "string" ||
          typeof attachmentsDir !== "string" ||
          manualResume ||
          botResume ||
          isIdleRoute ||
          (savedOrigin && !authoredRoot) ||
          turnInput.resume ||
          run.freshContext ||
          attempt.reason !== "initial" ||
          attempt.attemptOrdinal !== 1 ||
          turnInput.message.messageId !== providerMessage.id
        )
          return turnInput;
        const standalone = String(projection.thread.projectId).startsWith("j1-bot:");
        const project = standalone
          ? undefined
          : yield* projects.getById(projection.thread.projectId).pipe(
              Effect.map(Option.getOrUndefined),
              Effect.orElseSucceed(() => undefined),
            );
        const recall = yield* prepareHiveTurnRecall({
          file: path.join(stateDir, "hive-mind.json"),
          query: providerMessage.text,
          projects: project ? [project.title, path.basename(project.workspaceRoot)] : [],
          standalone,
          threadId: turnInput.threadId,
          attachmentsDir,
          attachments: turnInput.message.attachments,
          charactersAvailable:
            PROVIDER_SEND_TURN_MAX_INPUT_CHARS - turnInput.message.text.length - botPromptLength,
        });
        if (!recall) return turnInput;
        trackHiveRecall = (turnId) =>
          recall.track(openedSession.driver, openedSession.instanceId, turnId);
        return {
          ...turnInput,
          message: {
            ...turnInput.message,
            text: recall.prefix + turnInput.message.text,
            attachments: recall.attachments,
          },
          inlineContextLength: (turnInput.inlineContextLength ?? 0) + recall.prefix.length,
        };
      });
      const takeHiveTurnCapture = (turnId: string) => {
        const track = trackHiveRecall;
        trackHiveRecall = undefined;
        return track?.(turnId);
      };
      const markDispatchAttempt = Effect.gen(function* () {
        const observation = yield* ProviderUsageAnalytics.ProviderDispatchObservation;
        yield* observation.attempted;
      });
      const observeDispatchRejection = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
        operation.pipe(
          Effect.tapError(() =>
            Effect.gen(function* () {
              const observation = yield* ProviderUsageAnalytics.ProviderDispatchObservation;
              yield* observation.rejected;
            }),
          ),
        );
      const observeDispatch =
        <A extends { readonly authorizeDelegationWrite?: Effect.Effect<boolean> }>(
          send: (input: A) => Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error>,
        ) =>
        (input: A) => {
          const authorization = input.authorizeDelegationWrite;
          return observeDispatchRejection(
            authorization === undefined
              ? markDispatchAttempt.pipe(Effect.andThen(Effect.suspend(() => send(input))))
              : Effect.suspend(() =>
                  send({
                    ...input,
                    authorizeDelegationWrite:
                      ProviderUsageAnalytics.observeProviderWriteAuthorization(authorization),
                  }),
                ),
          );
        };
      const session: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        ...openedSession,
        startTurn: Effect.fn("ProviderTurnStartService.startObservedTurn")(function* (
          input: ProviderAdapter.ProviderAdapterV2TurnInput,
        ) {
          const recalled = yield* withHiveRecall(input, 0);
          if (
            recalled !== input &&
            !(yield* runControls.shouldStartProviderTurn().pipe(Effect.orElseSucceed(() => false)))
          )
            return;
          yield* observeDispatch((input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
            openedSession.startTurn(input),
          )(recalled);
        }),
        ...(openedSession.resumeTurn === undefined
          ? {}
          : {
              resumeTurn: observeDispatch(
                (input: ProviderAdapter.ProviderAdapterV2ResumeTurnInput) =>
                  openedSession.resumeTurn!(input),
              ),
            }),
        ...(openedSession.compactThread === undefined
          ? {}
          : {
              compactThread: observeDispatch((input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
                openedSession.compactThread!(input),
              ),
            }),
      };
      const botStart = session.botTurnStart;
      if (
        botOwner !== undefined &&
        (!botOwner.isCurrent() ||
          botStart === undefined ||
          (botOwner.restrictedTools && !botStart.supportsRestrictedTools))
      ) {
        return yield* refuseBotStart(
          botOwner.restrictedTools
            ? "This provider cannot enforce the bot's selected tool scope."
            : "The provider could not safely start the original bot turn.",
        );
      }
      if (
        savedOrigin &&
        !authoredRoot &&
        session.injectHistory === undefined &&
        ((!savedOrigin.incidentBatch && !savedOrigin.room) || run.contextHandoffId !== null)
      ) {
        return yield* refuseBotStart(
          "This provider cannot restore the saved assignment history separately.",
        );
      }
      const guardedStart = session.guardedStartTurn;
      if (isIdleRoute && guardedStart === undefined) {
        return yield* refuseIdleStart();
      }
      if (!(yield* canPrepare())) return;
      const loadFromProvider = Effect.fn("ProviderTurnStartService.loadFromProvider")(function* (
        load: Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapter.ProviderAdapterV2Error>,
      ) {
        if (isIdleRoute && !(yield* stillAuthorized("starting"))) return yield* refuseIdleStart();
        if (botOwner !== undefined && !botOwner.isCurrent())
          return yield* refuseBotStart(
            "The original bot turn ended before loading the native conversation.",
          );
        if (!(yield* canPrepare())) return undefined;
        const loaded = yield* Effect.result(load);
        if (!(yield* canPrepare())) return undefined;
        if (loaded._tag === "Success") return loaded.success;
        if (input.willRetry === true) return yield* loaded.failure;
        yield* settleStartFailure({
          signal: "provider-thread-load-failure",
          title: "Provider turn failed to start",
          error: loaded.failure,
        });
        return undefined;
      });
      let effectiveHandoffs = handoffs;
      const reusedLegacyHandoffs =
        legacyNativeId === undefined
          ? []
          : handoffs.filter(LegacyV1ThreadImporter.isImportedV1TranscriptHandoff);
      if (reusedLegacyHandoffs.length > 0) {
        const ids = new Set(reusedLegacyHandoffs.map(({ id }) => id));
        effectiveHandoffs = handoffs.filter(({ id }) => !ids.has(id));
      }
      let resumeFellBack = false;
      const messageText = projectComposerContextForProvider({
        text: providerMessage.text,
        records: providerMessage.context?.records ?? [],
      });
      // Native goal commands go verbatim; handoff history waits a turn.
      const goalDriver =
        session.driver === "codex" ||
        session.driver === "claudeAgent" ||
        session.providerSession.capabilities.turns.supportsNativeGoals === true;
      const goalCommand = goalDriver && parseGoalCommand(providerMessage) !== null;
      // Part of the user text, so every way a turn starts carries it, after the user's own words.
      const userText =
        run.outputSchema === undefined || goalCommand || isProviderCommand(providerMessage)
          ? messageText
          : `${messageText}\n\n${outputInstructions(run.outputSchema)}`;
      // The provider turn marks cancellation work delivered; restart continuations use their own text or resume natively.
      const noteContinuation = isRestartNoteContinuation(
        run,
        projection.runs,
        projection.providerTurns,
        projection.attempts,
      );
      const restartCancelledWork = pendingRestartCancelledBackgroundWork({
        runs: projection.runs,
        providerTurns: projection.providerTurns,
        compactionMessageIds: new Set(
          projection.messages
            .filter(
              (candidate) =>
                isCompactionCommandMessage(candidate) ||
                (goalDriver && parseGoalCommand(candidate) !== null),
            )
            .map((candidate) => candidate.id),
        ),
        run,
        attempts: projection.attempts,
      });
      const restartNote =
        restartCancelledWork.length === 0
          ? ""
          : restartCancelledBackgroundWorkNote(restartCancelledWork);
      const tokenCap = yield* handoffTokenCapConfig.pipe(
        Effect.orElseSucceed(() => DEFAULT_HANDOFF_TOKEN_CAP),
      );
      const handoffContextForThread = (loadedProviderThread: OrchestrationV2ProviderThread) => {
        const measuredContext = latestNativeContextUsage(projection, providerThread);
        const previousSelection =
          measuredContext?.modelSelection ??
          projection.runs.findLast(
            (source) =>
              source.ordinal < run.ordinal &&
              source.startedAt !== null &&
              source.providerThreadId === providerThread.id,
          )?.modelSelection;
        const sameSelection =
          previousSelection === undefined ||
          modelSelectionsEqual(previousSelection, run.modelSelection);
        const sameNativeThread =
          loadedProviderThread.nativeThreadRef?.nativeId ===
          providerThread.nativeThreadRef?.nativeId;
        const threadUsage = loadedProviderThread.contextUsage ?? providerThread.contextUsage;
        const previousUsage = measuredContext
          ? { ...threadUsage, ...measuredContext.usage }
          : threadUsage;
        const reuseTelemetry =
          sameSelection ||
          (previousSelection !== undefined &&
            session.canReuseContextUsage?.(previousSelection, run.modelSelection) === true);
        const knownModelWindow = session.getModelContextWindow?.(
          run.modelSelection,
          resolvedRuntimePolicy.cwd,
        );
        const handoffUsage = contextUsageForHandoff({
          sameNativeThread,
          sameSelection,
          reuseTelemetry,
          previousUsage,
          knownModelWindow,
        });
        const settledHandoffs = projection.contextHandoffs.filter(
          (handoff) =>
            handoff.toProviderThreadId === providerThread.id &&
            handoff.delivery?.nativeThreadId === loadedProviderThread.nativeThreadRef?.nativeId &&
            handoff.delivery?.status !== "pending",
        );
        const deliveredItemIds = new Set(
          settledHandoffs.flatMap((handoff) => handoff.delivery?.itemIds ?? []),
        );
        const coveredItemIds = new Set([
          ...deliveredItemIds,
          ...settledHandoffs.flatMap((handoff) => handoff.delivery?.omittedItemIds ?? []),
        ]);
        const deliveredAttemptIds = new Set(
          projection.providerTurns.map((turn) => turn.runAttemptId),
        );
        const acceptedAttempts = projection.attempts.filter(
          (source) =>
            source.providerThreadId === providerThread.id && deliveredAttemptIds.has(source.id),
        );
        const nativeInputRunIds = new Set(
          acceptedAttempts
            .filter(
              (source) =>
                source.nativeThreadId !== undefined &&
                source.nativeThreadId === loadedProviderThread.nativeThreadRef?.nativeId,
            )
            .map((source) => source.runId),
        );
        const legacyInputRunIds = new Set(
          acceptedAttempts
            .filter((source) => source.nativeThreadId === undefined)
            .map((source) => source.runId),
        );
        const legacyRecoveredRunIds = new Set(
          projection.runs
            .filter(
              (source) =>
                source.providerThreadId === providerThread.id &&
                settledHandoffs.some(
                  (handoff) =>
                    handoff.strategy === "full_thread_summary" &&
                    handoff.fromProviderThreadIds.includes(providerThread.id) &&
                    source.ordinal >= handoff.coveredRunOrdinals.from &&
                    source.ordinal <= handoff.coveredRunOrdinals.to,
                ),
            )
            .map((source) => source.id),
        );
        // Row identity survives recovery; only accepted native input and delivered history occupy the new session.
        const nativeContextEstimate = Effect.gen(function* () {
          return sameNativeThread
            ? (yield* projectionStore.getTurnStartHistory(input.threadId)).reduce((sum, item) => {
                const acceptedNatively =
                  item.providerThreadId === providerThread.id &&
                  item.runId !== null &&
                  (nativeInputRunIds.has(item.runId) ||
                    (legacyInputRunIds.has(item.runId) &&
                      !coveredItemIds.has(item.id) &&
                      !legacyRecoveredRunIds.has(item.runId)));
                if (item.runId === run.id || (!acceptedNatively && !deliveredItemIds.has(item.id)))
                  return sum;
                const historical = historicalMessage(item);
                const nativeAttachments =
                  item.type === "user_message" && acceptedNatively
                    ? attachmentTokenAllowance(item.attachments)
                    : 0;
                return (
                  sum +
                  (historical === null ? 0 : estimateTextTokens(historical.text)) +
                  nativeAttachments
                );
              }, 0)
            : 0;
        });
        const modelContextWindow =
          knownModelWindow ??
          (handoffUsage !== null || reuseTelemetry ? previousUsage?.maxTokens : undefined);
        const budgetProviderThread = {
          ...loadedProviderThread,
          contextUsage: handoffUsage,
        };
        // The resume fallback summary already covers every earlier run in order. A
        // retry copy after it would rank older missed requests as the newest history.
        const missedRuns = projection.runs.filter(
          (source) =>
            !resumeFellBack &&
            source.ordinal < run.ordinal &&
            source.providerThreadId === providerThread.id &&
            (source.status === "failed" || source.status === "interrupted") &&
            !deliveredAttemptIds.has(source.activeAttemptId),
        );
        const missedRunIds = new Set(missedRuns.map((source) => source.id));
        return {
          sameNativeThread,
          handoffUsage,
          deliveredItemIds,
          coveredItemIds,
          acceptedAttempts,
          nativeInputRunIds,
          legacyInputRunIds,
          missedRuns,
          missedRunIds,
          budget: Effect.gen(function* () {
            return handoffBudget({
              tokenCap,
              modelContextWindow,
              userText: restartNote === "" ? userText : `${restartNote}\n\n${userText}`,
              attachments: providerMessage.attachments,
              providerThread: budgetProviderThread,
              nativeContextEstimate:
                budgetProviderThread.contextUsage?.usedTokens === undefined
                  ? yield* nativeContextEstimate
                  : 0,
            });
          }),
        };
      };
      const prepareRetryHandoff = Effect.fn("ProviderTurnStartService.prepareRetryHandoff")(
        function* (context: ReturnType<typeof handoffContextForThread>) {
          const { missedRunIds, coveredItemIds, missedRuns } = context;
          const missedItems =
            missedRunIds.size === 0
              ? []
              : (yield* projectionStore.getTurnStartHistory(input.threadId, [
                  ...missedRunIds,
                ])).filter(
                  (item) =>
                    item.runId !== null &&
                    missedRunIds.has(item.runId) &&
                    !coveredItemIds.has(item.id) &&
                    historicalMessage(item) !== null,
                );
          const retryHandoff =
            missedItems.length === 0
              ? []
              : [
                  yield* contextHandoffService.prepareProviderHandoff({
                    threadId: projection.thread.id,
                    targetRunId: run.id,
                    transferId: null,
                    fromProviderThreadIds: [providerThread.id],
                    toProviderThreadId: providerThread.id,
                    fromProviderInstanceId: run.providerInstanceId,
                    toProviderInstanceId: run.providerInstanceId,
                    coveredRunOrdinals: {
                      from: missedRuns[0]!.ordinal,
                      to: missedRuns.at(-1)!.ordinal,
                    },
                    strategy: "delta_since_target_last_seen",
                    items: missedItems,
                    runs: projection.runs,
                    createdAt: yield* DateTime.now,
                  }),
                ];
          return retryHandoff;
        },
      );
      const prepareRecoveryHandoff = Effect.fn("ProviderTurnStartService.prepareRecoveryHandoff")(
        function* () {
          const transferId = yield* idAllocator.allocate.contextTransfer({
            sourceThreadId: projection.thread.id,
            targetThreadId: projection.thread.id,
            type: "provider_resume_fallback",
          });
          const createdAt = yield* DateTime.now;
          const handoff = yield* contextHandoffService.prepareProviderHandoff({
            threadId: projection.thread.id,
            targetRunId: run.id,
            transferId,
            fromProviderThreadIds: [providerThread.id],
            toProviderThreadId: providerThread.id,
            fromProviderInstanceId: providerThread.providerInstanceId,
            toProviderInstanceId: run.providerInstanceId,
            coveredRunOrdinals: { from: 1, to: Math.max(1, run.ordinal - 1) },
            strategy: "full_thread_summary",
            runs: projection.runs,
            items: (yield* projectionStore.getTurnStartHistory(input.threadId)).filter(
              (item) =>
                item.runId === null ||
                projection.runs.some(
                  (source) => source.id === item.runId && source.ordinal < run.ordinal,
                ),
            ),
            createdAt,
          });
          return { handoff, transferId, createdAt };
        },
      );
      const recoveryHandoff = yield* Effect.cached(prepareRecoveryHandoff());
      const withRecoveryHandoff = (handoff: OrchestrationV2ContextHandoff) => {
        // Delivery ranks later handoffs as newer history. Pending handoffs from
        // earlier runs predate this summary; handoffs for this run (provider-switch
        // delta, merge-back) are newer and must stay last.
        return [
          ...effectiveHandoffs.filter((candidate) => candidate.targetRunId !== run.id),
          handoff,
          ...effectiveHandoffs.filter((candidate) => candidate.targetRunId === run.id),
        ];
      };
      let resumedRetryHandoff: ReadonlyArray<OrchestrationV2ContextHandoff> | undefined;
      let resumedHandoffContext: ReturnType<typeof handoffContextForThread> | undefined;
      let portableForkFallback: OrchestrationV2ContextHandoff | undefined;
      let recoveryTurnItem: OrchestrationV2TurnItem | undefined;
      const loadedProviderThread = yield* Effect.gen(function* () {
        if (nativeForkTransfer !== undefined) {
          const sourceProjection = yield* projectionStore.getThreadRecords(
            nativeForkTransfer.sourceThreadId,
            ["runs", "providerThreads", "attempts", "providerTurns"],
          );
          const sourceRun = sourceProjection.runs.find(
            (candidate) => candidate.id === nativeForkTransfer.sourcePoint.runId,
          );
          const sourceProviderThread = sourceProjection.providerThreads.find(
            (candidate) => candidate.id === sourceRun?.providerThreadId,
          );
          const sourceAttempt = sourceProjection.attempts.find(
            (candidate) => candidate.id === sourceRun?.activeAttemptId,
          );
          const sourceProviderTurn =
            latestProviderTurnForAttempt(sourceProjection.providerTurns, sourceAttempt?.id) ??
            sourceProjection.providerTurns.find(
              (candidate) => candidate.id === sourceAttempt?.providerTurnId,
            );
          if (sourceRun === undefined || sourceProviderThread === undefined) {
            return yield* new ProviderTurnStartError({
              runId,
              cause: `Native fork transfer ${nativeForkTransfer.id} has no source provider execution.`,
            });
          }
          // Providers refuse to fork a busy thread, so a source that started a turn after
          // dispatch planned this fork gets the portable context dispatch gives a busy source.
          const sourceBusy = sourceProjection.runs.some(
            (candidate) => candidate.ordinal > sourceRun.ordinal && isActiveRun(candidate),
          );
          let nativeForkFailure: string | undefined;
          if (!sourceBusy) {
            // Rolled-back turns are no longer in the source conversation, so they cannot bound a fork.
            const rolledBackAttemptIds = new Set(
              sourceProjection.attempts
                .filter((attempt) =>
                  sourceProjection.runs.some(
                    (candidate) =>
                      candidate.id === attempt.runId && candidate.status === "rolled_back",
                  ),
                )
                .map((attempt) => attempt.id),
            );
            if (!(yield* canPrepare())) return undefined;
            const forked = yield* Effect.result(
              session.forkThread({
                sourceProviderThread,
                sourceProviderTurns: sourceProjection.providerTurns.filter(
                  (turn) =>
                    turn.runAttemptId === null || !rolledBackAttemptIds.has(turn.runAttemptId),
                ),
                targetThreadId: projection.thread.id,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
                ...(sourceProviderTurn === undefined
                  ? {}
                  : { providerTurnId: sourceProviderTurn.id }),
              }),
            );
            if (!(yield* canPrepare())) return undefined;
            if (forked._tag === "Success") return forked.success;
            if (input.willRetry === true) return yield* forked.failure;
            if (!(yield* canPrepare())) return undefined;
            // Retries are spent (e.g. the source's native session is gone): start fresh with portable history.
            yield* Effect.logWarning("Starting a native fork in a fresh native session", {
              driver: session.driver,
              providerThreadId: providerThread.id,
              sourceProviderThreadId: sourceProviderThread.id,
              runId,
              errorTag: forked.failure._tag,
            });
            nativeForkFailure = makeProviderFailure({
              cause: forked.failure,
              message: startFailureMessage(forked.failure),
              class: "provider_error",
            }).message;
          }
          const nativeForkFailed = nativeForkFailure !== undefined;
          const sourceItems = yield* ContextHandoffService.readForkHistoryItems(
            projectionStore,
            sourceProjection,
            sourceRun,
          );
          const createdAt = yield* DateTime.now;
          const handoff = yield* contextHandoffService.prepareProviderHandoff({
            threadId: projection.thread.id,
            targetRunId: run.id,
            transferId: nativeForkTransfer.id,
            fromProviderThreadIds: [sourceProviderThread.id],
            toProviderThreadId: providerThread.id,
            fromProviderInstanceId: sourceRun.providerInstanceId,
            toProviderInstanceId: run.providerInstanceId,
            coveredRunOrdinals: ContextHandoffService.visibleDeltaRunOrdinals(
              sourceProjection,
              sourceItems,
            ),
            strategy: "full_thread_summary",
            items: sourceItems,
            runs: sourceProjection.runs,
            createdAt,
          });
          const loaded = yield* loadFromProvider(
            session.ensureThread({
              threadId: projection.thread.id,
              title: projection.thread.title,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              providerSessionId,
              existingProviderThread: nativeForkFailed
                ? { ...providerThread, nativeThreadRef: null, forkedFrom: null }
                : { ...providerThread, forkedFrom: null },
              // The failed fork may have left the adapter's session half-switched.
              ...(nativeForkFailed ? { forceNewNativeThread: true } : {}),
            }),
          );
          if (loaded === undefined) return undefined;
          portableForkFallback = handoff;
          effectiveHandoffs = [handoff, ...effectiveHandoffs];
          yield* eventSink.write({
            events: [
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "context-handoff.updated",
                threadId: projection.thread.id,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: createdAt,
                payload: handoff,
              },
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "context-transfer.updated",
                threadId: projection.thread.id,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: createdAt,
                payload: {
                  ...nativeForkTransfer,
                  targetProviderInstanceId: run.providerInstanceId,
                  status: "resolved_portable",
                  resolution: { strategy: "portable_context", contextHandoffId: handoff.id },
                  error: null,
                  updatedAt: createdAt,
                },
              },
              ...(nativeForkFailure === undefined
                ? []
                : [
                    {
                      id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                      type: "turn-item.updated" as const,
                      threadId: projection.thread.id,
                      runId: run.id,
                      providerInstanceId: run.providerInstanceId,
                      occurredAt: createdAt,
                      payload: {
                        id: idAllocator.derive.runSignalTurnItem({
                          runId,
                          signal: "native-fork-fallback",
                        }),
                        threadId: projection.thread.id,
                        runId,
                        nodeId: rootNode.id,
                        providerThreadId: providerThread.id,
                        providerTurnId: null,
                        nativeItemRef: null,
                        parentItemId: null,
                        ordinal:
                          Math.max(
                            0,
                            ...projection.turnItems
                              .filter((item) => item.runId === runId)
                              .map((item) => item.ordinal),
                          ) + 1,
                        status: "completed" as const,
                        title: "Native fork failed",
                        startedAt: createdAt,
                        completedAt: createdAt,
                        updatedAt: createdAt,
                        type: "system_notice" as const,
                        message: `Could not fork the source conversation natively (${nativeForkFailure}). Started a fresh session with its history.`,
                      },
                    },
                  ]),
            ],
          });
          return loaded;
        }
        if (providerThread.nativeThreadRef === null) {
          if (legacyNativeId !== undefined) {
            const original = {
              ...providerThread,
              nativeThreadRef: {
                driver: providerThread.driver,
                nativeId: legacyNativeId,
                strength: "strong" as const,
              },
              nativeMetadata: { ...providerThread.nativeMetadata, ...legacyNativeMetadata },
              ...(savedLegacyHistory?.success?.headId === undefined
                ? {}
                : {
                    nativeConversationHeadRef: {
                      driver: providerThread.driver,
                      nativeId: savedLegacyHistory.success.headId,
                      strength: "strong" as const,
                    },
                  }),
            };
            return yield* loadFromProvider(
              session
                .resumeThread({
                  providerThread: original,
                  threadId: projection.thread.id,
                  modelSelection: run.modelSelection,
                  runtimePolicy: resolvedRuntimePolicy,
                })
                .pipe(
                  Effect.flatMap((loaded) =>
                    loaded.id === original.id &&
                    loaded.appThreadId === original.appThreadId &&
                    loaded.driver === original.driver &&
                    loaded.providerInstanceId === original.providerInstanceId &&
                    loaded.providerSessionId === original.providerSessionId &&
                    loaded.nativeThreadRef?.driver === original.driver &&
                    loaded.nativeThreadRef.nativeId === legacyNativeId &&
                    loaded.nativeThreadRef.strength === "strong"
                      ? Effect.succeed({
                          ...loaded,
                          nativeMetadata: {
                            ...loaded.nativeMetadata,
                            ...legacyNativeMetadata,
                          },
                        })
                      : Effect.fail(
                          new ProviderAdapter.ProviderAdapterProtocolError({
                            driver: original.driver,
                            detail: "The provider did not return the original saved conversation.",
                          }),
                        ),
                  ),
                ),
            );
          }
          // Pass the stored provider row for adoption; adapter-minted duplicates make activeProviderThreadId flap.
          return yield* loadFromProvider(
            session.ensureThread({
              threadId: projection.thread.id,
              title: projection.thread.title,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              providerSessionId,
              existingProviderThread: providerThread,
              ...(botOwner !== undefined && !botOwner.restrictedTools && botOwner.tools.length > 0
                ? {
                    newBotTools: {
                      tools: botOwner.tools,
                      authorize: canPrepare().pipe(
                        Effect.map((active) => active && botOwner.isCurrent()),
                        Effect.orElseSucceed(() => false),
                      ),
                    },
                  }
                : {}),
            }),
          );
        }
        const uncertainDelivery = projection.contextHandoffs.some(
          (handoff) =>
            handoff.toProviderThreadId === providerThread.id &&
            handoff.delivery?.nativeThreadId === providerThread.nativeThreadRef?.nativeId &&
            handoff.delivery?.status === "pending",
        );
        if (isIdleRoute && !(yield* stillAuthorized("starting"))) return yield* refuseIdleStart();
        if (botOwner !== undefined && !botOwner.isCurrent())
          return yield* refuseBotStart(
            "The original bot turn ended before loading the native conversation.",
          );
        if (!(yield* canPrepare())) return undefined;
        const resumed = yield* Effect.result(
          uncertainDelivery
            ? Effect.fail(
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: projection.thread.id,
                  providerThreadId: providerThread.id,
                  runId,
                  cause: "Uncertain native history injection",
                }),
              )
            : session.resumeThread({
                providerThread,
                threadId: projection.thread.id,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
              }),
        );
        if (!(yield* canPrepare())) return undefined;
        const avoidsHistoryReplay =
          legacyGeneration ||
          grokLegacyHistory ||
          cursorLegacyHistory ||
          (run.ordinal === 1 && ownsSourceImportedNativeHistory(projection.thread, providerThread));
        if (avoidsHistoryReplay || cursorTransport === "acp" || originalStoreCwd !== undefined) {
          if (resumed._tag === "Failure") {
            return yield* loadFromProvider(Effect.fail(resumed.failure));
          }
          const expected = providerThread.nativeThreadRef;
          const actual = resumed.success.nativeThreadRef;
          if (
            expected == null ||
            actual?.strength !== "strong" ||
            actual.nativeId !== expected.nativeId ||
            actual.driver !== expected.driver
          ) {
            return yield* new ProviderTurnStartError({
              runId,
              cause: "The original imported native conversation could not be reopened.",
            });
          }
          if (avoidsHistoryReplay) return resumed.success;
        }
        if (resumed._tag === "Success") {
          const context = handoffContextForThread(resumed.success);
          context.budget = yield* Effect.cached(context.budget);
          resumedHandoffContext = context;
          resumedRetryHandoff = yield* prepareRetryHandoff(context);
          const fits = yield* deliverContextHandoffs({
            handoffs: [...handoffs, ...resumedRetryHandoff],
            providerThread: { ...resumed.success, id: providerThread.id },
            budget: context.budget,
            deferInline: isCompactionCommandMessage(providerMessage) || goalCommand,
            alreadyDeliveredItemIds: context.deliveredItemIds,
            persist: () => Effect.void,
          }).pipe(
            Effect.as(true),
            Effect.catchTags({ ContextHandoffBudgetError: () => Effect.succeed(false) }),
          );
          if (fits) return resumed.success;
          if (cursorTransport === "acp" || originalStoreCwd !== undefined) {
            return yield* loadFromProvider(
              Effect.fail(
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: projection.thread.id,
                  providerThreadId: providerThread.id,
                  runId,
                  cause: "The context handoff does not fit the original native conversation.",
                }),
              ),
            );
          }
          const freshThread = { ...resumed.success, nativeThreadRef: null };
          const freshContext = handoffContextForThread(freshThread);
          const { handoff } = yield* recoveryHandoff;
          const fitsFresh = yield* deliverContextHandoffs({
            handoffs: withRecoveryHandoff(handoff),
            providerThread: freshThread,
            budget: freshContext.budget,
            alreadyDeliveredItemIds: freshContext.deliveredItemIds,
            persist: () => Effect.void,
          }).pipe(
            Effect.as(true),
            Effect.catchTags({ ContextHandoffBudgetError: () => Effect.succeed(false) }),
          );
          if (!fitsFresh) return resumed.success;
          const hasPendingWork = yield* (
            session.hasPendingBackgroundWorkForThread?.(resumed.success, {
              includeSubagents: true,
            }) ??
              session.hasPendingBackgroundWork ??
              Effect.succeed(false)
          );
          if (hasPendingWork) {
            return yield* loadFromProvider(
              Effect.fail(
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: projection.thread.id,
                  providerThreadId: providerThread.id,
                  runId,
                  cause: new ContextHandoffBackgroundWorkError(),
                }),
              ),
            );
          }
        }
        if (isIdleRoute) return yield* refuseIdleStart();
        if (botOwner !== undefined)
          return yield* refuseBotStart(
            "The bot's original provider conversation could not be loaded.",
          );
        resumedHandoffContext = undefined;
        resumedRetryHandoff = [];
        if (!(yield* canPrepare())) return undefined;
        // Another client is still writing to the native thread. A fresh
        // session here would silently split the conversation from it.
        if (
          resumed._tag === "Failure" &&
          resumed.failure._tag === "ProviderAdapterThreadInUseError"
        ) {
          return yield* loadFromProvider(Effect.fail(resumed.failure));
        }

        yield* Effect.logWarning("Recovering provider context in a fresh native session", {
          driver: session.driver,
          providerThreadId: providerThread.id,
          runId,
          reason: uncertainDelivery
            ? "uncertain_history_delivery"
            : resumed._tag === "Success"
              ? "handoff_budget_exhausted"
              : "resume_failed",
          errorTag: resumed._tag === "Failure" ? resumed.failure._tag : "ContextHandoffBudgetError",
        });
        const replacement = yield* loadFromProvider(
          session.ensureThread({
            threadId: projection.thread.id,
            title: projection.thread.title,
            modelSelection: run.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
            providerSessionId,
            // Clear the native ref to force a fresh session while preserving row identity.
            existingProviderThread: { ...providerThread, nativeThreadRef: null },
            forceNewNativeThread: true,
          }),
        );
        if (replacement === undefined) return undefined;
        const { handoff, transferId, createdAt } = yield* recoveryHandoff;
        effectiveHandoffs = withRecoveryHandoff(handoff);
        resumeFellBack = true;
        const previousRun = projection.runs.findLast(
          (candidate) =>
            candidate.providerThreadId === providerThread.id &&
            candidate.ordinal < run.ordinal &&
            candidate.startedAt !== null,
        );
        // Stable per run so a retried start reuses the reserved run-start position.
        const handoffTurnItemId = idAllocator.derive.runSignalTurnItem({
          runId,
          signal: "resume-fallback-handoff",
        });
        const handoffTurnItem: OrchestrationV2TurnItem = {
          id: handoffTurnItemId,
          threadId: projection.thread.id,
          runId,
          nodeId: rootNode.id,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          // The summary is delivered ahead of this run's own handoffs and message.
          ordinal: yield* turnItemPositions.allocate({
            threadId: projection.thread.id,
            turnItemId: handoffTurnItemId,
            runId,
            runOrdinal: run.ordinal,
            placement: "run_start",
          }),
          status: "completed",
          title: "Recovered context",
          startedAt: createdAt,
          completedAt: createdAt,
          updatedAt: createdAt,
          type: "handoff",
          contextHandoffId: handoff.id,
          fromProviderThreadIds: handoff.fromProviderThreadIds,
          toProviderThreadId: handoff.toProviderThreadId,
          fromProviderInstanceIds: [providerThread.providerInstanceId],
          toProviderInstanceId: run.providerInstanceId,
          fromModelSelections: previousRun === undefined ? [] : [previousRun.modelSelection],
          toModel: run.modelSelection.model,
          strategy: handoff.strategy,
          summary: handoff.summaryText,
        };
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
              type: "context-handoff.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: createdAt,
              payload: handoff,
            },
            {
              id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
              type: "context-transfer.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: createdAt,
              payload: {
                id: transferId,
                type: "provider_handoff",
                sourceThreadId: projection.thread.id,
                targetThreadId: projection.thread.id,
                sourcePoint: { threadId: projection.thread.id },
                basePoint: null,
                sourceProviderInstanceId: providerThread.providerInstanceId,
                targetProviderInstanceId: run.providerInstanceId,
                targetRunId: run.id,
                status: "resolved_portable",
                resolution: { strategy: "portable_context", contextHandoffId: handoff.id },
                createdBy: "system",
                error: null,
                createdAt,
                updatedAt: createdAt,
                consumedAt: null,
              },
            },
          ],
        });
        recoveryTurnItem = handoffTurnItem;
        return replacement;
      });
      if (loadedProviderThread === undefined) return;
      if (
        botResume &&
        (loadedProviderThread.id !== botResume.providerThreadId ||
          loadedProviderThread.providerSessionId !== botResume.providerSessionId ||
          loadedProviderThread.nativeThreadRef?.nativeId !== botResume.nativeThreadId ||
          loadedProviderThread.nativeThreadRef?.strength !== "strong" ||
          session.providerSession.id !== botResume.providerSessionId)
      ) {
        return yield* refuseBotStart(
          "The provider returned a different native conversation for Resume.",
        );
      }
      if (!(yield* canPrepare())) {
        return;
      }
      const now = yield* DateTime.now;
      const handoffContext = resumedHandoffContext ?? handoffContextForThread(loadedProviderThread);
      const {
        sameNativeThread,
        handoffUsage,
        deliveredItemIds,
        acceptedAttempts,
        nativeInputRunIds,
        legacyInputRunIds,
        budget,
      } = handoffContext;
      if (manualResume && unsentResumeMessage === undefined && session.resumeTurn === undefined) {
        yield* settleStartFailure({
          signal: "resume-unsupported",
          title: "Native resume is unavailable",
          error: new ProviderAdapter.ProviderResumeUnsupportedError({
            driver: session.driver,
            providerThreadId: providerThread.id,
          }),
        });
        return;
      }
      const retryHandoff = resumedRetryHandoff ?? (yield* prepareRetryHandoff(handoffContext));
      if (!(yield* canPrepare())) return;
      const runningProviderThread: OrchestrationV2ProviderThread = {
        ...loadedProviderThread,
        contextUsage: handoffUsage,
        id: providerThread.id,
        driver: session.driver,
        providerInstanceId: run.providerInstanceId,
        providerSessionId,
        appThreadId: projection.thread.id,
        ownerNodeId: providerThread.ownerNodeId,
        firstRunOrdinal: providerThread.firstRunOrdinal ?? run.ordinal,
        lastRunOrdinal: run.ordinal,
        handoffIds:
          portableForkFallback === undefined
            ? providerThread.handoffIds
            : [...providerThread.handoffIds, portableForkFallback.id],
        forkedFrom: portableForkFallback === undefined ? providerThread.forkedFrom : null,
        status: "active",
        createdAt: providerThread.createdAt,
        updatedAt: now,
      };
      const runningRun: OrchestrationV2Run = {
        ...run,
        status: "running",
        startedAt: run.startedAt ?? now,
      };
      const runningAttempt: OrchestrationV2RunAttempt = {
        ...attempt,
        ...(runningProviderThread.nativeThreadRef?.nativeId == null
          ? {}
          : { nativeThreadId: runningProviderThread.nativeThreadRef.nativeId }),
        status: "running",
        startedAt: now,
      };
      const runningRootNode: OrchestrationV2ExecutionNode = {
        ...rootNode,
        status: "running",
        startedAt: now,
      };
      const events: Array<OrchestrationV2DomainEvent> = [
        {
          id: yield* idAllocator.allocate.event({
            threadId: projection.thread.id,
            providerSessionId,
          }),
          type: "provider-session.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: session.providerSession,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "provider-thread.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningProviderThread,
        },
        ...(yield* Effect.forEach(reusedLegacyHandoffs, (handoff) =>
          Effect.gen(function* () {
            return {
              id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
              type: "context-handoff.updated" as const,
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: now,
              payload: { ...handoff, status: "superseded" as const, updatedAt: now },
            };
          }),
        )),
        ...(nativeForkTransfer === undefined ||
        portableForkFallback !== undefined ||
        runningProviderThread.nativeThreadRef === null
          ? []
          : [
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "context-transfer.updated" as const,
                threadId: projection.thread.id,
                runId: run.id,
                driver: session.driver,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...nativeForkTransfer,
                  targetProviderInstanceId: run.providerInstanceId,
                  targetRunId: run.id,
                  status: "consumed" as const,
                  resolution: {
                    strategy: "native_fork" as const,
                    providerThreadRef: runningProviderThread.nativeThreadRef,
                  },
                  error: null,
                  updatedAt: now,
                  consumedAt: now,
                },
              },
            ]),
        // Shown only once the replacement session commits with the running transition.
        ...(recoveryTurnItem === undefined
          ? []
          : [
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "turn-item.updated" as const,
                threadId: projection.thread.id,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: recoveryTurnItem,
              },
            ]),
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningRun,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "run-attempt.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningAttempt,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "node.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningRootNode,
        },
      ];
      const runningWrite = yield* eventSink.writeIfRunCurrent({
        threadId: projection.thread.id,
        runId: run.id,
        activeAttemptId: attempt.id,
        expectedStatus: "starting",
        events,
      });
      if (!runningWrite.committed) {
        return;
      }
      // Delegated (app_owned) children run their own runs; routing them here ingests their items twice.
      const routableSubagents = projection.subagents.filter(
        (subagent) =>
          subagent.origin === "provider_native" &&
          RunExecutionService.canRouteRelatedSubagent(subagent.status),
      );
      const persistHandoff = Effect.fn("ProviderTurnStartService.persist")(function* (
        handoff: OrchestrationV2ContextHandoff,
      ) {
        const updatedAt = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({
                threadId: projection.thread.id,
              }),
              type: "context-handoff.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: updatedAt,
              payload: { ...handoff, updatedAt },
            },
          ],
        });
      });
      const guardedSend = Effect.fn("ProviderTurnStartService.guardedSend")(function* (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
      ) {
        if (
          guardedStart === undefined ||
          idleCommand === null ||
          turnInput.runId !== idleCommand.runId ||
          turnInput.attemptId !== attempt.id ||
          turnInput.message.messageId !== idleCommand.messageId ||
          turnInput.providerThread.id !== runningProviderThread.id ||
          turnInput.providerThread.nativeThreadRef?.nativeId !==
            runningProviderThread.nativeThreadRef?.nativeId ||
          !modelSelectionsEqual(turnInput.modelSelection, idleCommand.modelSelection) ||
          strictSteerFingerprint(turnInput.runtimePolicy) !== idleCommand.policyFingerprint ||
          !(yield* stillAuthorized("running"))
        ) {
          return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
            driver: session.driver,
            threadId: run.threadId,
            providerThreadId: providerThread.id,
            runId,
            cause: "Idle route authorization changed.",
          });
        }
        const authorization = stillAuthorized("running").pipe(
          Effect.filterOrElse(
            (allowed) => !allowed || authorizeDelegationWrite === undefined,
            () => authorizeDelegationWrite ?? Effect.succeed(false),
          ),
        );
        yield* observeDispatchRejection(
          guardedStart(
            turnInput,
            ProviderUsageAnalytics.observeProviderWriteAuthorization(authorization),
          ),
        );
      });

      const authorizeOriginWrite = verifyOrigin.pipe(
        Effect.flatMap((verified) =>
          verified
            ? Effect.gen(function* () {
                const latest = yield* projectionStore.getThreadShell(run.threadId);
                return (
                  latest?.activeRunId === run.id &&
                  latest.activeProviderThreadId === providerThread.id &&
                  session.providerSession.id === run.mausbotOriginProviderSessionId &&
                  latest.pendingRuntimeRequest === null &&
                  latest.archivedAt == null &&
                  latest.deletedAt == null &&
                  ((!savedOrigin?.incidentBatch && !savedOrigin?.room) ||
                    !(latest.pendingBackgroundTasks?.length ?? 0)) &&
                  (!coordinatorContinuation ||
                    (ownsCoordinatorSession(runningProviderThread) &&
                      session.providerSession.id === coordinatorContinuation.providerSessionId &&
                      !(yield* projectionStore.hasRunInterruptRequest(
                        run.threadId,
                        coordinatorContinuation.predecessorRunId,
                      )))) &&
                  !(yield* projectionStore.hasRunInterruptRequest(run.threadId, run.id)) &&
                  (yield* isCurrentAttemptInStatus("running")) &&
                  botOwner?.isCurrent() === true
                );
              })
            : Effect.succeed(false),
        ),
        Effect.orElseSucceed(() => false),
      );
      const projectBotPrompt = (message: ProviderAdapter.ProviderAdapterV2TurnInput["message"]) =>
        parseGoalCommand(message) === null &&
        !isCompactionCommandMessage({ ...message, role: "user" }) &&
        message.text.trim().toLowerCase() !== "/logout"
          ? bot.prompt
          : "";
      const ordinarySend = Effect.fn("ProviderTurnStartService.sendWithBotContext")(function* (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
      ) {
        const failure = (cause: string) =>
          new ProviderAdapter.ProviderAdapterTurnStartError({
            driver: session.driver,
            threadId: run.threadId,
            providerThreadId: providerThread.id,
            runId,
            cause,
          });
        if (botOwner !== undefined) {
          if (
            botStart === undefined ||
            !botOwner.isCurrent() ||
            turnInput.runId !== run.id ||
            turnInput.attemptId !== attempt.id ||
            turnInput.message.messageId !== botOwner.owner?.messageId ||
            (botOwner.restrictedTools && !botStart.supportsRestrictedTools)
          ) {
            return yield* failure(
              "The original bot turn or its selected tool scope is no longer available.",
            );
          }
          const authorizeNativeWrite = savedOrigin
            ? authorizeOriginWrite
            : Effect.sync(botOwner.isCurrent).pipe(
                Effect.flatMap((current) =>
                  current
                    ? isCurrentAttemptInStatus("running").pipe(
                        Effect.flatMap((active) => {
                          if (!active || !botOwner.isCurrent() || !botResume) {
                            return Effect.succeed(active && botOwner.isCurrent());
                          }
                          return Effect.gen(function* () {
                            const verifyIncident = botResume.verifyIncident;
                            if (
                              verifyIncident &&
                              !(yield* Effect.tryPromise({
                                try: () => verifyIncident(run.id),
                                catch: (cause) => new ProviderTurnStartError({ runId, cause }),
                              }))
                            )
                              return false;
                            const latest = yield* projectionStore.getThreadShell(run.threadId);
                            const stopped =
                              (yield* projectionStore.hasRunInterruptRequest(
                                run.threadId,
                                run.id,
                              )) ||
                              (yield* projectionStore.hasRunInterruptRequest(
                                run.threadId,
                                botResume.sourceRunId,
                              ));
                            const project = Option.getOrUndefined(
                              yield* projects.getById(botResume.projectId),
                            );
                            const cwd = latest?.worktreePath ?? project?.workspaceRoot;
                            return (
                              project !== undefined &&
                              project.archivedAt == null &&
                              cwd !== undefined &&
                              path.resolve(cwd) === path.resolve(botResume.cwd) &&
                              !stopped &&
                              botOwner.isCurrent() &&
                              latest?.id === run.threadId &&
                              latest.projectId === botResume.projectId &&
                              latest.runtimeMode === botResume.runtimeMode &&
                              latest.interactionMode === botResume.interactionMode &&
                              latest.activeProviderThreadId === botResume.providerThreadId &&
                              latest.pendingRuntimeRequest === null &&
                              latest.archivedAt == null &&
                              latest.deletedAt == null
                            );
                          });
                        }),
                        Effect.orElseSucceed(() => false),
                      )
                    : Effect.succeed(false),
                ),
              );
          const recalled = yield* withHiveRecall(turnInput, bot.prompt.length);
          return yield* observeDispatchRejection(
            botStart.start(recalled, {
              prompt: botResume ? "" : bot.prompt,
              restrictedTools: botOwner.restrictedTools,
              tools: botOwner.tools,
              call: botOwner.call,
              authorizeNativeWrite: ProviderUsageAnalytics.observeProviderWriteAuthorization(
                authorizeNativeWrite.pipe(
                  Effect.filterOrElse(
                    (allowed) => !allowed || authorizeDelegationWrite === undefined,
                    () => authorizeDelegationWrite ?? Effect.succeed(false),
                  ),
                ),
              ),
            }),
          );
        }

        const prompt = projectBotPrompt(turnInput.message);
        if (!prompt) return yield* session.startTurn(turnInput);
        const combined = prompt + turnInput.message.text;
        if (combined.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS)
          return yield* failure("Bot context exceeds the provider input limit.");
        yield* session.startTurn({
          ...turnInput,
          message: { ...turnInput.message, text: combined },
          inlineContextLength: (turnInput.inlineContextLength ?? 0) + prompt.length,
        });
      });

      const startWithHandoffs = Effect.fn("ProviderTurnStartService.startWithHandoffs")(
        function* (turnInput: Parameters<typeof session.startTurn>[0], compact = false) {
          if (yield* runControls.hasUnpairedRunInterruptRequest()) return;
          if (botResume) {
            const {
              appContext: _appContext,
              inlineContextLength: _inline,
              resume: _resume,
              ...native
            } = turnInput;
            return yield* ordinarySend({
              ...native,
              ...(botResume.incidentNote === undefined ? { resume: true } : {}),
              message: {
                ...turnInput.message,
                text: botResume.incidentNote?.text ?? "",
                attachments: [],
              },
            });
          }
          if (coordinatorContinuation && !ownsCoordinatorSession(runningProviderThread)) {
            return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
              driver: session.driver,
              threadId: run.threadId,
              providerThreadId: providerThread.id,
              runId,
              cause: "The original coordinator provider session is no longer available.",
            });
          }
          const incident = savedOrigin?.incidentBatch;
          const room = savedOrigin?.room;
          const historyToSend =
            coordinatorContinuation || incident || room
              ? effectiveHandoffs.filter((handoff) => handoff.targetRunId === run.id)
              : [...effectiveHandoffs, ...retryHandoff];
          if (
            incident &&
            ((coordinatorContinuation && historyToSend.length) ||
              historyToSend.some((handoff) =>
                handoff.history?.messages.some((item) =>
                  incident.reports.some(
                    (report) =>
                      item.itemId ===
                      mausbotHistoryMessageId(run.threadId, report.nativeMessageId) + ":item",
                  ),
                ),
              ))
          ) {
            return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
              driver: session.driver,
              threadId: run.threadId,
              providerThreadId: providerThread.id,
              runId,
              cause: "The Chief report provider start would replay saved input.",
            });
          }
          if (
            room &&
            historyToSend.some((handoff) =>
              handoff.history?.messages.some(
                (item) =>
                  item.role !== "assistant" ||
                  room.currentRowIds.some(
                    (id) => item.itemId === mausbotHistoryMessageId(run.threadId, id) + ":item",
                  ),
              ),
            )
          )
            return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
              driver: session.driver,
              threadId: run.threadId,
              providerThreadId: providerThread.id,
              runId,
              cause:
                "Room history would introduce unauthorized current input or speaker authority.",
            });
          const delivery = yield* deliverContextHandoffs({
            handoffs: historyToSend,
            deferInline: compact || goalCommand,
            providerThread: runningProviderThread,
            budget,
            alreadyDeliveredItemIds: deliveredItemIds,
            ...(isIdleRoute ||
            (botOwner !== undefined && (!savedOrigin || authoredRoot)) ||
            session.injectHistory === undefined
              ? {}
              : {
                  inject: Effect.fn("ProviderTurnStartService.injectAuthorizedHistory")(function* (
                    history: ProviderAdapter.ProviderAdapterV2HistoricalContext,
                  ) {
                    const authorization = savedOrigin
                      ? authorizeOriginWrite
                      : authorizeDelegationWrite;
                    if (
                      savedOrigin &&
                      !authoredRoot &&
                      !coordinatorContinuation &&
                      !incident &&
                      !room &&
                      !history.messages.some(
                        (row) =>
                          row.itemId === savedOrigin.sourceMessageId + ":item" &&
                          row.role === "assistant",
                      )
                    )
                      return false;
                    if (
                      coordinatorContinuation &&
                      historyToSend.some((handoff) =>
                        handoff.history?.messages.some(
                          (row) => !history.messages.some((item) => item.itemId === row.itemId),
                        ),
                      )
                    )
                      return false;
                    if (authorization !== undefined && !(yield* authorization)) return false;
                    return yield* session.injectHistory!({
                      providerThread: runningProviderThread,
                      ...history,
                      ...(authorization === undefined
                        ? {}
                        : { authorizeDelegationWrite: authorization }),
                    });
                  }),
                }),
            persist: persistHandoff,
          });
          if (
            savedOrigin &&
            !authoredRoot &&
            (delivery.context !== "" ||
              ((run.contextHandoffId !== null ||
                (!coordinatorContinuation && !incident && !room)) &&
                historyToSend.length === 0))
          ) {
            yield* delivery.unsent;
            return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
              driver: session.driver,
              threadId: run.threadId,
              providerThreadId: providerThread.id,
              runId,
              cause: "The provider could not restore the saved assignment history separately.",
            });
          }
          if (
            !(yield* isCurrentAttemptInStatus("running")) ||
            (yield* runControls.hasUnpairedRunInterruptRequest())
          ) {
            yield* delivery.unsent;
            return;
          }
          if (authorizeDelegationWrite !== undefined && !(yield* authorizeDelegationWrite)) {
            yield* delivery.unsent;
            return;
          }
          if (isIdleRoute && !(yield* stillAuthorized("running"))) {
            yield* delivery.unsent;
            return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
              driver: session.driver,
              threadId: run.threadId,
              providerThreadId: providerThread.id,
              runId,
              cause: "Idle route authorization changed.",
            });
          }
          const start = isIdleRoute
            ? guardedSend
            : compact
              ? session.compactThread!
              : bot.prompt || botOwner !== undefined
                ? ordinarySend
                : session.startTurn;
          // Like history, the side chat context waits for a turn that sends a prompt.
          const sideChatContext =
            sideChatHandoff === undefined || compact || goalCommand
              ? ""
              : sideChatHandoff.summaryText;
          const context = [delivery.context, sideChatContext, restartNote]
            .filter((part) => part !== "")
            .join("\n\n");
          const { restartContinuationOfRunId: _resumedRunId, ...promptedInput } = turnInput;
          const text = goalCommand ? userText : withInlineContext(context, userText);
          const message = { ...turnInput.message, text };
          const startInput = noteContinuation ? promptedInput : turnInput;
          const { resume: _resume, ...contextInput } = startInput;
          const { message: resumeMessage, resume: _resumeIntent, ...resumeInput } = startInput;
          const resumeWithoutPrompt =
            !isIdleRoute && botOwner === undefined && turnInput.resume && context === ""
              ? session.resumeTurn
              : undefined;
          const botPrefixLength =
            !isIdleRoute && !compact && botOwner === undefined
              ? projectBotPrompt(message).length
              : 0;
          if (
            resumeWithoutPrompt === undefined &&
            botPrefixLength + text.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS
          ) {
            yield* delivery.unsent;
            return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
              driver: session.driver,
              threadId: run.threadId,
              providerThreadId: providerThread.id,
              runId,
              cause:
                "Shorten this message to fit the provider input limit with conversation history.",
            });
          }
          const operation = resumeWithoutPrompt
            ? resumeWithoutPrompt({ ...resumeInput, messageId: resumeMessage.messageId })
            : start({
                ...(context === "" ? startInput : contextInput),
                message,
                ...(text === userText
                  ? {}
                  : { inlineContextLength: text.length - userText.length }),
              });
          yield* operation.pipe(
            // Clear pending handoff markers for refused prompts so the next turn retains the native session.
            Effect.tapError((error) =>
              Ref.get(deadlineRefused).pipe(
                Effect.flatMap((refused) =>
                  refused || refusedBeforePrompt(error)
                    ? delivery.unsent.pipe(
                        Effect.catchCause(() =>
                          Effect.logWarning("Failed to restore unsent context handoffs", {
                            runId: run.id,
                          }),
                        ),
                      )
                    : Effect.void,
                ),
              ),
            ),
          );
          if (yield* Ref.get(deadlineRefused)) {
            yield* delivery.unsent;
            return;
          }
          // After provider acceptance, failed delivery bookkeeping must not stop live ingestion.
          const nativeThreadId = runningProviderThread.nativeThreadRef?.nativeId;
          yield* Effect.forEach(
            [
              delivery.delivered,
              ...(sideChatContext === "" || sideChatHandoff === undefined || nativeThreadId == null
                ? []
                : [
                    persistHandoff({
                      ...sideChatHandoff,
                      toProviderThreadId: runningProviderThread.id,
                      delivery: { nativeThreadId, status: "inline" as const, itemIds: [] },
                    }),
                  ]),
            ],
            (record) =>
              record.pipe(
                Effect.catchCause(() =>
                  Effect.logWarning("Failed to record accepted context handoff delivery", {
                    runId: run.id,
                    deliveryStatus: "pending",
                  }),
                ),
              ),
            { discard: true },
          );
        },
        Effect.mapError((cause) =>
          cause._tag === "ProviderAdapterTurnStartError"
            ? cause
            : new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: session.driver,
                threadId: projection.thread.id,
                providerThreadId: providerThread.id,
                runId: run.id,
                cause,
              }),
        ),
      );
      const hasHandoffs =
        effectiveHandoffs.length !== 0 ||
        retryHandoff.length !== 0 ||
        sideChatHandoff !== undefined ||
        restartNote !== "" ||
        noteContinuation;
      const selectedSession = isIdleRoute
        ? {
            ...session,
            startTurn: hasHandoffs
              ? (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) =>
                  startWithHandoffs(turnInput)
              : guardedSend,
            resumeTurn: () => Effect.fail(refuseIdleProviderOperation()),
            compactThread: () => Effect.fail(refuseIdleProviderOperation()),
          }
        : botOwner !== undefined
          ? {
              ...session,
              // The captured bot continuation must reach the owner-checked start with no replayed input.
              startTurn:
                botResume || hasHandoffs
                  ? (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) =>
                      startWithHandoffs(turnInput)
                  : ordinarySend,
              resumeTurn: () => Effect.fail(refuseBotProviderOperation()),
              compactThread: () => Effect.fail(refuseBotProviderOperation()),
            }
          : hasHandoffs
            ? makeDeliverySession(session, startWithHandoffs)
            : bot.prompt
              ? { ...session, startTurn: ordinarySend }
              : session;
      // Adapter guards can refuse after async native preparation. A deadline refusal leaves
      // settlement to the durable deadline stop, without turning it into a provider error.
      const withDeadline =
        <A extends { readonly attemptId: RunAttemptId; readonly runId: RunId }>(
          send: (input: A) => Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error>,
        ) =>
        (input: A) =>
          Effect.gen(function* () {
            if (input.runId !== runId || input.attemptId !== attempt.id) return;
            if (authorizeDelegationWrite === undefined || !(yield* authorizeDelegationWrite))
              return;
            yield* send({ ...input, authorizeDelegationWrite }).pipe(
              Effect.catch((error) =>
                Ref.get(deadlineRefused).pipe(
                  Effect.flatMap((refused) => (refused ? Effect.void : Effect.fail(error))),
                ),
              ),
            );
          });
      const authorizedSession =
        authorizeDelegationWrite === undefined
          ? selectedSession
          : {
              ...selectedSession,
              startTurn: withDeadline(selectedSession.startTurn),
              ...(selectedSession.resumeTurn === undefined
                ? {}
                : {
                    resumeTurn: withDeadline(selectedSession.resumeTurn),
                  }),
              ...(selectedSession.compactThread === undefined
                ? {}
                : {
                    compactThread: withDeadline(selectedSession.compactThread),
                  }),
            };
      const providerOperationThreadId = run.threadId;
      const providerOperationProviderThreadId = providerThread.id;
      function refuseBotProviderOperation() {
        return new ProviderAdapter.ProviderAdapterTurnStartError({
          driver: session.driver,
          threadId: providerOperationThreadId,
          providerThreadId: providerOperationProviderThreadId,
          runId,
          cause: "The original bot turn can only start its captured message.",
        });
      }
      function refuseIdleProviderOperation() {
        return new ProviderAdapter.ProviderAdapterTurnStartError({
          driver: session.driver,
          threadId: providerOperationThreadId,
          providerThreadId: providerOperationProviderThreadId,
          runId,
          cause: "An idle route cannot resume or compact a turn.",
        });
      }
      const resume = manualResume && unsentResumeMessage === undefined;
      const readRouteIntake = eventSink.readRouteIntake;
      const routingIntake =
        !resume &&
        unsentResumeMessage === undefined &&
        !isIdleRoute &&
        botOwner === undefined &&
        run.restartContinuationOfRunId === undefined &&
        run.usageLimitContinuationOfRunId === undefined &&
        !isCompactionCommandMessage(message) &&
        typeof readRouteIntake === "function"
          ? yield* readRouteIntake({
              threadId: runningRun.threadId,
              runId: runningRun.id,
              messageId: message.id,
              projectId: projection.thread.projectId,
            }).pipe(Effect.orElseSucceed(() => undefined))
          : undefined;
      return runExecution.startRootRun({
        takeHiveTurnCapture,
        ...(routingIntake === undefined ? {} : { routingIntake }),
        commandId: CommandId.make(`command:effect:provider-turn.start:${run.id}`),
        appThread: projection.thread,
        providerSessionId,
        session: authorizedSession,
        run: runningRun,
        rootNode: runningRootNode,
        checkpointScope,
        providerThread: runningProviderThread,
        attempt: runningAttempt,
        attemptId: attempt.id,
        baseline,
        loadInheritedBackgroundTurnItems: runControls.loadInheritedBackgroundTurnItems,
        relatedThreadIds: routableSubagents.flatMap((subagent) =>
          subagent.childThreadId === null ? [] : [subagent.childThreadId],
        ),
        relatedProviderThreadIds: routableSubagents.flatMap((subagent) =>
          subagent.providerThreadId === null ? [] : [subagent.providerThreadId],
        ),
        providerTurnOrdinal:
          Math.max(
            0,
            ...projection.providerTurns
              .filter((turn) => turn.providerThreadId === providerThread.id)
              .map((turn) => turn.ordinal),
          ) + 1,
        resume,
        nativeThreadHasTurns:
          nativeInputRunIds.size > 0 ||
          (legacyInputRunIds.size > 0 &&
            sameNativeThread &&
            !acceptedAttempts.some((source) => source.nativeThreadId !== undefined)),
        shouldStartProviderTurn: () =>
          runControls
            .shouldStartProviderTurn()
            .pipe(Effect.flatMap((active) => (active ? deadlineCurrent : Effect.succeed(false)))),
        shouldFinalizeRun: runControls.shouldFinalizeRun,
        hasUnpairedRunInterruptRequest: runControls.hasUnpairedRunInterruptRequest,
        loadRunInterruptReason: runControls.loadRunInterruptReason,
        hasWorkspaceMoved: runControls.hasWorkspaceMoved,
        loadUnsettledWork: runControls.loadUnsettledWork,
        message: {
          messageId: message.id,
          text: userText,
          attachments: providerMessage.attachments,
          createdBy: message.createdBy,
          creationSource: message.creationSource,
          ...(message.scheduledTaskId === undefined
            ? {}
            : { scheduledTaskId: message.scheduledTaskId }),
          ...(message.senderThreadId === undefined
            ? {}
            : { senderThreadId: message.senderThreadId }),
        },
        modelSelection: run.modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
      });
    });

    return ProviderTurnStartServiceV2.of({
      start: Effect.fn("ProviderTurnStartService.start")(
        function* (input) {
          const capturedBot = captureBotExecutionContext(input.threadId);
          let startingRun: OrchestrationV2Run | undefined;
          const captureStartingRun = (run: OrchestrationV2Run) => {
            startingRun = run;
          };
          return yield* Effect.gen(function* () {
            // Storage cleanup removes worktrees under the same lease. Only startup
            // holds it; the provider turn runs after it is released.
            const { thread } = yield* projectionStore.getThreadRecords(input.threadId, []);
            const cwd =
              thread.worktreePath ??
              (yield* projects
                .getById(thread.projectId, { includeDeleted: true })
                .pipe(Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot)));
            const providerTurn = yield* cwd === undefined
              ? start(input, captureStartingRun, capturedBot)
              : withTurnStartReservation(
                  fileSystem,
                  path,
                  path.resolve(cwd),
                  thread.worktreePath === null
                    ? start(input, captureStartingRun, capturedBot)
                    : withWorkspaceLease(
                        path.resolve(thread.worktreePath),
                        start(input, captureStartingRun, capturedBot),
                      ),
                );
            if (providerTurn !== undefined) {
              // Run execution owns finalization after the running write. A later
              // failure must not settle a replacement attempt committed by steering.
              yield* providerTurn.pipe(
                Effect.catchCauseIf(
                  (cause) => !Cause.hasInterruptsOnly(cause),
                  (cause) =>
                    Effect.logWarning(
                      "Run execution failed after starting",
                      { runId: input.runId },
                      cause,
                    ),
                ),
              );
            }
          }).pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) =>
                Effect.fail(
                  new ProviderTurnStartError({
                    runId: input.runId,
                    cause: Cause.squash(cause),
                    ...(startingRun?.activeAttemptId == null || startingRun.rootNodeId == null
                      ? {}
                      : {
                          attemptId: startingRun.activeAttemptId,
                          rootNodeId: startingRun.rootNodeId,
                        }),
                  }),
                ),
            ),
          );
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnStartError(cause)
                ? cause
                : new ProviderTurnStartError({ runId: input.runId, cause }),
            ),
          ),
      ),
      failStartingRun: Effect.fn("ProviderTurnStartService.failStartingRun")(
        function* ({ threadId, runId, attemptId, rootNodeId }) {
          const projection = yield* projectionStore.getTurnStartContext(threadId, runId);
          const run = projection.runs.find((candidate) => candidate.id === runId);
          if (
            run === undefined ||
            run.status !== "starting" ||
            run.activeAttemptId !== attemptId ||
            run.rootNodeId !== rootNodeId
          )
            return;
          const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
          const attempt = projection.attempts.find(
            (candidate) => candidate.id === run.activeAttemptId,
          );
          if (rootNode === undefined || attempt === undefined) {
            return yield* new ProviderTurnStartRunStateMissingError({ runId });
          }
          yield* settleRunBeforeStart({
            run,
            rootNode,
            attempt,
            turnItems: projection.turnItems,
            signal: "provider-turn-start-failure",
            status: "failed",
            now: yield* DateTime.now,
            providerInstanceId: run.providerInstanceId,
            itemProviderThreadId: run.providerThreadId,
            item: {
              type: "error",
              title: "Turn failed to start",
              failure: makeProviderFailure({ message: START_GAVE_UP_MESSAGE }),
            },
          });
        },
        (effect, { runId }) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnStartRunStateMissingError(cause)
                ? cause
                : new ProviderTurnStartError({ runId, cause }),
            ),
          ),
      ),
    });
  }),
);
