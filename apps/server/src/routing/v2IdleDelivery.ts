import {
  CommandId, EnvironmentId, MessageId, ProjectId, RunId, ThreadId,
  type OrchestrationV2IdleRouteCommand, type OrchestrationV2ProviderTurn,
  type OrchestrationV2RunAttempt, type OrchestrationV2ThreadShell,
} from "@j1code/contracts";
import { Effect, Option, Stream } from "effect";

import { CommandReceiptStoreV2 } from "../orchestration-v2/CommandReceiptStore.ts";
import { EffectOutboxV2, type OrchestrationEffectV2 } from "../orchestration-v2/EffectOutbox.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import type { StoredRoute } from "./durableRoutingStore.ts";
import { idleRouteIdentity, strictRouteDescriptorFingerprint, type IdleDeliveryEvidence } from "./routeState.ts";

export function idleRouteDraft(
  row: StoredRoute, attemptId: string, shell: OrchestrationV2ThreadShell,
): OrchestrationV2IdleRouteCommand {
  const { request } = row.state;
  const ids = idleRouteIdentity(request.requestId, attemptId);
  return {
    type: "thread.route.deliver-idle",
    commandId: CommandId.make(ids.commandId), messageId: MessageId.make(ids.messageId),
    runId: RunId.make(ids.runId), threadId: shell.id, requestId: request.requestId, attemptId,
    environmentId: EnvironmentId.make(request.source.environmentId),
    senderThreadId: ThreadId.make(request.source.threadId),
    sourceProjectId: ProjectId.make(request.source.projectId), projectId: shell.projectId,
    modelSelection: shell.modelSelection, activeProviderThreadId: shell.activeProviderThreadId,
    runtimeMode: shell.runtimeMode, interactionMode: shell.interactionMode,
    policyFingerprint: "unverified", authorityFingerprint: "unverified", text: request.content,
  };
}

export function idleStartEffect(
  command: OrchestrationV2IdleRouteCommand, effects: ReadonlyArray<OrchestrationEffectV2>,
) {
  const [effect] = effects;
  return effects.length === 1 && effect?.id === `effect:${command.commandId}:provider-turn.start:${command.runId}` &&
    effect.commandId === command.commandId && effect.threadId === command.threadId &&
    effect.request.type === "provider-turn.start" && effect.request.runId === command.runId
    ? effect : null;
}

export function confirmedIdleNativeTurn(
  command: OrchestrationV2IdleRouteCommand,
  firstAttempt: OrchestrationV2RunAttempt,
  attempt: OrchestrationV2RunAttempt | undefined,
  providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>,
): boolean {
  if (!attempt || attempt.id !== firstAttempt.id || attempt.runId !== command.runId ||
      attempt.providerInstanceId !== command.modelSelection.instanceId ||
      attempt.providerThreadId !== firstAttempt.providerThreadId) return false;
  const matching = providerTurns.filter((turn) => turn.runAttemptId === attempt.id &&
    turn.providerThreadId === attempt.providerThreadId && turn.nodeId === firstAttempt.rootNodeId &&
    turn.startedAt !== null && turn.status !== "pending" &&
    turn.nativeTurnRef?.strength === "strong" && turn.nativeTurnRef.nativeId !== null);
  return matching.length === 1 && (attempt.providerTurnId === null || matching[0]?.id === attempt.providerTurnId);
}

export const readIdleDeliveryEvidence = Effect.fn("routing.readIdleDeliveryEvidence")(
  function* (command: OrchestrationV2IdleRouteCommand) {
    const receipts = yield* CommandReceiptStoreV2;
    const outbox = yield* EffectOutboxV2;
    const events = yield* EventSinkV2;
    const projection = yield* ProjectionStoreV2;
    const receipt = yield* receipts.getByCommandId(command.commandId);
    const effects = yield* outbox.listByCommandId(command.commandId);
    const unknown = { evidence: "uncertain" as const };
    if (Option.isNone(receipt) || receipt.value.commandType !== command.type ||
        receipt.value.commandId !== command.commandId || receipt.value.threadId !== command.threadId) return unknown;
    if (receipt.value.status === "rejected")
      return effects.length === 0 ? { evidence: "failed" as const } : unknown;
    const effect = idleStartEffect(command, effects);
    if (effect === null || effect.attemptCount > 1) return unknown;

    const stored = yield* events.readByCommandId({ commandId: command.commandId }).pipe(Stream.runCollect);
    const initial = stored.flatMap(({ event }) =>
      event.type === "run-attempt.created" && event.threadId === command.threadId &&
      event.payload.runId === command.runId && event.payload.attemptOrdinal === 1 &&
      event.payload.reason === "initial" ? [event.payload] : []);
    const [firstAttempt] = initial;
    if (initial.length !== 1 || firstAttempt === undefined ||
        !stored.some(({ event }) => event.type === "run.created" && event.threadId === command.threadId &&
          event.payload.id === command.runId && event.payload.userMessageId === command.messageId &&
          event.payload.activeAttemptId === firstAttempt.id &&
          event.payload.providerInstanceId === command.modelSelection.instanceId) ||
        !stored.some(({ event }) => event.type === "message.updated" && event.threadId === command.threadId &&
          event.payload.id === command.messageId && event.payload.runId === command.runId &&
          event.payload.idleRouteFingerprint === strictRouteDescriptorFingerprint(command))) return unknown;

    if (effect.status === "pending" || effect.status === "running")
      return { evidence: "admitted" as const, effectId: effect.id };
    if (effect.status !== "succeeded" || effect.attemptCount !== 1 || effect.completedAt === null)
      return unknown;
    const records = yield* projection.getThreadRecords(command.threadId, ["attempts", "providerTurns"], {
      attemptIds: [firstAttempt.id], providerTurnAttemptIds: [firstAttempt.id],
    });
    const attempt = records.attempts.find(({ id }) => id === firstAttempt.id);
    const confirmed = confirmedIdleNativeTurn(command, firstAttempt, attempt, records.providerTurns);
    return { evidence: confirmed ? "delivered" : "uncertain" } satisfies { evidence: IdleDeliveryEvidence };
  },
  (effect) => effect.pipe(Effect.orElseSucceed(() => ({ evidence: "uncertain" as const }))),
);
