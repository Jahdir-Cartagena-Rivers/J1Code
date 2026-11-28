// @effect-diagnostics nodeBuiltinImport:off - fingerprint private native history before admission.
import * as NodeCrypto from "node:crypto";
import {
  CommandId, MessageId, type MausbotOriginStart, type OrchestrationV2Command,
  type OrchestrationV2StoredEvent, type OrchestrationV2ThreadProjection, type OrchestrationV2InternalCommand, type ThreadBotIdentity, type ThreadId,
  latestProviderTurnForAttempt, MAUSBOT_CHILD_RESTART_TEXT, mausbotParentResultText,
} from "@j1code/contracts";
import { stableStringify } from "@j1code/shared/relaySigning";
import { modelSelectionsEqual } from "@j1code/shared/model";
import { latestExecutedRun } from "@j1code/shared/orchestrationV2ThreadError";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { parkedSetupStatusText, privateSetupReviewMatches, roomSetupBatchIds, roomSetupBatchMatches, roomSetupBatchText } from "../mausbot/NativeBotEnrollment.ts";
import type { SavedNativeBotEnrollment, SavedNativeRoomMemberEnrollment } from "../mausbot/NativeBotEnrollment.ts";
import { parkedRoomAnswerOperationId, parkedRoomAnswers, parkedRoomAnswerText, parkedRoomCardsMatch, roomHandoffMatches, rootRoomRestartMatches, rootRoomResultWakeMatches, validParentResultWake } from "../mausbot/NativeBotEnrollment.ts";
import { mausbotHistoryMessageId } from "./MausbotHistoryImport.ts";
import type * as Effect from "effect/Effect";
import type { MausbotNativeProofError } from "./MausbotNativeProofError.ts";

type History = NonNullable<SavedNativeBotEnrollment["coldHistory"]>["messages"];

type Dispatch = Extract<OrchestrationV2Command, { type: "message.dispatch" }>;

export const MAUSBOT_ORIGIN_PREFIX = "command:mausbot:assignment:";
export const MAUSBOT_ORIGIN_INPUT_PREFIX = "message:mausbot:assignment:";
type OriginKey = Pick<MausbotOriginStart, "nodeId" | "execution" | "computerSelection" | "room">;

export const MAUSBOT_ROOM_THREAD_PREFIX = "j1-mausbot:room:";
export const mausbotRoomThreadId = (room: Pick<NonNullable<MausbotOriginStart["room"]>, "groupId" | "nativeThreadId" | "memberId">) =>
  MAUSBOT_ROOM_THREAD_PREFIX + room.groupId + ":" + room.nativeThreadId + ":" + room.memberId;

export const MausbotRoomCreation = Context.Reference<{
  command: Extract<OrchestrationV2InternalCommand, { type: "thread.bot.create" }>;
  member?: ThreadBotIdentity;
  current(): boolean;
  refresh: Effect.Effect<boolean, MausbotNativeProofError>;
} | undefined>("@j1code/server/orchestration-v2/MausbotRoomCreation", { defaultValue: () => undefined });

const originKey = (threadId: ThreadId, origin: OriginKey) =>
  threadId + ":" + (origin.room ? "room:" : "") + origin.nodeId + ":" + origin.execution +
  (origin.computerSelection ? ":computer:" + origin.computerSelection.id : "");
export const mausbotOriginCommandId = (threadId: ThreadId, origin: OriginKey) =>
  CommandId.make(MAUSBOT_ORIGIN_PREFIX + originKey(threadId, origin));
export const mausbotOriginInputId = (threadId: ThreadId, origin: OriginKey) =>
  MessageId.make(MAUSBOT_ORIGIN_INPUT_PREFIX + originKey(threadId, origin));

export const MausbotOrigin = Context.Reference<{
  readonly command: Dispatch;
  readonly input: MausbotOriginStart;
  readonly botId: string;
  readonly history: History;
  readonly roomGoalSources?: ReadonlyMap<string, OrchestrationV2ThreadProjection>;
  readonly current: () => boolean;
  readonly refresh: Effect.Effect<boolean, MausbotNativeProofError>;
} | undefined>("@j1code/server/orchestration-v2/MausbotOrigin", { defaultValue: () => undefined });

export function roomMatchesCurrentInput(origin: MausbotOriginStart, history: History): boolean {
  const room = origin.room;
  if (!room) return false;
  const snapshot = JSON.parse(room.snapshot) as Omit<SavedNativeRoomMemberEnrollment, "rows"> & {
    rows: ReadonlyArray<SavedNativeRoomMemberEnrollment["rows"][number] & { stagedAttachments: unknown[] }>;
  };
  const rows = snapshot.rows.filter(row => room.currentRowIds.includes(row.id));
  const next = snapshot.operation.goal?.continuation;
  const parked = snapshot.operation.parked;
  const restart = snapshot.operation.childRestart;
  const resultWake = snapshot.operation.parentResultWake;
  const handoff = snapshot.operation.handoff;
  const setup = snapshot.operation.setup;
  const validInput = setup
    ? Boolean(origin.continuation) && room.currentRowIds.length === 0 && !origin.attachments.length &&
      roomSetupBatchMatches(snapshot) && (!handoff || roomHandoffMatches(snapshot)) && origin.text === roomSetupBatchText(setup)
    : handoff
    ? roomHandoffMatches(snapshot) && origin.attachments.length === 0 &&
      (parked ? Boolean(origin.continuation) && room.currentRowIds.length === 0 &&
        parkedRoomCardsMatch(parked, snapshot.rows) && origin.text === parkedRoomAnswerText(parked)
        : resultWake ? Boolean(origin.continuation) && room.currentRowIds.length === 0 &&
          stableStringify(resultWake) === stableStringify(origin.parentResultWake) && origin.text === mausbotParentResultText(resultWake)
        : restart ? Boolean(origin.continuation) && room.currentRowIds.length === 0 &&
          stableStringify(restart) === stableStringify(origin.childRestart) && origin.text === MAUSBOT_CHILD_RESTART_TEXT
        : !origin.childRestart && room.currentRowIds.length === 1 && room.currentRowIds[0] === handoff.rowId &&
          origin.text === (handoff.consultationText ?? handoff.assignment))
    : resultWake ? rootRoomResultWakeMatches(snapshot) && Boolean(origin.continuation) &&
      stableStringify(resultWake) === stableStringify(origin.parentResultWake) && origin.text === mausbotParentResultText(resultWake) &&
      room.currentRowIds.length === 0 && !origin.attachments.length
    : restart ? rootRoomRestartMatches(snapshot) && Boolean(origin.continuation) &&
      stableStringify(restart) === stableStringify(origin.childRestart) && origin.text === MAUSBOT_CHILD_RESTART_TEXT &&
      room.currentRowIds.length === 0 && !origin.attachments.length
    : parked
    ? snapshot.operation.kind === (parked.goal ? "goal" : "card") && Boolean(origin.continuation) && room.currentRowIds.length === 0 &&
      origin.attachments.length === 0 && origin.text === parkedRoomAnswerText(parked) &&
      snapshot.operation.requestId === parked.sourceMessageId &&
      parkedRoomCardsMatch(parked, snapshot.rows) &&
      snapshot.rows.some(row => row.id === parked.sourceMessageId && row.role === "user" && row.provenance.authority === "own")
    : next
    ? snapshot.operation.kind === "goal" && (snapshot.operation.goal?.turnCount ?? 0) > 1 &&
      room.currentRowIds.length === 0 && (Boolean(origin.continuation) ||
        (next.coordinator && next.targetMemberId === room.memberId &&
          next.fromMemberId !== undefined && next.fromMemberId !== room.memberId)) &&
      origin.attachments.length === 0 &&
      origin.text === next.assignment && snapshot.rows.some(row => row.id === snapshot.operation.requestId &&
        row.role === "user" && row.provenance.authority === "own" && row.text === snapshot.operation.goal?.goal)
    : room.currentRowIds.length > 0 && snapshot.operation.requestId !== undefined &&
      room.currentRowIds.includes(snapshot.operation.requestId) &&
      rows.length === room.currentRowIds.length &&
      rows.every((row, index) => row.id === room.currentRowIds[index] && row.role === "user" && row.provenance.authority === "own") &&
      rows.map(row => row.text ?? "").join("\n\n") === origin.text &&
      stableStringify(rows.flatMap(row => row.stagedAttachments)) === stableStringify(origin.attachments);
  return snapshot.botId === room.memberId && snapshot.groupId === room.groupId &&
    snapshot.threadId === room.nativeThreadId && snapshot.operation.generation === room.generation &&
    snapshot.operation.id === room.operationId && snapshot.operation.requestId !== undefined &&
    Boolean(restart) === Boolean(origin.childRestart) && Boolean(resultWake) === Boolean(origin.parentResultWake) && validInput &&
    (handoff?.mode === "consult" ? origin.consultation?.reply === handoff.reply &&
      origin.consultation?.brief === handoff.assignment &&
      origin.consultation.envelopeHash === NodeCrypto.createHash("sha256").update(origin.text).digest("hex")
      : !origin.consultation) &&
    origin.sourceMessageId === mausbotHistoryMessageId(mausbotRoomThreadId(room) as ThreadId, snapshot.operation.requestId) &&
    stableStringify(snapshot.operation.sourceRowIds) === stableStringify(room.currentRowIds) &&
    snapshot.rows.length === history.length && snapshot.rows.every((row, index) => {
      const saved = history[index];
      return saved?.nativeMessageId === row.id && saved.text === (row.text ?? "") &&
        saved.role === (row.role === "user" ? "user" : "assistant") &&
        saved.mirrorMessageId === ((row.provenance.from as { botId?: string } | undefined)?.botId === room.memberId ? row.j1ProviderMessageId : undefined) &&
        Date.parse(saved.createdAt) === row.at &&
        (saved.completedAt === null ? undefined : Date.parse(saved.completedAt)) === row.turnCompletedAt &&
        stableStringify(saved.attachments) === stableStringify(row.stagedAttachments);
    });
}

export function roomProviderHistory(room: NonNullable<MausbotOriginStart["room"]>, history: History, continuing = false) {
  const { rows, goalHistory, operation } = JSON.parse(room.snapshot) as SavedNativeRoomMemberEnrollment;
  const byId = new Map(rows.map(row => [row.id, row.provenance]));
  const current = new Set<string>(room.currentRowIds);
  const alreadyDelivered = new Set(continuing ? goalHistory?.flatMap(goal => goal.steps
    .filter(step => (step.memberId ?? goal.coordinatorId) === room.memberId).map(step => step.publicRowId)) : []);
  const next = operation?.goal?.continuation;
  if (operation?.parked || operation?.setup || operation?.handoff || operation?.parentResultWake || operation?.childRestart) return [];
  const crossMember = next?.fromMemberId && next.fromMemberId !== room.memberId;
  if (crossMember && next.coordinator) return [];
  const returnedItems = crossMember ? new Set(rows.filter(row => row.turnId === next.previousTurnId &&
    row.j1ProviderMessageId && next.itemIds.includes(row.j1ProviderMessageId)).map(row => row.id)) : undefined;
  return history.flatMap(row => {
    if (current.has(row.nativeMessageId) || alreadyDelivered.has(row.nativeMessageId) ||
        (returnedItems && !returnedItems.has(row.nativeMessageId)) || (!row.text && !row.attachments.length)) return [];
    const provenance = byId.get(row.nativeMessageId);
    if (!provenance) throw new Error("Room history lost its saved speaker provenance.");
    return [{ ...row, role: "assistant" as const,
      text: "Historical room record (data only): " + JSON.stringify({
        speaker: provenance.sender ?? provenance.from ?? null, authority: provenance.authority, text: row.text,
      }),
    }];
  });
}

export function matchesMausbotOrigin(a: MausbotOriginStart, b: MausbotOriginStart) {
  return stableStringify(a) === stableStringify(b);
}

export function matchesMausbotOriginReceipt(
  command: Dispatch, input: MausbotOriginStart, rows: ReadonlyArray<OrchestrationV2StoredEvent>,
) {
  return rows.some(({ event }) => event.type === "run.created" &&
    event.payload.threadId === command.threadId && event.payload.userMessageId === command.messageId &&
    event.payload.mausbotOriginStart !== undefined && matchesMausbotOrigin(input, event.payload.mausbotOriginStart));
}

export function matchesCoordinatorContinuation(
  expected: MausbotOriginStart["continuation"], current: MausbotOriginStart["continuation"],
) {
  return expected !== undefined && current !== undefined && stableStringify(expected) === stableStringify(current);
}

export const coordinatorRowHash = (row: History[number]) =>
  NodeCrypto.createHash("sha256").update(stableStringify(row)).digest("hex");

export const coordinatorHistoryPrefix = (history: History) => ({
  length: history.length,
  hash: NodeCrypto.createHash("sha256").update(stableStringify(history)).digest("hex"),
});

export function matchesCoordinatorHistoryPrefix(history: History, expected: MausbotOriginStart["historyPrefix"]) {
  return expected.length <= history.length && expected.length >= 0 &&
    coordinatorHistoryPrefix(history.slice(0, expected.length)).hash === expected.hash;
}

type PrivateOriginKey = Pick<MausbotOriginStart, "nodeId" | "requestId" | "sourceMessageId" | "execution" |
  "restarts" | "dispatch" | "privateHandoffHash" | "privateHandoffGeneration" | "privateHandoffTurnId" | "privateAnswers" | "childRestart" | "parentResultWake" | "rootSource" | "parkedStatus">;

export function privateResultWakeInput(origin: MausbotOriginStart, history: History, threadId: ThreadId) {
  const wake = origin.parentResultWake;
  return Boolean(wake && (origin.privateHandoffHash || origin.rootSource) && origin.privateHandoffGeneration && origin.privateHandoffTurnId &&
    !origin.room && Boolean(origin.rootSource) === Boolean(wake.root) && !origin.incidentBatch && !origin.computerSelection && !origin.privateAnswers &&
    !origin.childRestart && origin.dispatch === "resume" && origin.execution === wake.execution && origin.restarts === (wake.restarts ?? 0) &&
    !origin.attachments.length &&
    wake.priorTurnId !== origin.privateHandoffTurnId && wake.priorGeneration !== origin.privateHandoffGeneration &&
    validParentResultWake(wake, origin.nodeId) && origin.text === mausbotParentResultText(wake) &&
    (wake.root && origin.rootSource ? wake.root.sourceMessageId === origin.rootSource.nativeMessageId &&
      history.filter(row => row.nativeMessageId === wake.root?.sourceMessageId && row.role === "user" && !row.mirrorMessageId &&
        coordinatorRowHash(row) === origin.rootSource?.hash).length === 1
      : history.filter(row => mausbotHistoryMessageId(threadId, row.nativeMessageId) === origin.sourceMessageId &&
        row.role === "assistant" && !row.mirrorMessageId && !row.attachments.length).length === 1));
}

function reusedParentResultWake(earlier: MausbotOriginStart | undefined, wake: NonNullable<MausbotOriginStart["parentResultWake"]>) {
  return Boolean(earlier?.parentResultWake && (earlier.parentResultWake.priorGeneration === wake.priorGeneration ||
    earlier.parentResultWake.priorTurnId === wake.priorTurnId || earlier.parentResultWake.reports.some(report =>
      wake.reports.some(next => report.inboxId === next.inboxId || report.childId === next.childId))));
}

function privateResultWakePredecessor(
  projection: OrchestrationV2ThreadProjection,
  origin: PrivateOriginKey,
  modelSelection: OrchestrationV2ThreadProjection["thread"]["modelSelection"],
  dispatched?: MausbotOriginStart,
): MausbotOriginStart["continuation"] {
  const wake = origin.parentResultWake;
  if (!wake || (!origin.privateHandoffHash && !origin.rootSource) || origin.execution !== wake.execution || origin.dispatch !== "resume")
    return undefined;
  const held = dispatched ? projection.runs.filter(row =>
    row.mausbotOriginStart && matchesMausbotOrigin(row.mausbotOriginStart, dispatched)) : [];
  if (held.length > 1) return undefined;
  const runs = projection.runs.filter(row => row.id !== held[0]?.id);
  const prior = latestExecutedRun(runs);
  const saved = prior?.mausbotOriginStart;
  if (!prior || !saved || prior.status !== "completed" || saved.room ||
      stableStringify(saved.rootSource) !== stableStringify(origin.rootSource) ||
      !latestProviderTurnForAttempt(projection.providerTurns, prior.activeAttemptId)?.completedAt ||
      saved.nodeId !== origin.nodeId || saved.requestId !== origin.requestId || saved.sourceMessageId !== origin.sourceMessageId ||
      saved.privateHandoffHash !== origin.privateHandoffHash || saved.execution + 1 !== wake.execution ||
      (saved.parentResultWake && saved.parentResultWake.startedAt !== wake.priorStartedAt) ||
      (saved.childRestart && saved.childRestart.startedAt !== wake.priorStartedAt) ||
      saved.restarts !== origin.restarts || saved.privateHandoffGeneration !== wake.priorGeneration ||
      saved.privateHandoffTurnId !== wake.priorTurnId || prior.providerThreadId !== projection.thread.activeProviderThreadId ||
      (held[0] && held[0].ordinal <= prior.ordinal) || runs.some(row => row.ordinal > prior.ordinal ||
        ["queued", "preparing", "starting", "running", "waiting"].includes(row.status) ||
        row.mausbotOriginStart?.privateHandoffGeneration === origin.privateHandoffGeneration ||
        row.mausbotOriginStart?.privateHandoffTurnId === origin.privateHandoffTurnId ||
        reusedParentResultWake(row.mausbotOriginStart, wake))) return undefined;
  const target = ownedMausbotPredecessor(projection, prior, modelSelection);
  const session = projection.providerSessions.find(row => row.id === target?.providerSessionId);
  return session && session.status !== "stopped" && session.status !== "error" ? target : undefined;
}

function privateRootHistory(origin: MausbotOriginStart, history: History) {
  const root = origin.rootSource;
  return !!root && history.filter(row => row.nativeMessageId === root.nativeMessageId && row.role === "user" &&
    !row.mirrorMessageId && coordinatorRowHash(row) === root.hash).length === 1;
}

function parentResultWakeHash(wake: NonNullable<MausbotOriginStart["parentResultWake"]>) {
  return NodeCrypto.createHash("sha256").update(JSON.stringify([wake.execution, wake.priorGeneration, wake.priorTurnId,
    wake.priorStartedAt, wake.cutAt, wake.startedAt, wake.restarts ?? 0, wake.root?.sourceMessageId, wake.root?.sourceHash, wake.root?.person,
    wake.reports.map(report => [report.inboxId, report.childId, report.childBotId, report.childThreadId,
      report.execution, report.finishedAt, report.reportedAt, report.resultHash])])).digest("hex");
}

export function privateRestartInput(origin: MausbotOriginStart, history: History, threadId: ThreadId) {
  const restart = origin.childRestart;
  if (!restart || Boolean(origin.privateHandoffHash) === Boolean(origin.rootSource) ||
      Boolean(origin.rootSource) !== Boolean(restart.rootResultHash) ||
      !origin.privateHandoffGeneration || !origin.privateHandoffTurnId ||
      origin.room || origin.incidentBatch || origin.computerSelection || origin.privateAnswers ||
      origin.dispatch !== "rerun" || origin.execution !== restart.execution || origin.restarts !== restart.restarts ||
      restart.restarts < 1 || restart.execution <= restart.restarts ||
      origin.text !== MAUSBOT_CHILD_RESTART_TEXT || origin.attachments.length ||
      restart.priorTurnId === origin.privateHandoffTurnId || restart.priorGeneration === origin.privateHandoffGeneration ||
      restart.priorStartedAt > restart.reconciledAt || restart.reconciledAt > restart.startedAt) return false;
  if (origin.rootSource) return privateRootHistory(origin, history);
  const rows = history.filter(row => mausbotHistoryMessageId(threadId, row.nativeMessageId) === origin.sourceMessageId);
  return rows.length === 1 && rows[0]?.role === "assistant" && !rows[0].mirrorMessageId && !rows[0].attachments.length;
}

function privateRestartPredecessor(
  projection: OrchestrationV2ThreadProjection,
  origin: PrivateOriginKey,
  modelSelection: OrchestrationV2ThreadProjection["thread"]["modelSelection"],
  dispatched?: MausbotOriginStart,
): MausbotOriginStart["continuation"] {
  const restart = origin.childRestart;
  if (!restart || Boolean(origin.privateHandoffHash) === Boolean(origin.rootSource) ||
      Boolean(origin.rootSource) !== Boolean(restart.rootResultHash) || origin.execution !== restart.execution ||
      origin.restarts !== restart.restarts || origin.dispatch !== "rerun") return undefined;
  const held = dispatched ? projection.runs.filter(row =>
    row.mausbotOriginStart && matchesMausbotOrigin(row.mausbotOriginStart, dispatched)) : [];
  if (held.length > 1) return undefined;
  const runs = projection.runs.filter(row => row.id !== held[0]?.id);
  const prior = latestExecutedRun(runs);
  const saved = prior?.mausbotOriginStart;
  if (!prior || !saved || prior.status !== "completed" || saved.room ||
      stableStringify(saved.rootSource) !== stableStringify(origin.rootSource) ||
      (origin.rootSource && (!saved.parentResultWake?.root ||
        restart.rootResultHash !== parentResultWakeHash(saved.parentResultWake))) ||
      !latestProviderTurnForAttempt(projection.providerTurns, prior.activeAttemptId)?.completedAt ||
      saved.nodeId !== origin.nodeId || saved.requestId !== origin.requestId ||
      saved.sourceMessageId !== origin.sourceMessageId || saved.privateHandoffHash !== origin.privateHandoffHash ||
      saved.execution !== origin.execution - 1 || saved.restarts + 1 !== restart.restarts ||
      (saved.childRestart && (saved.childRestart.execution !== saved.execution ||
        saved.childRestart.restarts !== saved.restarts || saved.childRestart.startedAt !== restart.priorStartedAt)) ||
      (saved.parentResultWake && (saved.parentResultWake.execution !== saved.execution ||
        saved.parentResultWake.startedAt !== restart.priorStartedAt)) ||
      (saved.restarts > 0 && (!saved.continuation ||
        saved.continuation.providerThreadId !== prior.providerThreadId ||
        saved.continuation.providerSessionId !== prior.mausbotOriginProviderSessionId)) ||
      saved.privateHandoffGeneration !== restart.priorGeneration || saved.privateHandoffTurnId !== restart.priorTurnId ||
      prior.providerThreadId !== projection.thread.activeProviderThreadId ||
      (held[0] && held[0].ordinal <= prior.ordinal) ||
      runs.some(row => row.ordinal > prior.ordinal || ["queued", "preparing", "starting", "running", "waiting"].includes(row.status) ||
        (row.mausbotOriginStart?.nodeId === origin.nodeId && row.mausbotOriginStart.execution >= origin.execution) ||
        row.mausbotOriginStart?.privateHandoffGeneration === origin.privateHandoffGeneration ||
        row.mausbotOriginStart?.privateHandoffTurnId === origin.privateHandoffTurnId ||
        row.mausbotOriginStart?.childRestart?.priorGeneration === restart.priorGeneration ||
        row.mausbotOriginStart?.childRestart?.priorTurnId === restart.priorTurnId)) return undefined;
  const target = ownedMausbotPredecessor(projection, prior, modelSelection);
  const session = projection.providerSessions.find(row => row.id === target?.providerSessionId);
  return session && session.status !== "stopped" && session.status !== "error" ? target : undefined;
}

function privateAnswerPredecessor(
  projection: OrchestrationV2ThreadProjection,
  origin: PrivateOriginKey,
  modelSelection: OrchestrationV2ThreadProjection["thread"]["modelSelection"],
  dispatched?: MausbotOriginStart,
): MausbotOriginStart["continuation"] {
  const batch = origin.privateAnswers;
  if (!batch || Boolean(origin.privateHandoffHash) === Boolean(origin.rootSource) ||
      !origin.privateHandoffGeneration || !origin.privateHandoffTurnId ||
      origin.dispatch !== "resume" || origin.execution < 2 || origin.restarts >= origin.execution ||
      batch.priorTurnId === origin.privateHandoffTurnId || batch.priorGeneration === origin.privateHandoffGeneration) return undefined;
  const held = dispatched ? projection.runs.filter(row =>
    row.mausbotOriginStart && matchesMausbotOrigin(row.mausbotOriginStart, dispatched)) : [];
  if (held.length > 1) return undefined;
  const runs = projection.runs.filter(row => row.id !== held[0]?.id);
  const prior = latestExecutedRun(runs);
  const saved = prior?.mausbotOriginStart;
  const cardIds = new Set(batch.answers.map(answer => answer.cardId));
  const requestIds = new Set(batch.answers.map(answer => answer.requestId));
  if (!prior || !saved || prior.status !== "completed" || saved.room ||
      stableStringify(saved.rootSource) !== stableStringify(origin.rootSource) ||
      (saved.parentResultWake?.root && saved.parentResultWake.root.person !== batch.answers[0]?.person) ||
      saved.nodeId !== origin.nodeId || saved.requestId !== origin.requestId ||
      saved.sourceMessageId !== origin.sourceMessageId || saved.privateHandoffHash !== origin.privateHandoffHash ||
      saved.execution !== origin.execution - 1 || (saved.execution === 1
        ? saved.dispatch !== "first" || saved.privateAnswers !== undefined
        : saved.childRestart ? saved.dispatch !== "rerun" || saved.childRestart.execution !== saved.execution
          : saved.dispatch !== "resume" || (!saved.privateAnswers && !saved.parkedStatus && saved.parentResultWake?.execution !== saved.execution)) ||
      saved.restarts !== origin.restarts || saved.privateHandoffGeneration !== batch.priorGeneration || saved.privateHandoffTurnId !== batch.priorTurnId ||
      prior.providerThreadId !== projection.thread.activeProviderThreadId ||
      (held[0] && held[0].ordinal <= prior.ordinal) || !batch.answers.length ||
      cardIds.size !== batch.answers.length || requestIds.size !== batch.answers.length ||
      runs.some(row => row.ordinal > prior.ordinal || ["queued", "preparing", "starting", "running", "waiting"].includes(row.status) ||
        row.mausbotOriginStart?.privateHandoffGeneration === origin.privateHandoffGeneration ||
        row.mausbotOriginStart?.privateHandoffTurnId === origin.privateHandoffTurnId ||
        (row.mausbotOriginStart?.privateAnswers?.answers ?? row.mausbotOriginStart?.parkedStatus?.mixed?.questions)?.some(answer =>
          cardIds.has(answer.cardId) || requestIds.has(answer.requestId)))) return undefined;

  const target = ownedMausbotPredecessor(projection, prior, modelSelection);
  const session = projection.providerSessions.find(row => row.id === target?.providerSessionId);
  return target && session && session.status !== "stopped" && session.status !== "error" &&
    parkedQuestionRequestsMatch(projection, prior, batch.answers) ? target : undefined;
}

function parkedQuestionRequestsMatch(
  projection: OrchestrationV2ThreadProjection,
  prior: OrchestrationV2ThreadProjection["runs"][number],
  answers: readonly { requestId: string }[],
) {
  const turn = latestProviderTurnForAttempt(projection.providerTurns, prior.activeAttemptId);
  if (!turn) return false;
  const requestIds = new Set(answers.map(answer => answer.requestId));
  const pending = projection.runtimeRequests.filter(request => request.kind === "user_input" &&
    request.providerTurnId === turn.id && (request.status === "expired" || request.status === "cancelled") &&
    !request.decision && !request.answers);
  const ordered = projection.turnItems.filter(item => item.type === "user_input_request" &&
    item.runId === prior.id && item.providerTurnId === turn.id && requestIds.has(item.requestId))
    .sort((a, b) => a.ordinal - b.ordinal);
  return pending.length === answers.length && ordered.length === answers.length &&
      ordered.every((item, index) => item.type === "user_input_request" && item.requestId === answers[index]?.requestId &&
        (index === 0 || ordered[index - 1]!.ordinal < item.ordinal) &&
        pending.some(request => request.id === item.requestId && request.nodeId === item.nodeId) &&
        projection.nodes.some(node => node.id === item.nodeId && node.kind === "user_input_request" &&
          node.threadId === projection.thread.id && node.runId === prior.id && node.rootNodeId === prior.rootNodeId &&
          node.providerTurnId === turn.id && node.runtimeRequestId === item.requestId));
}

export function privateAnswerHistory(origin: MausbotOriginStart, history: History, delta?: History) {
  const batch = origin.privateAnswers;
  if (!batch || Boolean(origin.privateHandoffHash) === Boolean(origin.rootSource) ||
      !origin.privateHandoffGeneration || !origin.privateHandoffTurnId ||
      origin.dispatch !== "resume" || origin.execution < 2 || origin.restarts >= origin.execution || origin.attachments.length ||
      origin.room || origin.incidentBatch || origin.computerSelection ||
      (origin.rootSource && !privateRootHistory(origin, history)) ||
      !batch.answers.length || !batch.answers.every(answer =>
        answer.person === batch.answers[0]?.person && answer.answer.trim())) return false;
  const ids = batch.answers.map(answer => answer.cardId);
  const requestIds = new Set(batch.answers.map(answer => answer.requestId));
  const cards = new Set(ids);
  if (cards.size !== ids.length || requestIds.size !== ids.length) return false;
  const order = (rows: History) => rows.filter(row => cards.has(row.nativeMessageId)).map(row => row.nativeMessageId);
  if (stableStringify(order(history)) !== stableStringify(ids) ||
      history.some(row => cards.has(row.nativeMessageId) &&
        (row.role !== "assistant" || row.mirrorMessageId || row.attachments.length))) return false;
  if (delta && (stableStringify(order(delta)) !== stableStringify(ids) ||
      delta.some(row => !cards.has(row.nativeMessageId) &&
        (row.role !== "assistant" || row.text || row.mirrorMessageId || row.attachments.length)))) return false;
  const expectedText = batch.answers.length === 1 ? batch.answers[0]!.answer
    : "Here are the answers to your parked questions in their original order.\n" +
      JSON.stringify(batch.answers.map(({ requestId, answer }) => ({ requestId, answer })));
  return origin.text === expectedText;
}

export function privateStatusHistory(origin: MausbotOriginStart, history: History, delta?: History) {
  const status = origin.parkedStatus;
  if (!status || !privateSetupReviewMatches(status, origin.nodeId, origin.rootSource?.nativeMessageId, origin.privateHandoffHash) ||
      Boolean(origin.rootSource) === Boolean(origin.privateHandoffHash) ||
      !origin.privateHandoffGeneration || !origin.privateHandoffTurnId || origin.dispatch !== "resume" ||
      origin.room || origin.incidentBatch || origin.privateAnswers || origin.childRestart || origin.parentResultWake ||
      origin.consultation || origin.computerSelection || origin.attachments.length ||
      (origin.rootSource && !privateRootHistory(origin, history)) ||
      status.priorGeneration === origin.privateHandoffGeneration || status.priorTurnId === origin.privateHandoffTurnId ||
      origin.execution < 2 || origin.restarts >= origin.execution) return false;
  if (status.privateReview && history.filter(row =>
    row.nativeMessageId === status.privateReview?.sourceId && row.role === (origin.rootSource ? "user" : "assistant")).length !== 1)
    return false;
  const answers = status.mixed?.questions ?? [];
  if (status.mixed && (!answers.length || answers.some(answer =>
    !answer.answer.trim() || answer.person !== answers[0]?.person))) return false;
  const decisions = [...status.decisions, ...answers];
  const ids = status.mixed?.cardOrder ?? status.decisions.map(decision => decision.cardId);
  const selected = new Set(ids);
  if (!ids.length || ids.length > 32 || selected.size !== ids.length || decisions.length !== ids.length ||
      !status.decisions.length || !decisions.every(decision => selected.has(decision.cardId)) ||
      new Set(decisions.map(decision => decision.cardId)).size !== ids.length ||
      new Set(decisions.map(decision => decision.requestId)).size !== ids.length ||
      stableStringify(ids.filter(id => answers.some(answer => answer.cardId === id))) !==
        stableStringify(answers.map(answer => answer.cardId)) ||
      stableStringify(ids.filter(id => status.decisions.some(decision => decision.cardId === id))) !==
        stableStringify(status.decisions.map(decision => decision.cardId))) return false;
  const matches = (rows: History) => {
    const cards = rows.filter(row => selected.has(row.nativeMessageId));
    return stableStringify(cards.map(row => row.nativeMessageId)) === stableStringify(ids) &&
      cards.every(row => row.role === "assistant" && !row.attachments.length && !row.mirrorMessageId);
  };
  return origin.text === parkedSetupStatusText(status) && matches(history) && (!delta || (matches(delta) &&
    delta.every(row => row.role === "assistant" && !row.attachments.length && !row.mirrorMessageId)));
}

function privateStatusPredecessor(
  projection: OrchestrationV2ThreadProjection,
  origin: PrivateOriginKey,
  modelSelection: OrchestrationV2ThreadProjection["thread"]["modelSelection"],
  dispatched?: MausbotOriginStart,
): MausbotOriginStart["continuation"] {
  const status = origin.parkedStatus;
  if (!status || !privateSetupReviewMatches(status, origin.nodeId, origin.rootSource?.nativeMessageId, origin.privateHandoffHash) ||
      Boolean(origin.rootSource) === Boolean(origin.privateHandoffHash) ||
      origin.dispatch !== "resume" || !origin.privateHandoffGeneration) return undefined;
  const held = dispatched ? projection.runs.filter(row =>
    row.mausbotOriginStart && matchesMausbotOrigin(row.mausbotOriginStart, dispatched)) : [];
  if (held.length > 1) return undefined;
  const runs = projection.runs.filter(row => row.id !== held[0]?.id);
  const prior = latestExecutedRun(runs);
  const saved = prior?.mausbotOriginStart;
  if (!prior || !saved || prior.status !== "completed" || saved.room || saved.consultation ||
      !latestProviderTurnForAttempt(projection.providerTurns, prior.activeAttemptId)?.completedAt ||
      saved.nodeId !== origin.nodeId || saved.requestId !== origin.requestId || saved.sourceMessageId !== origin.sourceMessageId ||
      saved.privateHandoffHash !== origin.privateHandoffHash || stableStringify(saved.rootSource) !== stableStringify(origin.rootSource) ||
      saved.execution + 1 !== origin.execution || saved.restarts !== origin.restarts ||
      saved.privateHandoffGeneration !== status.priorGeneration || saved.privateHandoffTurnId !== status.priorTurnId ||
      prior.providerThreadId !== projection.thread.activeProviderThreadId || (held[0] && held[0].ordinal <= prior.ordinal) ||
      runs.some(row => row.ordinal > prior.ordinal || ["queued", "preparing", "starting", "running", "waiting"].includes(row.status) ||
        row.mausbotOriginStart?.privateHandoffGeneration === origin.privateHandoffGeneration ||
        row.mausbotOriginStart?.privateHandoffTurnId === origin.privateHandoffTurnId ||
        [...(row.mausbotOriginStart?.parkedStatus?.decisions ?? []),
          ...(row.mausbotOriginStart?.parkedStatus?.mixed?.questions ?? []),
          ...(row.mausbotOriginStart?.privateAnswers?.answers ?? [])].some(old =>
          [...status.decisions, ...(status.mixed?.questions ?? [])].some(decision =>
            old.cardId === decision.cardId || old.requestId === decision.requestId ||
            ("flowId" in old && "flowId" in decision && old.flowId !== undefined && old.flowId === decision.flowId))))) return undefined;
  const questions = status.mixed?.questions ?? [];
  const knownReviewer = saved.parentResultWake?.root?.person ?? saved.parkedStatus?.privateReview?.person;
  if (status.privateReview && !origin.rootSource &&
      mausbotHistoryMessageId(projection.thread.id, status.privateReview.sourceId) !== origin.sourceMessageId) return undefined;
  const providerTurn = latestProviderTurnForAttempt(projection.providerTurns, prior.activeAttemptId);
  if ((knownReviewer && (questions.some(question => question.person !== knownReviewer) ||
        (status.privateReview && status.privateReview.person !== knownReviewer))) ||
      (status.privateReview && projection.runtimeRequests.some(request =>
        request.providerTurnId === providerTurn?.id && request.status === "pending")) ||
      !parkedQuestionRequestsMatch(projection, prior, questions)) return undefined;
  const target = ownedMausbotPredecessor(projection, prior, modelSelection);
  const session = projection.providerSessions.find(row => row.id === target?.providerSessionId);
  return session && session.status !== "stopped" && session.status !== "error" ? target : undefined;
}

export function privateHandoffPredecessor(
  projection: OrchestrationV2ThreadProjection,
  origin: PrivateOriginKey,
  modelSelection: OrchestrationV2ThreadProjection["thread"]["modelSelection"],
  dispatched?: MausbotOriginStart,
): MausbotOriginStart["continuation"] {
  if (origin.parentResultWake) return privateResultWakePredecessor(projection, origin, modelSelection, dispatched);
  if (origin.childRestart) return privateRestartPredecessor(projection, origin, modelSelection, dispatched);
  if (origin.parkedStatus) return privateStatusPredecessor(projection, origin, modelSelection, dispatched);
  if (origin.privateAnswers) return privateAnswerPredecessor(projection, origin, modelSelection, dispatched);
  const current = dispatched && projection.runs.filter(run =>
    run.mausbotOriginStart && matchesMausbotOrigin(run.mausbotOriginStart, dispatched));
  if (current && current.length > 1) return undefined;
  const predecessors = projection.runs.filter(run => run.id !== current?.[0]?.id);
  if (!origin.privateHandoffHash || predecessors.some(run => {
    const saved = run.mausbotOriginStart;
    return saved && (saved.nodeId === origin.nodeId || saved.requestId === origin.requestId ||
      saved.sourceMessageId === origin.sourceMessageId || saved.privateHandoffHash === origin.privateHandoffHash);
  })) return undefined;

  const run = latestExecutedRun(predecessors);
  if (!run?.mausbotOriginStart || run.mausbotOriginStart.room || run.status !== "completed" ||
      (current?.[0] && current[0].ordinal <= run.ordinal) ||
      predecessors.some(row => row.ordinal > run.ordinal ||
        ["queued", "preparing", "starting", "running", "waiting"].includes(row.status)) ||
      run.providerThreadId !== projection.thread.activeProviderThreadId) return undefined;
  const target = ownedMausbotPredecessor(projection, run, modelSelection);
  const session = projection.providerSessions.find(row => row.id === target?.providerSessionId);
  return session && session.status !== "stopped" && session.status !== "error" ? target : undefined;
}

export function privateHandoffInput(
  origin: MausbotOriginStart,
  rows: History,
  threadId: OrchestrationV2ThreadProjection["thread"]["id"],
) {
  if (!origin.privateHandoffHash || origin.room || origin.rootSource || origin.incidentBatch ||
      origin.computerSelection || origin.execution !== 1 || origin.dispatch !== "first" ||
      origin.restarts !== 0 || origin.attachments.length || !origin.text.trim()) return false;

  const content = rows.filter(row => row.role !== "assistant" || row.text || row.attachments.length ||
    row.mirrorMessageId);
  const assignment = content.length === 1 ? content[0] : undefined;
  const consultation = origin.consultation;
  if (consultation && (!consultation.brief.trim() ||
      NodeCrypto.createHash("sha256").update(origin.text).digest("hex") !== consultation.envelopeHash)) return false;
  return Boolean(assignment && assignment.role === "assistant" && !assignment.mirrorMessageId &&
    !assignment.attachments.length && assignment.text.endsWith(" " + (consultation?.brief ?? origin.text)) &&
    mausbotHistoryMessageId(threadId, assignment.nativeMessageId) === origin.sourceMessageId);
}

export function coordinatorPredecessor(
  projection: OrchestrationV2ThreadProjection,
  origin: Pick<MausbotOriginStart, "nodeId" | "requestId" | "sourceMessageId" | "execution" | "restarts" | "rootSource" | "computerSelection">,
  modelSelection: OrchestrationV2ThreadProjection["thread"]["modelSelection"],
): MausbotOriginStart["continuation"] {
  const choice = origin.computerSelection;
  const predecessors = projection.runs.filter(row => {
    const previous = row.mausbotOriginStart;
    if (!previous || previous.nodeId !== origin.nodeId || previous.execution !== origin.execution - 1) return false;
    if (!choice) return previous.dispatch !== "computer";
    if (choice.previousChoiceId === undefined)
      return previous.dispatch === "first" && choice.sourceGeneration === origin.nodeId;
    return previous.dispatch === "computer" &&
      previous.computerSelection?.id === choice.previousChoiceId &&
      previous.computerSelection.dispatchGeneration === choice.sourceGeneration &&
      previous.computerSelection.selected === choice.sourceSurface;
  });
  const run = predecessors.length === 1 ? predecessors[0] : undefined;
  const previous = run?.mausbotOriginStart;
  if (!run || !previous || previous.privateHandoffHash || previous.parentResultWake || previous.requestId !== origin.requestId ||
      stableStringify(previous.rootSource ?? null) !== stableStringify(origin.rootSource ?? null) ||
      previous.sourceMessageId !== origin.sourceMessageId || previous.restarts > origin.restarts ||
      run.threadId !== projection.thread.id || run.activeAttemptId === null || run.rootNodeId === null ||
      !modelSelectionsEqual(run.modelSelection, modelSelection) ||
      (choice && (!previous.rootSource || run.status !== "completed")) ||
      (run.status !== "completed" && !(run.status === "interrupted" && origin.restarts > previous.restarts))) return undefined;
  return ownedMausbotPredecessor(projection, run, modelSelection);
}

export function roomPredecessor(
  projection: OrchestrationV2ThreadProjection,
  room: Omit<NonNullable<MausbotOriginStart["room"]>, "snapshot">,
  modelSelection: OrchestrationV2ThreadProjection["thread"]["modelSelection"],
): MausbotOriginStart["continuation"] {
  const current = projection.runs.find(run => {
    const saved = run.mausbotOriginStart?.room;
    return saved?.operationId === room.operationId && saved.generation === room.generation &&
      mausbotRoomThreadId(saved) === mausbotRoomThreadId(room);
  });
  const candidates = projection.runs.filter(run => run.id !== current?.id);
  const run = latestExecutedRun(candidates);
  const previous = run?.mausbotOriginStart?.room;
  if (!run || !previous || run.status !== "completed" || previous.generation === room.generation ||
      mausbotRoomThreadId(previous) !== mausbotRoomThreadId(room) ||
      (current && current.ordinal <= run.ordinal) || candidates.some(row => row.ordinal > run.ordinal ||
        row.mausbotOriginStart?.room?.currentRowIds.some(id => room.currentRowIds.includes(id)))) return undefined;
  const target = ownedMausbotPredecessor(projection, run, modelSelection);
  const session = projection.providerSessions.find(row => row.id === target?.providerSessionId);
  return session && session.status !== "stopped" && session.status !== "error" ? target : undefined;
}

export function roomHandoffPredecessorMatches(
  projection: OrchestrationV2ThreadProjection, origin: MausbotOriginStart,
) {
  const room = origin.room;
  if (!room) return true;
  const live = JSON.parse(room.snapshot) as SavedNativeRoomMemberEnrollment;
  const handoff = live.operation?.handoff;
  if ((!handoff && !live.operation?.parentResultWake && !live.operation?.childRestart) || live.operation?.parked || live.operation?.setup) return true;
  const previous = projection.runs.find(run => run.id === origin.continuation?.predecessorRunId)?.mausbotOriginStart?.room;
  if (!previous || mausbotRoomThreadId(previous) !== mausbotRoomThreadId(room)) return false;
  const prior = JSON.parse(previous.snapshot) as SavedNativeRoomMemberEnrollment;
  const binding = live.memberBindings?.find(member => member.memberId === room.memberId);
  const priorBinding = prior.memberBindings?.find(member => member.memberId === room.memberId);
  const restart = live.operation.childRestart;
  const wake = live.operation.parentResultWake;
  if (wake) {
    const root = wake.root;
    const previousRun = projection.runs.find(run => run.id === origin.continuation?.predecessorRunId);
    const priorExecution = prior.operation.childRestart?.execution ?? prior.operation.parentResultWake?.execution ??
      (prior.operation.parked ? (prior.operation.parked.priorExecution ?? 1) + 1 : 1);
    return Boolean(binding && stableStringify(binding) === stableStringify(priorBinding) &&
      previousRun?.status === "completed" && latestProviderTurnForAttempt(projection.providerTurns, previousRun.activeAttemptId)?.completedAt &&
      (root ? rootRoomResultWakeMatches(live) && (prior.operation.kind === "chat" ||
        rootRoomResultWakeMatches(prior) || rootRoomRestartMatches(prior) || (prior.operation.kind === "card" && !!prior.operation.parked &&
          !prior.operation.handoff)) &&
        (prior.operation.parked?.sourceMessageId ?? prior.operation.requestId) === root.sourceMessageId &&
        prior.rows.some(row => row.id === root.sourceMessageId && row.provenance.authority === "own" &&
          (row.provenance.sender as { id?: string } | undefined)?.id === root.person)
        : roomHandoffMatches(prior) && stableStringify(prior.operation.handoff) === stableStringify(handoff)) &&
      stableStringify(wake) === stableStringify(origin.parentResultWake) && wake.execution === priorExecution + 1 &&
      (!prior.operation.parentResultWake || prior.operation.parentResultWake.startedAt === wake.priorStartedAt) &&
      (!prior.operation.childRestart || prior.operation.childRestart.startedAt === wake.priorStartedAt) &&
      (prior.operation.childRestart?.restarts ?? prior.operation.parentResultWake?.restarts ??
        prior.operation.parked?.restartCount ?? 0) === (wake.restarts ?? 0) &&
      prior.operation.generation === wake.priorGeneration && prior.turnId === wake.priorTurnId &&
      !projection.runs.some(run => {
        const saved = run.mausbotOriginStart;
        return saved?.room && (saved.room.operationId !== room.operationId || saved.room.generation !== room.generation) &&
          reusedParentResultWake(saved, wake);
      }));
  }
  if (restart) {
    const previousHandoff = prior.operation.handoff;
    const previousRun = projection.runs.find(run => run.id === origin.continuation?.predecessorRunId);
    const priorRestart = prior.operation.childRestart;
    const priorRestartCount = priorRestart?.restarts ?? prior.operation.parentResultWake?.restarts ?? prior.operation.parked?.restartCount ?? 0;
    const priorExecution = priorRestart?.execution ?? prior.operation.parentResultWake?.execution ?? (prior.operation.parked ? (prior.operation.parked.priorExecution ?? 1) + 1 : 1);
    const inherited = previousRun?.mausbotOriginStart?.continuation;
    const previousResult = prior.operation.parentResultWake;
    const rootResult = previousResult?.root;
    const validPrior = handoff ? previousHandoff && roomHandoffMatches(prior) &&
      stableStringify(previousHandoff) === stableStringify(handoff)
      : restart.rootResultHash && rootResult && rootRoomRestartMatches(live) && rootRoomResultWakeMatches(prior) &&
        restart.rootResultHash === parentResultWakeHash(previousResult) && restart.priorStartedAt === previousResult.startedAt &&
        live.operation.requestId === rootResult.sourceMessageId && live.rows.some(row =>
          row.id === rootResult.sourceMessageId && (row.provenance.sender as { id?: string } | undefined)?.id === rootResult.person);
    return Boolean(binding && stableStringify(binding) === stableStringify(priorBinding) &&
      validPrior &&
      previousRun?.status === "completed" &&
      latestProviderTurnForAttempt(projection.providerTurns, previousRun.activeAttemptId)?.completedAt &&
      (!priorRestart || (stableStringify(priorRestart) === stableStringify(previousRun.mausbotOriginStart?.childRestart) &&
        priorRestart.startedAt === restart.priorStartedAt)) &&
      (priorRestartCount === 0 || (inherited && inherited.providerThreadId === previousRun.providerThreadId &&
        inherited.providerSessionId === previousRun.mausbotOriginProviderSessionId)) &&
      stableStringify(restart) === stableStringify(origin.childRestart) && restart.execution === priorExecution + 1 &&
      restart.restarts === priorRestartCount + 1 &&
      prior.operation.generation === restart.priorGeneration && prior.turnId === restart.priorTurnId &&
      !projection.runs.some(run => {
        const saved = run.mausbotOriginStart;
        return saved?.room && (saved.room.operationId !== room.operationId || saved.room.generation !== room.generation) &&
          (saved.childRestart?.priorGeneration === restart.priorGeneration ||
            saved.childRestart?.priorTurnId === restart.priorTurnId);
      }));
  }
  return Boolean(binding && stableStringify(binding) === stableStringify(priorBinding)) &&
    handoff && !prior.rows.some(row => row.id === handoff.rowId) &&
    !projection.runs.some(run => {
      const saved = run.mausbotOriginStart?.room;
      if (!saved || (saved.operationId === room.operationId && saved.generation === room.generation)) return false;
      const proof = (JSON.parse(saved.snapshot) as SavedNativeRoomMemberEnrollment).operation?.handoff;
      return proof?.nodeId === handoff.nodeId || proof?.rowId === handoff.rowId;
    });
}

export function reconcileRoomHistory(
  projection: OrchestrationV2ThreadProjection, origin: MausbotOriginStart, history: History,
  sources?: ReadonlyMap<string, OrchestrationV2ThreadProjection>,
) {
  const previous = projection.runs.find(run => run.id === origin.continuation?.predecessorRunId)?.mausbotOriginStart?.room;
  if (!previous || !origin.room) return null;
  type RoomHistorySnapshot = { rows: unknown[]; roster: string[]; dm: boolean };
  const prior = JSON.parse(previous.snapshot) as RoomHistorySnapshot;
  const current = JSON.parse(origin.room.snapshot) as RoomHistorySnapshot;
  if (prior.dm !== current.dm || stableStringify(prior.roster) !== stableStringify(current.roster) ||
      stableStringify(prior.rows) !== stableStringify(current.rows.slice(0, prior.rows.length))) return null;
  const privateItems = roomGoalHistoryItems(projection, origin, sources);
  if (!privateItems || !roomParkedAnswerMatches(projection, origin) || !roomHandoffPredecessorMatches(projection, origin)) return null;
  const messages = projection.messages.filter(row => !privateItems.has(row.id));
  const delta = reconcileCoordinatorHistory({ ...projection, messages }, history);
  return delta && origin.room.currentRowIds.every(id => delta.some(row => row.nativeMessageId === id)) ? delta : null;
}

function roomSetupPredecessorMatches(
  projection: OrchestrationV2ThreadProjection, origin: MausbotOriginStart, live: SavedNativeRoomMemberEnrollment,
) {
  const room = origin.room;
  const setup = live.operation.setup;
  const continuation = origin.continuation;
  if (!room || !setup || !continuation || !roomSetupBatchMatches(live) ||
      !matchesCoordinatorContinuation(continuation, roomPredecessor(projection, room, projection.thread.modelSelection)))
    return false;
  const run = projection.runs.find(row => row.id === continuation.predecessorRunId);
  const savedRoom = run?.mausbotOriginStart?.room;
  const providerTurn = run && latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId);
  if (!run || !savedRoom || run.status !== "completed" || !providerTurn?.completedAt ||
      projection.runtimeRequests.some(request => request.providerTurnId === providerTurn.id && request.status === "pending") ||
      providerTurn.nativeTurnRef?.nativeId !== continuation.nativeTurnId ||
      savedRoom.generation !== setup.batch.priorGeneration || savedRoom.groupId !== setup.roomId ||
      savedRoom.memberId !== setup.memberId || savedRoom.nativeThreadId !== room.nativeThreadId)
    return false;
  const prior = JSON.parse(savedRoom.snapshot) as SavedNativeRoomMemberEnrollment;
  const { operation } = prior;
  const execution = operation.setup ? operation.setup.priorExecution + 1 :
    operation.parked ? (operation.parked.priorExecution ?? 1) + 1 :
      operation.childRestart?.execution ?? operation.parentResultWake?.execution ?? 1;
  const binding = live.memberBindings?.find(item => item.memberId === setup.memberId);
  const priorBinding = prior.memberBindings?.find(item => item.memberId === setup.memberId);
  const ids = roomSetupBatchIds(setup);
  const requests = new Set([...setup.batch.decisions, ...(setup.batch.mixed?.questions ?? [])].map(item => item.requestId));
  if (!binding || stableStringify(binding) !== stableStringify(priorBinding) ||
      operation.nativeOperationId !== setup.priorOperationId || operation.nativeNodeId !== setup.nodeId ||
      operation.nativeExecution !== setup.priorExecution || operation.requestId !== setup.sourceId ||
      operation.generation !== setup.batch.priorGeneration || prior.turnId !== setup.batch.priorTurnId ||
      prior.botId !== live.botId || prior.groupId !== live.groupId || prior.threadId !== live.threadId ||
      execution !== setup.priorExecution || operation.goal ||
      (setup.handoffHash ? !roomHandoffMatches(prior) || !roomHandoffMatches(live) ||
        stableStringify(operation.handoff) !== stableStringify(live.operation.handoff) ||
        stableStringify(operation.handedFor) !== stableStringify(live.operation.handedFor)
        : !!operation.handoff || (execution === 1 ? operation.kind !== "chat" ||
          !operation.sourceRowIds.includes(setup.sourceId) : !(operation.setup || operation.parked ||
            operation.childRestart || operation.parentResultWake))) ||
      prior.rows.some(row => ids.includes(row.id)) ||
      stableStringify(prior.rows) !== stableStringify(live.rows.slice(0, prior.rows.length)) ||
      !parkedQuestionRequestsMatch(projection, run, setup.batch.mixed?.questions ?? [])) return false;
  return !projection.runs.some(candidate => {
    const other = candidate.mausbotOriginStart?.room;
    if (!other || (other.operationId === room.operationId && other.generation === room.generation)) return false;
    const op = (JSON.parse(other.snapshot) as SavedNativeRoomMemberEnrollment).operation;
    if (op?.setup && (op.setup.batch.priorTurnId === setup.batch.priorTurnId ||
        op.setup.batch.priorGeneration === setup.batch.priorGeneration ||
        roomSetupBatchIds(op.setup).some(id => ids.includes(id)) ||
        [...op.setup.batch.decisions, ...(op.setup.batch.mixed?.questions ?? [])].some(item => requests.has(item.requestId) || ("flowId" in item && item.flowId !== undefined &&
          setup.batch.decisions.some(decision => decision.flowId === item.flowId)))))
      return true;
    return !!op?.parked && parkedRoomAnswers(op.parked).some(item => ids.includes(item.cardId) || requests.has(item.requestId));
  });
}

export function roomParkedAnswerMatches(projection: OrchestrationV2ThreadProjection, origin: MausbotOriginStart) {
  if (!origin.room) return true;
  const live = JSON.parse(origin.room.snapshot) as SavedNativeRoomMemberEnrollment;
  const parked = live.operation?.parked;
  if (live.operation?.setup) return roomSetupPredecessorMatches(projection, origin, live);
  if (!parked) return live.operation?.kind !== "card";
  const run = projection.runs.find(row => row.id === origin.continuation?.predecessorRunId);
  const room = run?.mausbotOriginStart?.room;
  if (!run || run.status !== "completed" || !room || !run.activeAttemptId || !run.rootNodeId ||
      mausbotRoomThreadId(room) !== mausbotRoomThreadId(origin.room) ||
      room.generation !== (parked.priorGeneration ?? parked.nodeId) ||
      origin.room.operationId !== parkedRoomAnswerOperationId(parked)) return false;
  const predecessor = JSON.parse(room.snapshot) as SavedNativeRoomMemberEnrollment;
  const priorAnswer = predecessor.operation.parked;
  if (!parkedRoomCardsMatch(parked, live.rows)) return false;
  const answers = parkedRoomAnswers(parked);
  const requestIds = new Set(answers.map(answer => answer.requestId));
  const cardIds = new Set(answers.map(answer => answer.cardId));
  const priorExecution = parked.priorExecution ?? 1;
  const goal = parked.goal;
  const ownsGoalExecution = goal && live.botId === goal.memberId && predecessor.botId === goal.memberId &&
    live.operation.kind === "goal" && predecessor.operation.kind === "goal" &&
    live.operation.goal?.runId === goal.runId && live.operation.goal.cardMessageId === goal.cardId &&
    live.operation.goal.turnCount === goal.step && live.operation.goal.requestId === parked.sourceMessageId &&
    goal.coordinator === (goal.step % 2 === 1) &&
    stableStringify(live.operation.goal) === stableStringify(predecessor.operation.goal) &&
    stableStringify(live.goalHistory ?? []) === stableStringify(predecessor.goalHistory ?? []) &&
    (priorExecution === 1
      ? !priorAnswer && room.operationId === parked.nodeId + (goal.step === 1 ? "" : "-step-" + goal.step)
      : priorAnswer?.nodeId === parked.nodeId && stableStringify(priorAnswer.goal) === stableStringify(goal) &&
        (priorAnswer.priorExecution ?? 0) + 1 === priorExecution && parkedRoomCardsMatch(priorAnswer, live.rows) &&
        room.operationId === parkedRoomAnswerOperationId(priorAnswer));
  const ownsHandoffExecution = parked.handoffHash && roomHandoffMatches(live) &&
    roomHandoffMatches(predecessor) && live.operation.handoff?.chainHash === parked.handoffHash &&
    (parked.restartCount ?? 0) === (predecessor.operation.childRestart?.restarts ??
      predecessor.operation.parentResultWake?.restarts ?? priorAnswer?.restartCount ?? 0) &&
    stableStringify(live.operation.handoff) === stableStringify(predecessor.operation.handoff) &&
    stableStringify(live.operation.handedFor) === stableStringify(predecessor.operation.handedFor) &&
    (priorExecution === 1
      ? !priorAnswer && room.operationId === parked.nodeId
      : predecessor.operation.parentResultWake ? !priorAnswer &&
        predecessor.operation.parentResultWake.execution === priorExecution &&
        room.operationId === parked.nodeId + "-results-" + priorExecution
      : predecessor.operation.childRestart ? !priorAnswer &&
        predecessor.operation.childRestart.execution === priorExecution &&
        room.operationId === parked.nodeId + "-restart-" + priorExecution
      : priorAnswer?.nodeId === parked.nodeId && priorAnswer.handoffHash === parked.handoffHash &&
        (priorAnswer.priorExecution ?? 0) + 1 === priorExecution && parkedRoomCardsMatch(priorAnswer, live.rows) &&
        room.operationId === parkedRoomAnswerOperationId(priorAnswer));
  const priorSetup = predecessor.operation.setup;
  const ownsSetupPredecessor = priorSetup && !goal && roomSetupBatchMatches(predecessor) &&
    priorSetup.nodeId === parked.nodeId && priorSetup.priorExecution + 1 === priorExecution &&
    priorSetup.sourceId === parked.sourceMessageId && priorSetup.handoffHash === parked.handoffHash &&
    (!parked.handoffHash || (roomHandoffMatches(live) &&
      stableStringify(live.operation.handoff) === stableStringify(predecessor.operation.handoff)));
  const ownsPriorExecution = ownsSetupPredecessor || (parked.handoffHash ? ownsHandoffExecution : goal ? ownsGoalExecution : priorExecution === 1
    ? predecessor.operation.kind === "chat" && !priorAnswer && room.generation === parked.nodeId &&
      predecessor.operation.sourceRowIds.includes(parked.sourceMessageId)
    : predecessor.operation.parentResultWake?.root ? predecessor.operation.parentResultWake.execution === priorExecution &&
      room.operationId === parked.nodeId + "-results-" + priorExecution
    : predecessor.operation.kind === "card" && priorAnswer && priorAnswer.nodeId === parked.nodeId &&
      priorAnswer.sourceMessageId === parked.sourceMessageId && (priorAnswer.priorExecution ?? 1) + 1 === priorExecution &&
      parkedRoomCardsMatch(priorAnswer, live.rows));
  const binding = live.memberBindings?.find(row => row.memberId === live.botId);
  const savedBinding = predecessor.memberBindings?.find(row => row.memberId === live.botId);
  if (!ownsPriorExecution || predecessor.operation.requestId !== parked.sourceMessageId ||
      predecessor.turnId !== parked.priorTurnId ||
      predecessor.rows.some(row => cardIds.has(row.id)) ||
      stableStringify(binding) !== stableStringify(savedBinding)) return false;
  if (projection.runs.some(candidate => {
    const saved = candidate.mausbotOriginStart?.room;
    if (!saved || !origin.room || (saved.operationId === origin.room.operationId && saved.generation === origin.room.generation))
      return false;
    const operation = (JSON.parse(saved.snapshot) as SavedNativeRoomMemberEnrollment).operation;
    if (operation?.setup && (roomSetupBatchIds(operation.setup).some(id => cardIds.has(id)) ||
        [...operation.setup.batch.decisions, ...(operation.setup.batch.mixed?.questions ?? [])].some(item => requestIds.has(item.requestId))))
      return true;
    const answered = operation?.parked;
    return answered && parkedRoomAnswers(answered).some(answer => requestIds.has(answer.requestId) || cardIds.has(answer.cardId));
  })) return false;
  const providerTurn = latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId);
  if (!providerTurn) return false;
  const pending = projection.runtimeRequests.filter(request =>
    request.kind === "user_input" && request.providerTurnId === providerTurn.id &&
    (request.status === "expired" || request.status === "cancelled") && !request.decision && !request.answers);
  if (!answers.every(answer => pending.some(request => request.id === answer.requestId &&
      projection.nodes.some(node => node.id === request.nodeId && node.kind === "user_input_request" &&
        node.threadId === projection.thread.id && node.runId === run.id && node.rootNodeId === run.rootNodeId &&
        node.providerTurnId === providerTurn.id && node.runtimeRequestId === request.id)))) return false;
  if (!parked.cardIds) return true;
  if (pending.length !== answers.length) return false;
  const ordered = projection.turnItems.filter(item => item.type === "user_input_request" &&
    item.runId === run.id && item.providerTurnId === providerTurn.id && requestIds.has(item.requestId))
    .sort((left, right) => left.ordinal - right.ordinal);
  return ordered.length === answers.length &&
    ordered.every((item, index) => item.type === "user_input_request" && item.requestId === answers[index]?.requestId &&
      pending.some(request => request.id === item.requestId && request.nodeId === item.nodeId) &&
      (index === 0 || ordered[index - 1]!.ordinal < item.ordinal));
}

function goalParkedProviderRuns(
  projection: OrchestrationV2ThreadProjection,
  origin: MausbotOriginStart,
) {
  const history = new Set<string>();
  let current = origin;
  while (current.room) {
    const snapshot = JSON.parse(current.room.snapshot) as SavedNativeRoomMemberEnrollment;
    if (!snapshot.operation.parked?.goal) return history;
    if (!roomParkedAnswerMatches(projection, current)) return null;
    const prior = projection.runs.find(run => run.id === current.continuation?.predecessorRunId);
    if (!prior?.mausbotOriginStart || history.has(prior.id)) return null;
    history.add(prior.id);
    current = prior.mausbotOriginStart;
  }
  return null;
}

export function roomGoalHistoryItems(
  projection: OrchestrationV2ThreadProjection | undefined, origin: MausbotOriginStart,
  sources?: ReadonlyMap<string, OrchestrationV2ThreadProjection>,
) {
  const privateItems = new Set<string>();
  if (!origin.room) return privateItems;
  const roomMember = origin.room.memberId;
  const live = JSON.parse(origin.room.snapshot) as SavedNativeRoomMemberEnrollment;
  const goal = live.operation?.goal;
  const parked = live.operation?.parked?.goal;
  const next = parked ? undefined : goal?.continuation;
  const fromMember = next?.fromMemberId ?? roomMember;
  const ownerProjection = fromMember === roomMember ? projection : sources?.get(fromMember);
  const foreign = fromMember !== roomMember;
  const run = foreign && ownerProjection
    ? latestExecutedRun(ownerProjection.runs)
    : projection?.runs.find(row => row.id === origin.continuation?.predecessorRunId);
  const foreignBinding = foreign && ownerProjection && run ? ownedMausbotPredecessor(ownerProjection, run, run.modelSelection) : undefined;
  const foreignSession = ownerProjection?.providerSessions?.find(row => row.id === foreignBinding?.providerSessionId);
  if (foreign && (!ownerProjection || !run || run.status !== "completed" ||
      next?.targetMemberId !== roomMember || !live.roster.includes(fromMember) ||
      ownerProjection.runs.some(row => row.ordinal > run.ordinal) ||
      !foreignBinding || !foreignSession || foreignSession.status === "stopped" || foreignSession.status === "error" ||
      ownerProjection.thread.archivedAt != null || ownerProjection.thread.deletedAt != null)) return null;
  const previousRoom = run?.mausbotOriginStart?.room;
  const previous = previousRoom && JSON.parse(previousRoom.snapshot) as SavedNativeRoomMemberEnrollment | undefined;
  const prior = previous?.operation?.goal;
  const journals = live.goalHistory ?? [];
  if (parked) {
    if (!projection || !goal || !prior) return null;
    const parkedRuns = goalParkedProviderRuns(projection, origin);
    if (!parkedRuns) return null;
    if (parked.coordinator) for (const row of projection.messages) {
      if (row.role === "assistant" && row.runId && parkedRuns.has(row.runId)) privateItems.add(row.id);
    }
  } else if ((next || prior) && (!prior || !journals.some(journal => journal.cardId === prior.cardMessageId &&
      journal.runId === prior.runId && (next ? journal.status === "working" : journal.status === "completed")))) return null;
  if (next && (!goal || !prior || !previousRoom || !previous || previous.turnId !== next.previousTurnId ||
      goal.turnCount !== prior.turnCount + 1 ||
      origin.room.operationId !== previous.operation.id.replace(/-answered-\d+$/u, "").replace(/-step-\d+$/u, "") + "-step-" + goal.turnCount ||
      goal.runId !== prior.runId || goal.cardMessageId !== prior.cardMessageId || goal.requestId !== prior.requestId ||
      goal.coordinatorBotId !== prior.coordinatorBotId || goal.startedAt !== prior.startedAt || goal.goal !== prior.goal)) return null;
  if (new Set(journals.map(journal => journal.cardId)).size !== journals.length) return null;
  for (const journal of journals) {
    const active = (next || parked) && goal?.cardMessageId === journal.cardId;
    if (!live.roster?.includes(journal.coordinatorId) && journal.coordinatorId !== roomMember) return null;
    const expectedCount = active ? (goal?.turnCount ?? 0) - 1 : journal.count;
    const card = live.rows?.find(row => row.id === journal.cardId);
    if (!card || card.kind !== "goal.run" || card.text !== undefined || !journal.steps.length ||
        journal.steps.length !== expectedCount || journal.count !== expectedCount + (active ? 1 : 0) ||
        (active ? journal.status !== "working" || journal.finishedAt !== undefined : journal.status !== "completed" ||
          journal.finishedAt === undefined || journal.finishedAt < journal.startedAt ||
          journal.steps.at(-1)?.decision !== "completed")) return null;
    if (new Set(journal.steps.map(step => step.turnId)).size !== journal.steps.length) return null;
    for (const [index, step] of journal.steps.entries()) {
      const memberId = step.memberId ?? journal.coordinatorId;
      const memberProjection = memberId === roomMember ? projection : sources?.get(memberId);
      if (!memberProjection || (step.coordinator && memberId !== journal.coordinatorId) ||
          memberProjection.thread.id !== mausbotRoomThreadId({ ...origin.room, memberId })) return null;
      const matches = memberProjection.runs.filter(candidate => {
        const room = candidate.mausbotOriginStart?.room;
        if (!room || candidate.status !== "completed" || memberProjection.thread.id !== mausbotRoomThreadId(room)) return false;
        const saved = JSON.parse(room.snapshot) as SavedNativeRoomMemberEnrollment;
        const state = saved.operation?.goal;
        return saved.turnId === step.turnId && state?.turnCount === index + 1 &&
          state.cardMessageId === journal.cardId && state.runId === journal.runId && state.goal === journal.goal &&
          state.startedAt === journal.startedAt && state.coordinatorBotId === journal.coordinatorId;
      });
      if (matches.length !== 1) return null;
      const candidate = matches[0]!;
      const saved = JSON.parse(candidate.mausbotOriginStart!.room!.snapshot) as SavedNativeRoomMemberEnrollment;
      const request = live.rows.find(row => row.id === saved.operation.goal?.requestId);
      const savedRequest = saved.rows.find(row => row.id === request?.id);
      const memberBinding = live.memberBindings?.find(row => row.memberId === memberId);
      const savedBinding = saved.memberBindings?.find(row => row.memberId === memberId);
      const recipientBinding = live.memberBindings?.find(row => row.memberId === roomMember);
      const handsOffCurrentResult = next && active && index === expectedCount - 1 && memberId !== roomMember;
      if (handsOffCurrentResult && stableStringify(memberBinding) !== stableStringify(savedBinding)) return null;
      const replies = memberProjection.messages.filter(row => row.role === "assistant" && row.runId === candidate.id);
      const byId = new Map(replies.map(row => [String(row.id), row]));
      const ordered = step.itemIds.map(id => byId.get(id));
      const providerOrder = memberProjection.turnItems.filter(item => item.type === "assistant_message" &&
        item.messageId && byId.has(item.messageId)).sort((left, right) => left.ordinal - right.ordinal);
      const publicRows = live.rows.filter(row => row.turnId === step.turnId && row.kind === "text" &&
        (row.provenance.from as { botId?: string } | undefined)?.botId === memberId);
      if (!request || request.text !== journal.goal || request.provenance.authority !== "own" ||
          (memberId !== roomMember && memberBinding?.projectId && recipientBinding?.projectId &&
            memberBinding.projectId !== recipientBinding.projectId &&
            stableStringify(memberBinding) !== stableStringify(savedBinding)) ||
          !savedRequest || request.at !== savedRequest.at || request.text !== savedRequest.text ||
          stableStringify(request.provenance.sender) !== stableStringify(savedRequest.provenance.sender) ||
          (saved.roster && live.roster && stableStringify(saved.roster) !== stableStringify(live.roster)) ||
          saved.turnId !== step.turnId || saved.operation.goal?.turnCount !== index + 1 || step.coordinator !== (index % 2 === 0) ||
          replies.length !== ordered.length || !ordered.length || new Set(step.itemIds).size !== ordered.length ||
          stableStringify(providerOrder.map(item => "messageId" in item ? item.messageId : null)) !== stableStringify(step.itemIds) ||
          ordered.some(row => !row || row.threadId !== memberProjection.thread.id || row.streaming || row.attachments.length)) return null;
      const reply = ordered.map(row => row!.text).join("\n").trim();
      if (NodeCrypto.createHash("sha256").update(reply).digest("hex") !== step.replyHash) return null;
      const decision = step.coordinator ? roomGoalControl(reply) : undefined;
      if (decision?.status !== step.decision) return null;
      if (step.coordinator) {
        if (publicRows.length !== (step.publicRowId ? 1 : 0) ||
            (step.publicRowId && (publicRows[0]?.id !== step.publicRowId ||
              NodeCrypto.createHash("sha256").update(publicRows[0].text ?? "").digest("hex") !== step.publicHash))) return null;
        const earlier = candidate.mausbotOriginStart && goalParkedProviderRuns(memberProjection, candidate.mausbotOriginStart);
        if (!earlier) return null;
        if (memberId === roomMember) {
          for (const id of step.itemIds) privateItems.add(id);
          for (const row of memberProjection.messages) {
            if (row.role === "assistant" && row.runId && earlier.has(row.runId)) privateItems.add(row.id);
          }
        }
      } else if (publicRows.length !== ordered.length ||
          publicRows.some((row, position) => row.j1ProviderMessageId !== step.itemIds[position])) return null;
      if (next && active && index === expectedCount - 1 && (memberId !== fromMember || candidate.id !== run?.id || next.previousTurnId !== step.turnId ||
          next.coordinator !== step.coordinator || stableStringify(next.itemIds) !== stableStringify(step.itemIds) ||
          reply !== next.reply || (step.coordinator
            ? decision?.status !== "continue" || decision.instruction?.trim().slice(0, 2_000) !== next.assignment
            : next.assignment !== "Continue coordinating the saved room goal using the completed member result."))) return null;
    }
  }
  return privateItems;
}

function roomGoalControl(reply: string): { status: string; instruction?: string } | undefined {
  const open = "<openmaus-goal>";
  const end = reply.lastIndexOf("</openmaus-goal>");
  const start = end < 0 ? -1 : reply.lastIndexOf(open, end);
  if (start < 0) return undefined;
  try {
    const value = JSON.parse(reply.slice(start + open.length, end)) as { status?: unknown; instruction?: unknown; detail?: unknown } | null;
    if (!value || typeof value.status !== "string") return undefined;
    if (value.status === "continue" && typeof value.instruction === "string" && value.instruction.trim())
      return { status: value.status, instruction: value.instruction };
    if (["completed", "needs-input", "blocked"].includes(value.status) &&
        typeof value.detail === "string" && value.detail.trim()) return { status: value.status };
  } catch { /* Invalid private control is not a settled decision. */ }
  return undefined;
}

export function incidentPredecessor(
  projection: OrchestrationV2ThreadProjection,
  origin: Pick<MausbotOriginStart, "nodeId" | "incidentBatch">,
  modelSelection: OrchestrationV2ThreadProjection["thread"]["modelSelection"],
): MausbotOriginStart["continuation"] {
  if (!origin.incidentBatch) return undefined;
  const reports = new Set(origin.incidentBatch.reports.map(report => report.nativeMessageId));
  const current = projection.runs.find(row => row.mausbotOriginStart?.nodeId === origin.nodeId);
  const candidates = projection.runs.filter(row => row.id !== current?.id);
  const run = latestExecutedRun(candidates);
  const previous = run?.mausbotOriginStart?.incidentBatch;
  if (!run || !previous || run.status !== "completed" ||
      previous.generation === origin.incidentBatch.generation ||
      (current && current.ordinal <= run.ordinal) ||
      candidates.some(row => row.ordinal > run.ordinal ||
        row.mausbotOriginStart?.incidentBatch?.reports.some(report => reports.has(report.nativeMessageId)))) return undefined;
  const target = ownedMausbotPredecessor(projection, run, modelSelection);
  const session = projection.providerSessions.find(row => row.id === target?.providerSessionId);
  return session && session.status !== "stopped" && session.status !== "error" ? target : undefined;
}

function ownedMausbotPredecessor(
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2ThreadProjection["runs"][number],
  modelSelection: OrchestrationV2ThreadProjection["thread"]["modelSelection"],
): MausbotOriginStart["continuation"] {
  if (run.threadId !== projection.thread.id || !run.activeAttemptId || !run.rootNodeId ||
      !modelSelectionsEqual(run.modelSelection, modelSelection)) return undefined;
  const attempt = projection.attempts.find(row => row.id === run.activeAttemptId);
  const providerThread = projection.providerThreads.find(row => row.id === run.providerThreadId);
  const session = projection.providerSessions.find(row => row.id === providerThread?.providerSessionId);
  const turn = latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId);
  if (!attempt || attempt.runId !== run.id || attempt.rootNodeId !== run.rootNodeId ||
      attempt.reason !== "initial" || attempt.attemptOrdinal !== 1 ||
      attempt.status !== run.status || !attempt.nativeThreadId ||
      !providerThread || providerThread.appThreadId !== run.threadId || providerThread.ownerNodeId !== null ||
      attempt.providerThreadId !== providerThread.id || attempt.providerInstanceId !== modelSelection.instanceId ||
      !run.mausbotOriginProviderSessionId || run.mausbotOriginProviderSessionId !== providerThread.providerSessionId ||
      providerThread.status === "closed" || providerThread.status === "archived" ||
      providerThread.providerInstanceId !== modelSelection.instanceId ||
      providerThread.nativeThreadRef?.strength !== "strong" ||
      providerThread.nativeThreadRef.nativeId !== attempt.nativeThreadId ||
      providerThread.nativeThreadRef.driver !== providerThread.driver ||
      !session || session.driver !== providerThread.driver || session.providerInstanceId !== modelSelection.instanceId ||
      !turn || turn.providerThreadId !== providerThread.id || turn.nodeId !== run.rootNodeId ||
      turn.startedAt === null || turn.nativeTurnRef?.strength !== "strong" || !turn.nativeTurnRef.nativeId ||
      turn.nativeTurnRef.driver !== providerThread.driver || turn.status !== run.status) return undefined;
  return {
    predecessorRunId: run.id, providerThreadId: providerThread.id,
    providerSessionId: session.id, nativeThreadId: providerThread.nativeThreadRef.nativeId,
    nativeTurnId: turn.nativeTurnRef.nativeId,
  };
}

export function reconcileIncidentHistory(
  projection: OrchestrationV2ThreadProjection,
  history: History,
  incident: NonNullable<MausbotOriginStart["incidentBatch"]>,
) {
  const delta = reconcileCoordinatorHistory(projection, history);
  if (!delta) return null;
  const reports = delta.filter(row => row.role === "user");
  return reports.length === incident.reports.length &&
    reports.every((row, index) => row.nativeMessageId === incident.reports[index]?.nativeMessageId) &&
    delta.every(row => row.role === "user" || (!row.text && !row.attachments.length))
    ? delta : null;
}

export function reconcileCoordinatorHistory(
  projection: OrchestrationV2ThreadProjection, history: History,
) {
  const rows = projection.messages.filter(row => row.role === "user" || row.role === "assistant");
  const visible = new Map(rows.map(row => [row.id, row]));
  const order = new Map(projection.turnItems.flatMap(item =>
    "messageId" in item && item.messageId && (item.type === "user_message" || item.type === "assistant_message")
      ? [[item.messageId, item.ordinal] as const] : []));
  const authoredRuns = new Set(projection.runs.filter(run => run.mausbotOriginStart).map(run => run.id));
  const roots = new Map<string, { origin: MausbotOriginStart; runId: string }>();
  for (const run of projection.runs) {
    const origin = run.mausbotOriginStart;
    if (!origin?.rootSource || origin.dispatch !== "first") continue;
    if (roots.has(origin.rootSource.nativeMessageId)) return null;
    roots.set(origin.rootSource.nativeMessageId, { origin, runId: run.id });
  }
  const attached = new Set<MessageId>();
  const suffix: History[number][] = [];
  let lastOrdinal = -1;
  let pendingActivity: History[number][] = [];
  for (const row of history) {
    const mapped = mausbotHistoryMessageId(projection.thread.id, row.nativeMessageId);
    const mirror = row.mirrorMessageId ? MessageId.make(row.mirrorMessageId) : undefined;
    if (mirror && visible.has(mirror) && visible.has(mapped)) return null;
    const root = roots.get(row.nativeMessageId);
    if (root && (mirror || visible.has(mapped) || row.role !== "user" ||
        coordinatorRowHash(row) !== root.origin.rootSource?.hash)) return null;
    const messageId = root?.origin.sourceMessageId ?? (visible.has(mapped) ? mapped : mirror ?? mapped);
    const mirrored = mirror !== undefined && messageId === mirror;
    const saved = visible.get(messageId);
    if (!saved && !row.mirrorMessageId && !root) {
      // Empty native status rows are not provider dialogue and may occur before a mirrored reply.
      if (!row.text && !row.attachments.length && row.role === "assistant") pendingActivity.push(row);
      else suffix.push(...pendingActivity.splice(0), row);
      continue;
    }
    const ordinal = order.get(messageId);
    if (!saved || (mirrored && (row.role !== "assistant" ||
          !saved.runId || !authoredRuns.has(saved.runId))) ||
        suffix.length || attached.has(messageId) || ordinal === undefined || ordinal <= lastOrdinal ||
        saved.threadId !== projection.thread.id || saved.role !== row.role || saved.streaming ||
        saved.text !== (root ? root.origin.text : row.text) ||
        stableStringify(saved.attachments) !== stableStringify(root ? root.origin.attachments : row.attachments) ||
        (root && saved.runId !== root.runId) ||
        (!root && !mirrored && (saved.runId !== null || DateTime.formatIso(saved.createdAt) !== row.createdAt ||
          DateTime.formatIso(saved.updatedAt) !== (row.completedAt ?? row.createdAt)))) return null;
    pendingActivity = [];
    attached.add(messageId);
    lastOrdinal = ordinal;
  }
  return attached.size === rows.length ? [...suffix, ...pendingActivity] : null;
}
