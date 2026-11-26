import {
  CommandId, RunId, latestProviderTurnForAttempt,
  type OrchestrationV2Command, type OrchestrationV2StoredEvent, type OrchestrationV2ThreadProjection,
  type ProviderSessionId, type ProviderThreadId, type ProviderTurnId, type MausbotIncidentRetryNote,
} from "@j1code/contracts";
import { latestExecutedRun, latestRootProviderFailure } from "@j1code/shared/orchestrationV2ThreadError";
import { modelSelectionsEqual } from "@j1code/shared/model";
import { stableStringify } from "@j1code/shared/relaySigning";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { MausbotNativeProofError } from "./MausbotNativeProofError.ts";

export const MAUSBOT_RESUME_PREFIX = "command:mausbot:resume:";
export const mausbotResumeCommandId = (source: RunId) => CommandId.make(MAUSBOT_RESUME_PREFIX + source);
export const MAUSBOT_RESUME_CURSOR_PREFIX = "j1-shared:v2:";

type Dispatch = Extract<OrchestrationV2Command, { type: "message.dispatch" }>;

export interface MausbotResumeTarget {
  readonly sourceRunId: RunId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly providerTurnId: ProviderTurnId;
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly incidentFailure?: string;
  readonly incidentNote?: MausbotIncidentRetryNote;
}

export const MausbotResume = Context.Reference<{
  readonly command: Dispatch;
  readonly target: MausbotResumeTarget;
  readonly current: () => boolean;
  readonly refresh: Effect.Effect<boolean, MausbotNativeProofError>;
} | undefined>("@j1code/server/orchestration-v2/MausbotResume", { defaultValue: () => undefined });

export function readMausbotResumeCursor(
  cursor: string, botId: string, threadId: string, signature: string,
): RunId | undefined {
  const prefix = MAUSBOT_RESUME_CURSOR_PREFIX + botId + ":" + threadId + ":" + signature + ":";
  if (!cursor.startsWith(prefix)) return undefined;
  const runId = cursor.slice(prefix.length);
  return /^(?:[\w:.-]|%[0-9A-F]{2})+$/u.test(runId) ? RunId.make(runId) : undefined;
}

export function findMausbotResumeTarget(projection: OrchestrationV2ThreadProjection, sourceRunId: RunId) {
  const run = projection.runs.find(row => row.id === sourceRunId);
  const thread = projection.thread;
  if (!run || run.threadId !== thread.id || !thread.bot ||
      run.delegatedTaskId !== undefined || run.providerThreadId === null ||
      run.activeAttemptId === null || run.rootNodeId === null ||
      !modelSelectionsEqual(run.modelSelection, thread.modelSelection) ||
      run.providerInstanceId !== thread.providerInstanceId ||
      thread.activeProviderThreadId !== run.providerThreadId) return undefined;
  const providerThread = projection.providerThreads.find(row => row.id === run.providerThreadId);
  const turn = latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId);
  const attempt = projection.attempts.find(row => row.id === run.activeAttemptId);
  if (!providerThread || providerThread.appThreadId !== thread.id || providerThread.ownerNodeId !== null ||
      providerThread.status === "archived" || providerThread.status === "closed" ||
      providerThread.providerInstanceId !== run.providerInstanceId || providerThread.providerSessionId === null ||
      providerThread.nativeThreadRef?.strength !== "strong" || !providerThread.nativeThreadRef.nativeId ||
      providerThread.nativeThreadRef.driver !== providerThread.driver ||
      !attempt || attempt.runId !== run.id || attempt.rootNodeId !== run.rootNodeId ||
      attempt.providerThreadId !== providerThread.id || attempt.providerInstanceId !== run.providerInstanceId ||
      (attempt.nativeThreadId !== undefined && attempt.nativeThreadId !== providerThread.nativeThreadRef.nativeId) ||
      !turn || turn.providerThreadId !== providerThread.id || turn.nodeId !== run.rootNodeId ||
      turn.nativeTurnRef?.strength !== "strong" || !turn.nativeTurnRef.nativeId ||
      turn.nativeTurnRef.driver !== providerThread.driver || turn.startedAt === null) {
    return undefined;
  }
  const session = projection.providerSessions.find(row => row.id === providerThread.providerSessionId);
  if (!session || session.providerInstanceId !== run.providerInstanceId ||
      session.driver !== providerThread.driver) return undefined;
  const target: MausbotResumeTarget = {
    sourceRunId, providerThreadId: providerThread.id, providerSessionId: session.id,
    providerTurnId: turn.id, nativeThreadId: providerThread.nativeThreadRef.nativeId,
    nativeTurnId: turn.nativeTurnRef.nativeId,
  };
  return { run, attempt, turn, session, target };
}

export function findMausbotIncidentFailure(projection: OrchestrationV2ThreadProjection, runId: RunId) {
  const source = findMausbotResumeTarget(projection, runId);
  if (!source || source.run.status !== "failed" || source.turn.status !== "failed" ||
      !source.run.activeAttemptId || !source.run.mausbotOriginStart?.rootSource ||
      source.run.mausbotOriginStart.dispatch !== "first" ||
      source.run.mausbotOriginStart.sourceMessageId !== source.run.userMessageId ||
      source.run.mausbotOriginProviderSessionId !== source.target.providerSessionId ||
      source.run.mausbotPromptless || latestExecutedRun(projection.runs)?.id !== runId ||
      source.session.status === "stopped" || source.session.status === "error" ||
      source.turn.runAttemptId !== source.run.activeAttemptId) return undefined;
  const { attempt } = source;
  if (attempt.status !== "failed" || attempt.reason !== "initial" || attempt.attemptOrdinal !== 1 ||
      attempt.nativeThreadId !== source.target.nativeThreadId) return undefined;
  return { ...source.target, attemptId: attempt.id };
}

function matchesIncidentFailure(actual: ReturnType<typeof findMausbotIncidentFailure>, proof: string): boolean {
  if (!actual) return false;
  try {
    const { policy } = JSON.parse(proof);
    return typeof policy === "string" && /^[0-9a-f]{64}$/.test(policy) && stableStringify({ ...actual, policy }) === proof;
  } catch {
    return false;
  }
}

export function canAdmitMausbotResume(
  projection: OrchestrationV2ThreadProjection,
  sourceRunId: RunId,
  incidentFailure?: string,
) {
  const source = findMausbotResumeTarget(projection, sourceRunId);
  if (!source || latestExecutedRun(projection.runs)?.id !== sourceRunId ||
      projection.thread.archivedAt != null || projection.thread.deletedAt != null ||
      projection.runtimeRequests.some(row => row.status === "pending") ||
      projection.runs.some(row => row.id !== sourceRunId && ["preparing", "queued", "starting", "running", "waiting"].includes(row.status)) ||
      (incidentFailure !== undefined
        ? !matchesIncidentFailure(findMausbotIncidentFailure(projection, sourceRunId), incidentFailure)
        : (source.run.status !== "interrupted" && (source.run.status !== "failed" ||
          latestRootProviderFailure(source.run, projection.turnItems)?.class !== "usage_limit"))) ||
      (source.turn.status !== "interrupted" && source.turn.status !== "failed")) return undefined;
  return source;
}

export function matchesMausbotResumeReceipt(
  command: Dispatch,
  target: MausbotResumeTarget,
  stored: ReadonlyArray<OrchestrationV2StoredEvent>,
): boolean {
  return stored.some(({ event }) => {
    if (event.type !== "run.created" || event.payload.threadId !== command.threadId) return false;
    const saved = event.payload.mausbotPromptless;
    return saved !== undefined &&
      saved.sourceRunId === target.sourceRunId && saved.incidentFailure === target.incidentFailure &&
      stableStringify(saved.incidentNote) === stableStringify(target.incidentNote) &&
      command.text === (target.incidentNote?.text ?? "") &&
      saved.providerThreadId === target.providerThreadId &&
      saved.providerSessionId === target.providerSessionId &&
      saved.providerTurnId === target.providerTurnId &&
      saved.nativeThreadId === target.nativeThreadId &&
      saved.nativeTurnId === target.nativeTurnId &&
      event.payload.manualContinuationOfRunId === target.sourceRunId &&
      event.payload.providerThreadId === target.providerThreadId &&
      event.payload.userMessageId === command.messageId;
  });
}
