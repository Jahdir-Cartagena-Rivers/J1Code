import {
  CommandId,
  MessageId,
  isRuntimeModeAbove,
  type ChatAttachment,
  type EnvironmentId,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2StrictSteerTarget,
  type ProjectId,
  type ProviderInstanceId,
  type RunId,
  type ThreadId,
} from "@j1code/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { CommandReceiptStoreV2 } from "../orchestration-v2/CommandReceiptStore.ts";
import {
  DispatchModeLimit,
  exceededDispatchModeLimit,
  type DispatchModes,
} from "../orchestration-v2/DispatchModeLimit.ts";
import { EffectOutboxV2, type OrchestrationEffectV2 } from "../orchestration-v2/EffectOutbox.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import {
  matchesStrictSteerTarget,
  strictSteerFingerprint,
  STRICT_STEER_EFFECT_PREFIX,
  supportsStrictSteering,
} from "../orchestration-v2/ProviderTurnControlService.ts";
import { RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";

type StrictCommand = Extract<OrchestrationV2InternalCommand, { type: "message.steer-strict" }>;

export interface AdmittedStrictRouteAttempt {
  readonly requestId: string;
  readonly attemptId: string;
  readonly source: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
  readonly destination: DispatchModes & {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly runId: RunId;
  };
  readonly ceiling: DispatchModes;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

export interface PreparedStrictRouteDelivery {
  readonly attempt: AdmittedStrictRouteAttempt;
  readonly command: StrictCommand;
}

export type StrictRouteDeliveryResult =
  | { readonly status: "admitted"; readonly effectId: string }
  | { readonly status: "delivered"; readonly effectId: string }
  | { readonly status: "failed" | "cancelled"; readonly effectId: string }
  | { readonly status: "rejected"; readonly reason: "admission" | "target" | "command" | "changed-intent" }
  | { readonly status: "uncertain"; readonly reason: "absent" | "ambiguous" | "unreadable" };

type StrictRouteRejection = Extract<StrictRouteDeliveryResult, { status: "rejected" }>;

/** Hold the route admission lock through submitOnce, with a durable one-shot claim and rechecked ceiling. */
export type WithLockedStrictRouteAdmission<E, R> = (
  delivery: PreparedStrictRouteDelivery,
  submitOnce: (lockedCeiling: DispatchModes) => Effect.Effect<StrictRouteDeliveryResult>,
) => Effect.Effect<StrictRouteDeliveryResult, E, R>;

const reject = (reason: StrictRouteRejection["reason"]): StrictRouteRejection => ({
  status: "rejected",
  reason,
});

type StrictRouteUncertainty = Extract<StrictRouteDeliveryResult, { status: "uncertain" }>;

const uncertain = (reason: StrictRouteUncertainty["reason"]): StrictRouteUncertainty => ({
  status: "uncertain",
  reason,
});

const currentRouteCeiling = Effect.fn("routing.currentRouteCeiling")(function* (ceiling: DispatchModes) {
  const existing = yield* DispatchModeLimit;
  if (existing === undefined) return ceiling;
  return {
    ...existing,
    runtimeMode: isRuntimeModeAbove(ceiling.runtimeMode, existing.runtimeMode)
      ? existing.runtimeMode : ceiling.runtimeMode,
    interactionMode: existing.interactionMode === "plan" ? "plan" as const : ceiling.interactionMode,
  };
});

function strictRouteCommand(attempt: AdmittedStrictRouteAttempt, target: OrchestrationV2StrictSteerTarget): StrictCommand {
  const identity = strictSteerFingerprint([attempt.requestId, attempt.attemptId]);
  return {
    type: "message.steer-strict",
    commandId: CommandId.make(`command:route-steer:${identity}`),
    messageId: MessageId.make(`message:route-steer:${identity}`),
    threadId: attempt.destination.threadId,
    target,
    text: attempt.text,
    attachments: attempt.attachments,
    createdBy: "agent",
    creationSource: "server",
    ...(attempt.source.environmentId === attempt.destination.environmentId
      ? { senderThreadId: attempt.source.threadId }
      : {}),
  };
}

function matchesPreparedDelivery({ attempt, command }: PreparedStrictRouteDelivery): boolean {
  const { destination } = attempt;
  const { target } = command;
  return target.projectId === destination.projectId &&
    target.providerInstanceId === destination.providerInstanceId &&
    target.runId === destination.runId &&
    target.runtimeMode === destination.runtimeMode &&
    target.interactionMode === destination.interactionMode &&
    strictSteerFingerprint(command) === strictSteerFingerprint(strictRouteCommand(attempt, target));
}

function classifyStrictRouteEffect(
  command: StrictCommand,
  rows: ReadonlyArray<OrchestrationEffectV2>,
): StrictRouteDeliveryResult {
  const [effect] = rows;
  if (effect === undefined) return uncertain("absent");
  const { target } = command;
  const { request } = effect;
  if (
    rows.length !== 1 ||
    effect.id !== `${STRICT_STEER_EFFECT_PREFIX}${strictSteerFingerprint(command)}` ||
    effect.commandId !== command.commandId ||
    effect.threadId !== command.threadId ||
    request.type !== "provider-turn.steer" ||
    request.messageId !== command.messageId ||
    request.providerSessionId !== target.providerSessionId ||
    request.providerThreadId !== target.providerThreadId ||
    request.providerTurnId !== target.providerTurnId ||
    request.modelSelection !== undefined ||
    request.steerFollowUpAfterRunOrdinal !== undefined
  ) {
    return uncertain("ambiguous");
  }
  switch (effect.status) {
    case "pending":
    case "running":
      return { status: "admitted", effectId: effect.id };
    case "succeeded":
      return effect.attemptCount === 1 && effect.completedAt !== null
        ? { status: "delivered", effectId: effect.id }
        : uncertain("ambiguous");
    case "failed":
      return { status: "failed", effectId: effect.id };
    case "cancelled":
      return { status: "cancelled", effectId: effect.id };
    default:
      return uncertain("ambiguous");
  }
}

const readStrictRouteEvidence = Effect.fn("routing.readStrictRouteEvidence")(function* (
  delivery: PreparedStrictRouteDelivery,
) {
  if (!matchesPreparedDelivery(delivery)) return reject("changed-intent");
  const receipts = yield* CommandReceiptStoreV2;
  const outbox = yield* EffectOutboxV2;
  const events = yield* EventSinkV2;
  const { command } = delivery;
  return yield* Effect.gen(function* () {
    const receipt = yield* receipts.getByCommandId(command.commandId);
    const effects = yield* outbox.listByCommandId(command.commandId);
    if (Option.isNone(receipt)) {
      return effects.length === 0 ? { status: "no-evidence" } as const : uncertain("ambiguous");
    }
    if (
      receipt.value.commandId !== command.commandId ||
      receipt.value.threadId !== command.threadId ||
      receipt.value.commandType !== command.type
    ) {
      return uncertain("ambiguous");
    }
    if (receipt.value.status === "rejected") {
      return effects.length === 0 ? reject("command") : uncertain("ambiguous");
    }
    const stored = yield* events.readByCommandId({ commandId: command.commandId }).pipe(Stream.runCollect);
    const messages = stored.flatMap(({ event }) =>
      event.type === "message.updated" && event.threadId === command.threadId
        ? [event.payload] : [],
    );
    const [message] = messages;
    if (messages.length !== 1 || message === undefined || message.strictSteer === undefined ||
      message.threadId !== command.threadId ||
      message.role !== "user") {
      return uncertain("ambiguous");
    }
    if (
      message.id !== command.messageId ||
      message.runId !== command.target.runId ||
      message.strictSteer.commandFingerprint !== strictSteerFingerprint(command) ||
      strictSteerFingerprint(message.strictSteer.target) !== strictSteerFingerprint(command.target)
    ) {
      return reject("changed-intent");
    }
    return classifyStrictRouteEffect(command, effects);
  }).pipe(Effect.orElseSucceed(() => uncertain("unreadable")));
});

const captureStrictRouteTarget = Effect.fn("routing.captureStrictRouteTarget")(function* (
  attempt: AdmittedStrictRouteAttempt,
  pinned?: OrchestrationV2StrictSteerTarget,
) {
  const orchestration = yield* OrchestratorV2;
  const runtimePolicy = yield* RuntimePolicyV2;
  const sessions = yield* ProviderSessionManagerV2;
  const { destination } = attempt;
  const ceiling = yield* currentRouteCeiling(attempt.ceiling);
  const { threadId } = destination;
  if (exceededDispatchModeLimit(ceiling, destination) !== undefined) return undefined;
  const initial = yield* orchestration.getThreadRecords(threadId, ["runs"], {
    runIds: [destination.runId],
  });
  const [initialRun] = initial.runs;
  if (
    initial.runs.length !== 1 || initialRun?.status !== "running" ||
    initialRun.activeAttemptId === null || initialRun.providerThreadId === null ||
    initialRun.providerInstanceId !== destination.providerInstanceId
  ) return undefined;

  const records = yield* orchestration.getThreadRecords(
    threadId, ["runs", "attempts", "providerThreads", "providerTurns"],
    {
      runIds: [destination.runId],
      attemptIds: [initialRun.activeAttemptId],
      providerThreadIds: [initialRun.providerThreadId],
      providerTurnAttemptIds: [initialRun.activeAttemptId],
    },
  );
  const { thread } = records;
  const [run] = records.runs;
  const [currentAttempt] = records.attempts;
  const [providerThread] = records.providerThreads;
  const running = records.providerTurns.filter((turn) => turn.status === "running");
  const [providerTurn] = running;
  if (
    records.runs.length !== 1 || records.attempts.length !== 1 ||
    records.providerThreads.length !== 1 || running.length !== 1 ||
    run === undefined || providerThread === undefined ||
    providerThread.providerSessionId === null || providerThread.nativeThreadRef?.nativeId == null ||
    providerTurn?.nativeTurnRef?.nativeId == null ||
    thread.projectId !== destination.projectId ||
    thread.providerInstanceId !== destination.providerInstanceId ||
    thread.runtimeMode !== destination.runtimeMode ||
    thread.interactionMode !== destination.interactionMode ||
    exceededDispatchModeLimit(ceiling, thread) !== undefined
  ) return undefined;

  const policy = yield* runtimePolicy.resolve({ thread, modelSelection: run.modelSelection })
    .pipe(Effect.catchTags({ RuntimePolicyAboveCeilingError: () => Effect.undefined }));
  if (policy === undefined || exceededDispatchModeLimit(ceiling, policy) !== undefined) return undefined;
  const target: OrchestrationV2StrictSteerTarget = {
    projectId: destination.projectId,
    runId: destination.runId,
    attemptId: initialRun.activeAttemptId,
    providerInstanceId: destination.providerInstanceId,
    providerSessionId: providerThread.providerSessionId,
    providerThreadId: providerThread.id,
    providerTurnId: providerTurn.id,
    nativeThreadId: providerThread.nativeThreadRef.nativeId,
    nativeTurnId: providerTurn.nativeTurnRef.nativeId,
    runtimeMode: destination.runtimeMode,
    interactionMode: destination.interactionMode,
    policyFingerprint: strictSteerFingerprint(policy),
  };
  if (
    !matchesStrictSteerTarget(threadId, target, {
      thread, run, attempt: currentAttempt, providerThread, providerTurn,
    }) ||
    (pinned !== undefined && strictSteerFingerprint(target) !== strictSteerFingerprint(pinned))
  ) return undefined;

  const live = yield* sessions.get(target.providerSessionId);
  if (Option.isNone(live) || live.value.strictSteering === undefined ||
    !supportsStrictSteering(live.value, target, attempt.attachments.length)) {
    return undefined;
  }
  return (yield* live.value.strictSteering.canSteer({ threadId, providerThread, target, policy }))
    ? target : undefined;
});

export const prepareV2StrictDelivery = Effect.fn("routing.prepareV2StrictDelivery")(function* (
  attempt: AdmittedStrictRouteAttempt,
) {
  const target = yield* captureStrictRouteTarget(attempt).pipe(Effect.option);
  if (Option.isNone(target)) return uncertain("unreadable");
  if (target.value === undefined) return reject("target");
  return {
    status: "prepared",
    delivery: { attempt, command: strictRouteCommand(attempt, target.value) },
  } as const;
});

export const reconcileV2StrictDelivery = Effect.fn("routing.reconcileV2StrictDelivery")(function* (
  delivery: PreparedStrictRouteDelivery,
) {
  const result = yield* readStrictRouteEvidence(delivery);
  return result.status === "no-evidence" ? uncertain("absent") : result;
});

export const submitV2StrictDelivery = Effect.fn("routing.submitV2StrictDelivery")(function* <E, R>(
  delivery: PreparedStrictRouteDelivery,
  withLockedAdmission: WithLockedStrictRouteAdmission<E, R>,
) {
  const orchestration = yield* OrchestratorV2;
  // Capture service references before passing the deferred work through the route owner's gate.
  const services = yield* Effect.context<OrchestratorV2 | RuntimePolicyV2 | ProviderSessionManagerV2 |
    CommandReceiptStoreV2 | EffectOutboxV2 | EventSinkV2>();
  let entered = false;
  const submit = (lockedCeiling: DispatchModes) => Effect.suspend(() => {
    if (entered) return Effect.succeed(uncertain("ambiguous"));
    entered = true;
    return Effect.gen(function* () {
      const previous = yield* readStrictRouteEvidence(delivery);
      if (previous.status !== "no-evidence") return previous;
      const ceiling = yield* currentRouteCeiling(lockedCeiling);
      const current = yield* captureStrictRouteTarget(delivery.attempt, delivery.command.target)
        .pipe(Effect.provideService(DispatchModeLimit, ceiling), Effect.option);
      if (Option.isNone(current)) return uncertain("unreadable");
      if (current.value === undefined) return reject("target");
      const dispatchCeiling = yield* currentRouteCeiling(delivery.attempt.ceiling)
        .pipe(Effect.provideService(DispatchModeLimit, ceiling));
      const dispatchError = yield* orchestration.dispatch(delivery.command).pipe(
        Effect.provideService(DispatchModeLimit, dispatchCeiling),
        Effect.as(undefined),
        Effect.catch((error) => Effect.succeed(error._tag)),
      );
      const result = yield* readStrictRouteEvidence(delivery);
      if (result.status !== "no-evidence") return result;
      return dispatchError === "OrchestratorThreadAboveModeLimitError" ||
        dispatchError === "OrchestratorRuntimeModeAboveCeilingError"
        ? reject("admission")
        : uncertain("absent");
    }).pipe(Effect.provide(services));
  });
  return yield* withLockedAdmission(delivery, submit);
});
