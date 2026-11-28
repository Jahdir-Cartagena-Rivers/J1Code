// @effect-diagnostics-next-line nodeBuiltinImport:off - Admission and replay synchronously compare the same fingerprint.
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@j1code/shared/relaySigning";
import { projectComposerContextForProvider } from "@j1code/shared/composerContextReferences";
import {
  MessageId,
  type ModelSelection,
  type NodeId,
  type RunId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  isOrchestrationV2WorkActive,
  type OrchestrationV2StrictSteerTarget,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
} from "@j1code/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderAdapter from "@j1code/provider-core/server/ProviderAdapter";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

export const STRICT_STEER_EFFECT_PREFIX = "effect:strict-steer:";

export function strictSteerFingerprint(value: unknown): string {
  return NodeCrypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

export const deadlineTaskRuns = (
  child: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "contextTransfers" | "messages">,
  task: OrchestrationV2Subagent,
) => {
  const initial = child.contextTransfers.find(
    (transfer) =>
      transfer.type === "subagent_spawn" &&
      transfer.targetThreadId === child.thread.id &&
      transfer.sourceThreadId === task.threadId &&
      transfer.sourcePoint.runId === task.runId,
  )?.targetRunId;
  const completionSources = new Map(
    child.messages.flatMap((message) =>
      message.delegatedCompletion === undefined
        ? []
        : [[message.id, message.delegatedCompletion.parentRunId] as const],
    ),
  );
  const owned = new Set<RunId>();
  return child.runs
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .filter((run) => {
      const prior =
        run.restartContinuationOfRunId ??
        run.usageLimitContinuationOfRunId ??
        run.manualContinuationOfRunId ??
        completionSources.get(run.userMessageId);
      if (
        run.id !== initial &&
        run.delegatedTaskId !== task.id &&
        (prior === undefined || !owned.has(prior))
      )
        return false;
      owned.add(run.id);
      return true;
    });
};

export const delegatedTaskOwner = Effect.fn("ProviderTurnControl.delegatedTaskOwner")(function* (
  projectionStore: ProjectionStore.ProjectionStoreV2["Service"],
  thread: OrchestrationV2AppThread,
  runId: RunId,
) {
  const parentId = thread.lineage.parentThreadId;
  const fork = thread.forkedFrom;
  if (
    thread.lineage.relationshipToParent !== "subagent" ||
    parentId === null ||
    fork?.type !== "node"
  ) {
    return undefined;
  }
  const { subagents } = yield* projectionStore.getThreadRecords(parentId, ["subagents"], {
    subagentIds: [fork.nodeId],
  });
  const task = subagents.find(
    (candidate) =>
      candidate.id === fork.nodeId &&
      candidate.threadId === parentId &&
      candidate.origin === "app_owned" &&
      candidate.childThreadId === thread.id,
  );
  if (task === undefined) return undefined;
  const child = yield* projectionStore.getThreadRecords(
    thread.id,
    ["runs", "contextTransfers", "messages"],
    {
      messageRoles: ["user"],
    },
  );
  return deadlineTaskRuns(child, task).some((run) => run.id === runId) ? task : undefined;
});

export function timedDelegationStartAllowed(
  task: OrchestrationV2Subagent | undefined,
  now: DateTime.Utc,
): boolean {
  return (
    task?.deadlineAt === undefined ||
    (isOpenDelegation(task) &&
      DateTime.toEpochMillis(task.deadlineAt) > DateTime.toEpochMillis(now))
  );
}

export function isOpenDelegation(task: OrchestrationV2Subagent): boolean {
  return (
    task.result === null &&
    task.cancelledRunId === undefined &&
    task.deadlineCancellationAt === undefined &&
    (isOrchestrationV2WorkActive(task.status) || task.status === "idle")
  );
}

export const readDelegationStartPermission = Effect.fn(
  "ProviderTurnControl.readDelegationStartPermission",
)(function* (
  projectionStore: ProjectionStore.ProjectionStoreV2["Service"],
  threadId: ThreadId,
  runId: RunId,
) {
  const owner = yield* delegatedTaskOwner(
    projectionStore,
    yield* projectionStore.getThread(threadId),
    runId,
  );
  return timedDelegationStartAllowed(owner, yield* DateTime.now);
});

type StrictSteerProjection = {
  readonly thread: OrchestrationV2AppThread;
  readonly run: OrchestrationV2Run | undefined;
  readonly attempt: OrchestrationV2RunAttempt | undefined;
  readonly providerThread: OrchestrationV2ProviderThread | undefined;
  readonly providerTurn: OrchestrationV2ProviderTurn | undefined;
};

export function matchesStrictSteerTarget(
  threadId: ThreadId,
  target: OrchestrationV2StrictSteerTarget,
  { thread, run, attempt, providerThread, providerTurn }: StrictSteerProjection,
): boolean {
  return (
    thread.id === threadId &&
    thread.deletedAt === null &&
    thread.archivedAt === null &&
    thread.projectId === target.projectId &&
    thread.activeProviderThreadId === target.providerThreadId &&
    thread.runtimeMode === target.runtimeMode &&
    thread.interactionMode === target.interactionMode &&
    run?.id === target.runId &&
    run.threadId === threadId &&
    run.status === "running" &&
    run.rootNodeId !== null &&
    run.activeAttemptId === target.attemptId &&
    run.providerInstanceId === target.providerInstanceId &&
    run.providerThreadId === target.providerThreadId &&
    attempt?.id === target.attemptId &&
    attempt.runId === run.id &&
    attempt.rootNodeId === run.rootNodeId &&
    attempt.status === "running" &&
    attempt.providerInstanceId === target.providerInstanceId &&
    attempt.providerThreadId === target.providerThreadId &&
    attempt.providerTurnId === target.providerTurnId &&
    providerThread?.id === target.providerThreadId &&
    providerThread.appThreadId === threadId &&
    providerThread.ownerNodeId === null &&
    providerThread.providerInstanceId === target.providerInstanceId &&
    providerThread.providerSessionId === target.providerSessionId &&
    providerThread.nativeThreadRef?.nativeId === target.nativeThreadId &&
    providerThread.nativeThreadRef.driver === providerThread.driver &&
    providerTurn?.id === target.providerTurnId &&
    providerTurn.providerThreadId === providerThread.id &&
    providerTurn.runAttemptId === attempt.id &&
    providerTurn.nodeId === run.rootNodeId &&
    providerTurn.status === "running" &&
    providerTurn.nativeTurnRef?.nativeId === target.nativeTurnId &&
    providerTurn.nativeTurnRef.driver === providerThread.driver
  );
}

type StrictSteerNativeTarget = {
  readonly threadId: ThreadId;
  readonly target: OrchestrationV2StrictSteerTarget;
  readonly session: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  readonly policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
};

export const STRICT_ROUTE_STEER_MESSAGE_PREFIX = "message:route-steer:";

export interface StrictRouteNativeAuthorizationInput {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly commandFingerprint: string;
  readonly target: OrchestrationV2StrictSteerTarget;
}

export class StrictRouteNativeAuthorization extends Context.Service<
  StrictRouteNativeAuthorization,
  {
    readonly authorize: (
      input: StrictRouteNativeAuthorizationInput,
    ) => Effect.Effect<string | null>;
  }
>()("@j1code/server/orchestration-v2/ProviderTurnControlService/StrictRouteNativeAuthorization") {}

/** The native implementation must compare the target and applied policy at the write boundary. */
export class StrictNativeSteeringV2 extends Context.Service<
  StrictNativeSteeringV2,
  {
    readonly canSteer: (
      input: StrictSteerNativeTarget,
    ) => Effect.Effect<boolean, ProviderAdapter.ProviderAdapterV2Error>;
    readonly steer: (
      input: StrictSteerNativeTarget & ProviderAdapter.ProviderAdapterV2SteerInput,
      stillAuthorized?: Effect.Effect<boolean>,
    ) => Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error>;
  }
>()("@j1code/server/orchestration-v2/ProviderTurnControlService/StrictNativeSteeringV2") {}

/** Bridges only explicit native strict operations; ordinary steering is never a fallback. */
export const layerStrictNativeSteering = Layer.effect(
  StrictNativeSteeringV2,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return StrictNativeSteeringV2.of({
      canSteer: Effect.fn("StrictNativeSteeringV2.canSteer")(function* (input) {
        if (input.session.strictSteering === undefined) return false;
        const records = yield* projections
          .getThreadRecords(input.threadId, ["providerThreads"], {
            providerThreadIds: [input.target.providerThreadId],
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterSteerRunError({
                  driver: input.session.driver,
                  providerThreadId: input.target.providerThreadId,
                  providerTurnId: input.target.providerTurnId,
                  cause,
                }),
            ),
          );
        const providerThread = records.providerThreads.find(
          (thread) => thread.id === input.target.providerThreadId,
        );
        if (providerThread === undefined) return false;
        return yield* input.session.strictSteering.canSteer({
          threadId: input.threadId,
          providerThread,
          target: input.target,
          policy: input.policy,
        });
      }),
      steer: Effect.fn("StrictNativeSteeringV2.steer")(function* (input, stillAuthorized) {
        if (input.session.strictSteering === undefined) {
          return yield* new ProviderAdapter.ProviderAdapterSteerRunError({
            driver: input.session.driver,
            providerThreadId: input.target.providerThreadId,
            providerTurnId: input.target.providerTurnId,
            cause: "This provider session has no exact-turn native steering implementation.",
          });
        }
        return yield* input.session.strictSteering.steer(
          {
            threadId: input.threadId,
            providerThread: input.providerThread,
            target: input.target,
            policy: input.policy,
            message: input.message,
          },
          stillAuthorized,
        );
      }),
    });
  }),
);

export function supportsStrictSteering(
  session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  target: OrchestrationV2StrictSteerTarget,
  attachmentCount: number,
): boolean {
  const { providerSession } = session;
  const { turns } = providerSession.capabilities;
  return (
    session.providerSessionId === target.providerSessionId &&
    session.instanceId === target.providerInstanceId &&
    providerSession.id === target.providerSessionId &&
    providerSession.providerInstanceId === target.providerInstanceId &&
    providerSession.status !== "stopped" &&
    providerSession.status !== "error" &&
    turns.supportsActiveSteering &&
    turns.activeSteeringInterruptsTools !== true &&
    (attachmentCount === 0 || turns.activeSteeringAcceptsAttachments !== false)
  );
}

function steeringMessage(
  message: import("@j1code/contracts").OrchestrationV2ConversationMessage,
): ProviderAdapter.ProviderAdapterV2TurnMessage {
  return {
    messageId: message.id,
    text: projectComposerContextForProvider({
      text: message.text,
      records: message.context?.records ?? [],
    }),
    attachments: message.attachments,
    createdBy: message.createdBy,
    creationSource: message.creationSource,
    ...(message.scheduledTaskId === undefined ? {} : { scheduledTaskId: message.scheduledTaskId }),
    ...(message.senderThreadId === undefined ? {} : { senderThreadId: message.senderThreadId }),
  };
}

const yieldToRuntime = Effect.yieldNow.pipe(
  Effect.andThen(
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          setImmediate(resolve);
        }),
    ),
  ),
);

export class ProviderTurnControlError extends Schema.TaggedError<ProviderTurnControlError>()(
  "ProviderTurnControlError",
  {
    threadId: ThreadId,
    operation: Schema.Literals(["interrupt", "restart", "steer"]),
    providerTurnId: ProviderTurnId,
    turnCompleted: Schema.optional(Schema.Boolean),
    steerDeclined: Schema.optional(Schema.Boolean),
    /** The provider never confirmed the stop; Force stop is the way out. */
    unresponsive: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isProviderTurnControlError = Schema.is(ProviderTurnControlError);

export interface ProviderTurnControlServiceV2Shape {
  readonly interrupt: (input: {
    readonly subagent?: {
      readonly id: NodeId;
      readonly nativeTaskId: string;
      readonly requestedAt?: DateTime.Utc;
    };
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
  }) => Effect.Effect<
    void | ProviderAdapter.ProviderAdapterV2SubagentOutcome,
    ProviderTurnControlError
  >;
  readonly steer: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
    readonly messageId: MessageId;
    readonly modelSelection?: ModelSelection;
    readonly strictCommandFingerprint?: string;
  }) => Effect.Effect<void, ProviderTurnControlError>;
  /** Best effort: a turn that ended or moved sessions picks the selection up when it next starts. */
  readonly applyModelSelection: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<
    void,
    | ProjectionStore.ProjectionStoreV2Error
    | ProviderSessionManager.ProviderSessionManagerV2Error
    | ProviderAdapter.ProviderAdapterV2Error
  >;
  /** Best effort: a provider thread that is no longer live picks the title up when its next turn starts. */
  readonly applyThreadTitle: (input: {
    readonly threadId: ThreadId;
    readonly title: string;
  }) => Effect.Effect<
    void,
    | ProjectionStore.ProjectionStoreV2Error
    | ProviderSessionManager.ProviderSessionManagerV2Error
    | ProviderAdapter.ProviderAdapterV2Error
  >;
  readonly interruptAndAwaitTerminal: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly replacementProviderSessionId?: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
    readonly interruptedAttemptId: RunAttemptId;
  }) => Effect.Effect<void, ProviderTurnControlError>;
}

export class ProviderTurnControlServiceV2 extends Context.Service<
  ProviderTurnControlServiceV2,
  ProviderTurnControlServiceV2Shape
>()("@j1code/server/orchestration-v2/ProviderTurnControlService/ProviderTurnControlServiceV2") {}

export const layer: Layer.Layer<
  ProviderTurnControlServiceV2,
  never,
  | EventSink.EventSinkV2
  | ProjectionStore.ProjectionStoreV2
  | ProviderSessionManager.ProviderSessionManagerV2
> = Layer.effect(
  ProviderTurnControlServiceV2,
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const strictNative = yield* Effect.serviceOption(StrictNativeSteeringV2);
    const routeAuthorization = yield* Effect.serviceOption(StrictRouteNativeAuthorization);
    const runtimePolicy = yield* Effect.serviceOption(RuntimePolicyV2);

    const load = Effect.fn("ProviderTurnControlService.load")(function* (input: {
      readonly threadId: ThreadId;
      readonly providerSessionId: ProviderSessionId;
      readonly replacementProviderSessionId?: ProviderSessionId;
      readonly providerThreadId: ProviderThreadId;
      readonly providerTurnId: ProviderTurnId;
      readonly operation: "interrupt" | "restart" | "steer";
      readonly messageId?: MessageId;
    }) {
      const context = yield* projections.getProviderControlContext(input.threadId, input);
      const { providerThread, providerTurn } = context;
      const targetsRecordedSession = providerThread?.providerSessionId === input.providerSessionId;
      const targetsCommittedReplacement =
        input.operation === "restart" &&
        input.replacementProviderSessionId !== undefined &&
        providerThread?.providerSessionId === input.replacementProviderSessionId;
      if (
        providerThread === undefined ||
        providerTurn === undefined ||
        (!targetsRecordedSession && !targetsCommittedReplacement) ||
        providerTurn.providerThreadId !== providerThread.id
      ) {
        return yield* new ProviderTurnControlError({
          threadId: input.threadId,
          operation: input.operation,
          providerTurnId: input.providerTurnId,
          cause: "The recorded provider execution target is no longer valid.",
        });
      }
      // A restart-session command commits the replacement binding before its
      // process-bound effect runs. The old live runtime must still receive
      // the interrupt, but only when the projection matches the exact
      // replacement captured by that same durable effect.
      const interruptProviderThread = targetsRecordedSession
        ? providerThread
        : { ...providerThread, providerSessionId: input.providerSessionId };
      const continuingRun =
        input.operation === "steer" &&
        context.run?.status === "running" &&
        context.run.activeAttemptId === providerTurn.runAttemptId;
      if (providerTurn.status !== "running" && !continuingRun) {
        if (input.operation === "steer") {
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: "steer",
            providerTurnId: input.providerTurnId,
            turnCompleted: providerTurn.status === "completed",
            cause: "The provider turn ended before the steering message was delivered.",
          });
        }
        return {
          context,
          providerThread: interruptProviderThread,
          providerTurn,
          session: Option.none(),
        };
      }
      const session = yield* sessions.get(input.providerSessionId);
      if (Option.isNone(session)) {
        // Interrupt/restart against a already-released session must not fail
        // the durable effect (and retry 5x). The turn may still look running
        // in projection until recovery/finalization; there is no live adapter
        // to interrupt.
        if (input.operation === "interrupt" || input.operation === "restart") {
          yield* Effect.logWarning(
            "Provider interrupt/restart found no live session; treating as already stopped",
            {
              threadId: input.threadId,
              operation: input.operation,
              providerSessionId: input.providerSessionId,
              providerTurnId: input.providerTurnId,
              providerTurnStatus: providerTurn.status,
            },
          );
          return {
            context,
            providerThread: interruptProviderThread,
            providerTurn,
            session: Option.none(),
          };
        }
        return yield* new ProviderTurnControlError({
          threadId: input.threadId,
          operation: input.operation,
          providerTurnId: input.providerTurnId,
          cause: `Provider session ${input.providerSessionId} is not active.`,
        });
      }
      return { context, providerThread: interruptProviderThread, providerTurn, session };
    });

    const awaitSettled = Effect.fn("ProviderTurnControlService.awaitSettled")(function* (
      threadId: ThreadId,
      target: ProjectionStore.ProjectionProviderControlTarget,
    ) {
      const isSettled = projections
        .getProviderControlContext(threadId, target)
        .pipe(
          Effect.map(
            ({ providerTurn, attempt }) =>
              providerTurn?.status !== "running" && attempt?.status !== "running",
          ),
        );
      const afterSequence = yield* eventSink.latestSequence({ threadId });
      if (yield* isSettled) return;
      yield* eventSink.stream({ threadId, afterSequence }).pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "provider-turn.updated" || event.type === "run-attempt.updated",
        ),
        Stream.mapEffect(() => isSettled),
        Stream.takeUntil((settled) => settled),
        Stream.runDrain,
      );
    });

    return ProviderTurnControlServiceV2.of({
      applyModelSelection: Effect.fn("ProviderTurnControlService.applyModelSelection")(
        function* (input) {
          const { providerThread, providerTurn } = yield* projections.getRunningTurnContext(
            input.threadId,
          );
          if (
            providerThread?.id !== input.providerThreadId ||
            providerThread.providerSessionId !== input.providerSessionId ||
            providerTurn === undefined
          ) {
            return;
          }
          const session = yield* sessions.get(input.providerSessionId);
          if (Option.isNone(session) || session.value.applyModelSelection === undefined) return;
          yield* session.value.applyModelSelection({
            providerThread,
            modelSelection: input.modelSelection,
          });
        },
      ),
      applyThreadTitle: Effect.fn("ProviderTurnControlService.applyThreadTitle")(function* (input) {
        const { thread, providerThreads } = yield* projections.getThreadRecords(input.threadId, [
          "providerThreads",
        ]);
        const providerThread = providerThreads.find(
          (candidate) => candidate.id === thread.activeProviderThreadId,
        );
        if (!providerThread?.providerSessionId) return;
        const session = yield* sessions.get(providerThread.providerSessionId);
        if (Option.isNone(session) || session.value.applyThreadTitle === undefined) return;
        yield* session.value.applyThreadTitle({ providerThread, title: input.title });
      }),
      interrupt: Effect.fn("ProviderTurnControlService.interrupt")(
        function* (input) {
          const loaded = yield* load({ ...input, operation: "interrupt" });
          const session = Option.isSome(loaded.session)
            ? loaded.session
            : yield* sessions.get(input.providerSessionId);
          if (Option.isNone(session)) {
            if (input.subagent !== undefined) {
              return yield* new ProviderTurnControlError({
                threadId: input.threadId,
                operation: "interrupt",
                providerTurnId: input.providerTurnId,
                cause: "No live provider session can confirm this subagent's outcome.",
              });
            }
            return;
          }
          if (input.subagent !== undefined) {
            if (session.value.stopSubagent === undefined) {
              return yield* new ProviderTurnControlError({
                threadId: input.threadId,
                operation: "interrupt",
                providerTurnId: input.providerTurnId,
                cause: "The provider does not support stopping a native subagent.",
              });
            }
            return yield* session.value.stopSubagent({
              providerThread: loaded.providerThread,
              nativeTaskId: input.subagent.nativeTaskId,
              ...(input.subagent.requestedAt === undefined
                ? {}
                : { requestedAt: input.subagent.requestedAt }),
            });
          }
          // Settled turns still reach adapters, which alone know whether background work remains.
          yield* session.value
            .interruptTurn({
              providerThread: loaded.providerThread,
              providerTurnId: loaded.providerTurn.id,
              requestRuntimeRestart: true,
            })
            .pipe(
              Effect.catchTags({
                ProviderAdapterInterruptTimeoutError: (cause) =>
                  Effect.fail(
                    new ProviderTurnControlError({
                      threadId: input.threadId,
                      operation: "interrupt",
                      providerTurnId: input.providerTurnId,
                      unresponsive: true,
                      cause,
                    }),
                  ),
              }),
            );
          if (loaded.providerTurn.status === "running") {
            // Let native terminal ingestion finalize the attempt before the Stop follow-up repairs it.
            const { runAttemptId } = loaded.providerTurn;
            yield* awaitSettled(input.threadId, {
              providerThreadId: input.providerThreadId,
              providerTurnId: input.providerTurnId,
              ...(runAttemptId === null ? {} : { attemptId: runAttemptId }),
            }).pipe(Effect.timeoutOption("2 seconds"));
          }
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnControlError(cause)
                ? cause
                : new ProviderTurnControlError({
                    threadId: input.threadId,
                    operation: "interrupt",
                    providerTurnId: input.providerTurnId,
                    cause,
                  }),
            ),
          ),
      ),
      interruptAndAwaitTerminal: Effect.fn("ProviderTurnControlService.interruptAndAwaitTerminal")(
        function* (input) {
          const loaded = yield* load({ ...input, operation: "restart" });
          if (Option.isNone(loaded.session)) {
            // Without a live adapter, no terminal event can arrive; proceed to detach/start without polling.
            if (loaded.providerTurn.status === "running") {
              yield* Effect.logWarning(
                "Provider restart interrupt skipped; no live session for a still-projected running turn",
                {
                  threadId: input.threadId,
                  providerSessionId: input.providerSessionId,
                  providerTurnId: input.providerTurnId,
                },
              );
            }
            return;
          }

          yield* loaded.session.value.interruptTurn({
            providerThread: loaded.providerThread,
            providerTurnId: loaded.providerTurn.id,
          });

          for (let remaining = 1_000; remaining > 0; remaining -= 1) {
            const { providerTurn, attempt } = yield* projections.getProviderControlContext(
              input.threadId,
              {
                providerThreadId: input.providerThreadId,
                providerTurnId: input.providerTurnId,
                attemptId: input.interruptedAttemptId,
              },
            );
            if (
              providerTurn !== undefined &&
              providerTurn.status !== "running" &&
              attempt !== undefined &&
              attempt.status !== "running"
            ) {
              return;
            }
            // Yield through Node's event loop; detached ingestion cannot advance a deterministic Effect clock.
            yield* yieldToRuntime;
          }
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: "restart",
            providerTurnId: input.providerTurnId,
            cause: `Provider turn ${input.providerTurnId} did not terminalize before restart.`,
          });
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnControlError(cause)
                ? cause
                : new ProviderTurnControlError({
                    threadId: input.threadId,
                    operation: "restart",
                    providerTurnId: input.providerTurnId,
                    cause,
                  }),
            ),
          ),
      ),
      steer: Effect.fn("ProviderTurnControlService.steer")(
        function* (input) {
          const context = yield* projections.getProviderControlContext(input.threadId, input);
          if (
            input.strictCommandFingerprint !== undefined ||
            context.message?.strictSteer !== undefined
          ) {
            const { message } = context;
            const target = message?.strictSteer?.target;
            const invalidTarget = () =>
              new ProviderTurnControlError({
                threadId: input.threadId,
                operation: "steer",
                providerTurnId: input.providerTurnId,
                cause: "The strict steering target or its runtime policy is no longer valid.",
              });
            if (
              input.strictCommandFingerprint === undefined ||
              input.modelSelection !== undefined ||
              message === undefined ||
              target === undefined ||
              message.strictSteer?.commandFingerprint !== input.strictCommandFingerprint ||
              message.id !== input.messageId ||
              message.threadId !== input.threadId ||
              message.runId !== target.runId ||
              message.role !== "user" ||
              target.providerSessionId !== input.providerSessionId ||
              target.providerThreadId !== input.providerThreadId ||
              target.providerTurnId !== input.providerTurnId ||
              Option.isNone(strictNative) ||
              Option.isNone(runtimePolicy)
            ) {
              return yield* invalidTarget();
            }
            const session = yield* sessions.get(input.providerSessionId);
            const { thread, runs, attempts, providerThreads, providerTurns } =
              yield* projections.getThreadRecords(
                input.threadId,
                ["runs", "attempts", "providerThreads", "providerTurns"],
                {
                  runIds: [target.runId],
                  attemptIds: [target.attemptId],
                  providerThreadIds: [target.providerThreadId],
                  providerTurnIds: [target.providerTurnId],
                },
              );
            const [run] = runs;
            const [attempt] = attempts;
            const [providerThread] = providerThreads;
            const [providerTurn] = providerTurns;
            if (
              Option.isNone(session) ||
              !supportsStrictSteering(session.value, target, message.attachments.length) ||
              run === undefined ||
              providerTurn === undefined ||
              providerThread === undefined ||
              session.value.driver !== providerThread.driver ||
              !matchesStrictSteerTarget(input.threadId, target, {
                thread,
                run,
                attempt,
                providerThread,
                providerTurn,
              })
            ) {
              return yield* invalidTarget();
            }
            const policy = yield* runtimePolicy.value.resolve({
              thread,
              modelSelection: run.modelSelection,
            });
            if (
              strictSteerFingerprint(policy) !== target.policyFingerprint ||
              (yield* projections.hasRunInterruptRequest(input.threadId, target.runId))
            ) {
              return yield* invalidTarget();
            }
            let stillAuthorized: Effect.Effect<boolean> | undefined;
            if (input.messageId.startsWith(STRICT_ROUTE_STEER_MESSAGE_PREFIX)) {
              if (Option.isNone(routeAuthorization)) return yield* invalidTarget();
              const readAuthorization = routeAuthorization.value.authorize({
                threadId: input.threadId,
                messageId: input.messageId,
                commandFingerprint: input.strictCommandFingerprint,
                target,
              });
              const authorizedIdentity = yield* readAuthorization;
              if (authorizedIdentity === null) return yield* invalidTarget();
              stillAuthorized = readAuthorization.pipe(
                Effect.map((current) => current === authorizedIdentity),
              );
            }
            return yield* strictNative.value.steer(
              {
                threadId: input.threadId,
                target,
                policy,
                session: session.value,
                runId: run.id,
                providerThread,
                providerTurnId: providerTurn.id,
                message: steeringMessage(message),
              },
              stillAuthorized,
            );
          }
          const ownership = context.message?.delegatedCompletion;
          if (ownership !== undefined) {
            const projection = yield* projections.getThreadRecords(input.threadId, ["runs"], {
              runIds: [ownership.parentRunId],
            });
            const cohort = projection.runs.find(
              (run) => run.id === ownership.parentRunId,
            )?.delegatedCompletion;
            if (
              cohort?.disposition !== "open" ||
              cohort.delivery?.messageId !== input.messageId ||
              cohort.delivery.generation !== ownership.generation ||
              cohort.delivery.taskIds.length === 0
            )
              return;
          }
          const loaded = yield* load({ ...input, operation: "steer" });
          if (Option.isNone(loaded.session)) return;
          const { message, run } = loaded.context;
          if (message === undefined || run === undefined) {
            return yield* new ProviderTurnControlError({
              threadId: input.threadId,
              operation: "steer",
              providerTurnId: input.providerTurnId,
              cause: "The persisted steering message or target run is missing.",
            });
          }
          yield* loaded.session.value
            .steerTurn({
              threadId: input.threadId,
              runId: run.id,
              providerThread: loaded.providerThread,
              providerTurnId: loaded.providerTurn.id,
              ...(input.modelSelection === undefined
                ? {}
                : { modelSelection: input.modelSelection }),
              message: steeringMessage(message),
            })
            .pipe(
              Effect.catchTags({
                ProviderAdapterSteerDeclinedError: (cause) =>
                  Effect.fail(
                    new ProviderTurnControlError({
                      threadId: input.threadId,
                      operation: "steer",
                      providerTurnId: input.providerTurnId,
                      steerDeclined: true,
                      cause,
                    }),
                  ),
              }),
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  if (isProviderTurnControlError(cause)) return yield* cause;
                  const current = yield* projections.getProviderControlContext(
                    input.threadId,
                    input,
                  );
                  const status = current.providerTurn?.status;
                  return yield* new ProviderTurnControlError({
                    threadId: input.threadId,
                    operation: "steer",
                    providerTurnId: input.providerTurnId,
                    turnCompleted: status === "completed",
                    cause,
                  });
                }),
              ),
            );
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnControlError(cause)
                ? cause
                : new ProviderTurnControlError({
                    threadId: input.threadId,
                    operation: "steer",
                    providerTurnId: input.providerTurnId,
                    cause,
                  }),
            ),
          ),
      ),
    });
  }),
);
