// @effect-diagnostics nodeBuiltinImport:off - Copies files from the captured native store.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  BotInstructions,
  BotName,
  ChatAttachment,
  IsoDateTime,
  ModelSelection,
  ProjectId,
  MausbotComputerSelection,
  MausbotIncidentBatch,
  MausbotIncidentRetryNote,
  MausbotPrivateAnswers,
  MausbotChildRestart,
  MausbotParentResultWake,
  MausbotConsultation,
  MausbotParkedStatus,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ThreadId,
} from "@j1code/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { stableStringify } from "@j1code/shared/relaySigning";
import {
  chatAttachmentStableKey,
  createDeterministicAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import { matchesImageSignature } from "../guest/guestAttachments.ts";

const NativeSelectionId = /^[\w-]{1,120}$/u;
const NativeId = Schema.String.check(Schema.isPattern(NativeSelectionId));
const ParkedRoomAnswer = Schema.Struct({
  cardId: NativeId,
  requestId: Schema.String,
  nodeId: NativeId,
  priorTurnId: NativeId,
  sourceMessageId: NativeId,
  person: Schema.String,
  answer: Schema.String,
  priorGeneration: Schema.optionalKey(NativeId),
  priorExecution: Schema.optionalKey(Schema.Int),
  restartCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  cardIds: Schema.optionalKey(Schema.Array(NativeId)),
  handoffHash: Schema.optionalKey(Schema.String),
  goal: Schema.optionalKey(
    Schema.Struct({
      runId: NativeId,
      cardId: NativeId,
      step: Schema.Int,
      memberId: NativeId,
      coordinator: Schema.Boolean,
    }),
  ),
});
const ParkedRoomAnswers = Schema.Struct({
  ...ParkedRoomAnswer.fields,
  additionalAnswers: Schema.optionalKey(Schema.Array(ParkedRoomAnswer)),
});
const RoomSetupHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const RoomSetupPerson = Schema.String.check(Schema.isPattern(/^p_[\w-]{22}$/u));
const RoomSetup = Schema.Struct({
  nodeId: NativeId,
  memberId: NativeId,
  roomId: NativeId,
  sourceId: NativeId,
  sourceHash: RoomSetupHash,
  priorOperationId: NativeId,
  person: RoomSetupPerson,
  priorExecution: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  handoffHash: Schema.optionalKey(RoomSetupHash),
  batch: MausbotParkedStatus,
});
const RoomSetupDecision = Schema.Struct({
  roomId: NativeId,
  memberId: NativeId,
  operationId: NativeId,
  nodeId: NativeId,
  execution: Schema.Int,
  generation: NativeId,
  turnId: NativeId,
  sourceId: NativeId,
  sourceHash: RoomSetupHash,
  handoffHash: Schema.optionalKey(RoomSetupHash),
  person: RoomSetupPerson,
  actionHash: RoomSetupHash,
  family: Schema.optionalKey(Schema.Literals(["mcp", "oauth", "app", "signin", "credential"])),
  flowId: Schema.optionalKey(NativeId),
  group: Schema.optionalKey(
    Schema.Struct({
      id: NativeId,
      cardIds: Schema.Array(NativeId).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
    }),
  ),
  requestId: NativeId,
  cardIds: Schema.Array(NativeId).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  decision: Schema.Struct({
    state: Schema.Literals(["applied", "denied", "cancelled", "failed", "acknowledged", "saved"]),
    hash: RoomSetupHash,
  }),
});
const RoomHandoffLink = Schema.Struct({
  nodeId: NativeId,
  parentId: NativeId,
  senderId: NativeId,
  memberId: NativeId,
  groupId: Schema.optionalKey(NativeId),
  threadId: NativeId,
  requestId: NativeId,
  rowId: NativeId,
  assignmentHash: Schema.String,
  approvalGranted: Schema.Boolean,
  reply: Schema.Literals(["resume", "poll", "none"]),
  mode: Schema.optionalKey(Schema.Literals(["notify", "consult"])),
  since: Schema.Int,
  startedAt: Schema.Int,
  upstream: Schema.optionalKey(
    Schema.Struct({
      nodeId: NativeId,
      generation: NativeId,
      turnId: NativeId,
      startedAt: Schema.Int,
      hash: Schema.String,
      restart: Schema.optionalKey(MausbotChildRestart),
      result: Schema.optionalKey(
        Schema.Struct({ execution: Schema.Int, startedAt: Schema.Int, hash: Schema.String }),
      ),
      resume: Schema.optionalKey(
        Schema.Struct({
          execution: Schema.Int,
          startedAt: Schema.Int,
          answerHash: Schema.String,
        }),
      ),
    }),
  ),
});
const NativeRoomMemberEnrollment = Schema.Struct({
  botId: NativeId,
  threadId: NativeId,
  turnId: NativeId,
  groupId: NativeId,
  dm: Schema.Boolean,
  roster: Schema.Array(NativeId),
  memberBindings: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        memberId: NativeId,
        projectId: Schema.NullOr(ProjectId),
        workspace: Schema.String,
        selection: ModelSelection,
        variant: Schema.optionalKey(Schema.String),
        effort: Schema.optionalKey(Schema.String),
        approvalMode: Schema.Literals(["ask", "edits", "auto", "full"]),
        restrictedTools: Schema.Boolean,
        toolScopeSignature: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  goalHistory: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        cardId: NativeId,
        runId: NativeId,
        coordinatorId: NativeId,
        startedAt: Schema.Int,
        count: Schema.Int,
        status: Schema.Literals(["working", "completed"]),
        goal: Schema.String,
        finishedAt: Schema.optionalKey(Schema.Int),
        steps: Schema.Array(
          Schema.Struct({
            turnId: NativeId,
            itemIds: Schema.Array(Schema.String),
            coordinator: Schema.Boolean,
            replyHash: Schema.String,
            memberId: Schema.optionalKey(NativeId),
            publicRowId: Schema.optionalKey(NativeId),
            publicHash: Schema.optionalKey(Schema.String),
            decision: Schema.optionalKey(Schema.String),
          }),
        ),
      }),
    ),
  ),
  enrollment: Schema.Struct({
    name: BotName,
    workspace: Schema.String,
    selection: ModelSelection,
    variant: Schema.optionalKey(Schema.String),
    approvalMode: Schema.Literals(["ask", "edits", "auto", "full"]),
    restrictedTools: Schema.Boolean,
  }),
  operation: Schema.Struct({
    id: NativeId,
    generation: NativeId,
    kind: Schema.Literals(["chat", "orchestration", "card", "goal", "handoff"]),
    requestId: Schema.optionalKey(NativeId),
    parked: Schema.optionalKey(ParkedRoomAnswers),
    setup: Schema.optionalKey(RoomSetup),
    nativeOperationId: Schema.optionalKey(NativeId),
    nativeNodeId: Schema.optionalKey(NativeId),
    nativeExecution: Schema.optionalKey(Schema.Int),
    childRestart: Schema.optionalKey(MausbotChildRestart),
    parentResultWake: Schema.optionalKey(MausbotParentResultWake),
    goal: Schema.optionalKey(
      Schema.Struct({
        runId: NativeId,
        cardMessageId: NativeId,
        requestId: NativeId,
        coordinatorBotId: NativeId,
        startedAt: Schema.Int,
        turnCount: Schema.Int,
        status: Schema.Literal("working"),
        goal: Schema.String,
        instructions: Schema.String,
        continuation: Schema.optionalKey(
          Schema.Struct({
            previousTurnId: NativeId,
            reply: Schema.String,
            assignment: Schema.String,
            coordinator: Schema.Boolean,
            itemIds: Schema.Array(Schema.String),
            fromMemberId: Schema.optionalKey(NativeId),
            targetMemberId: Schema.optionalKey(NativeId),
          }),
        ),
      }),
    ),
    sourceRowIds: Schema.Array(NativeId),
    queuedIds: Schema.Array(NativeId),
    instructionsBeforeHistory: Schema.String,
    historicalInstructionText: Schema.String,
    instructionsAfterHistory: Schema.String,
    renderedWindowIds: Schema.Array(NativeId),
    handedFor: Schema.optionalKey(Schema.Unknown),
    handoff: Schema.optionalKey(
      Schema.Struct({
        nodeId: NativeId,
        rootId: NativeId,
        requestId: NativeId,
        rowId: NativeId,
        sourceThreadId: NativeId,
        sourceMessageId: NativeId,
        sourceHash: Schema.String,
        senderId: NativeId,
        memberId: NativeId,
        groupId: NativeId,
        threadId: NativeId,
        assignment: Schema.String,
        assignmentHash: Schema.String,
        displayText: Schema.String,
        consultationText: Schema.optionalKey(Schema.String),
        externalConsult: Schema.optionalKey(Schema.Literal(true)),
        person: Schema.String,
        since: Schema.Int,
        approvalGranted: Schema.Boolean,
        reply: Schema.Literals(["resume", "poll", "none"]),
        mode: Schema.optionalKey(Schema.Literals(["notify", "consult"])),
        parentId: Schema.optionalKey(NativeId),
        chain: Schema.optionalKey(Schema.Array(RoomHandoffLink)),
        chainHash: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
  rows: Schema.Array(
    Schema.Struct({
      id: NativeId,
      at: Schema.Int,
      role: Schema.Literals(["user", "bot"]),
      parkedAnswer: Schema.optionalKey(ParkedRoomAnswer),
      setupDecision: Schema.optionalKey(RoomSetupDecision),
      kind: Schema.String,
      text: Schema.optionalKey(Schema.String),
      turnId: Schema.optionalKey(Schema.String),
      turnCompletedAt: Schema.optionalKey(Schema.Int),
      j1ProviderMessageId: Schema.optionalKey(Schema.String),
      attachments: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            kind: Schema.Literals(["image", "file", "audio"]),
            path: Schema.String,
            mime: Schema.String,
            name: Schema.optionalKey(Schema.String),
            source: Schema.optionalKey(Schema.String),
            durationMs: Schema.optionalKey(Schema.Number),
            text: Schema.optionalKey(Schema.String),
          }),
        ),
      ),
      provenance: Schema.Struct({
        authority: Schema.Literals(["own", "on-behalf", "information"]),
        sender: Schema.optionalKey(Schema.Unknown),
        from: Schema.optionalKey(Schema.Unknown),
        peerAsk: Schema.optionalKey(Schema.Unknown),
        peerPost: Schema.optionalKey(Schema.Unknown),
        roomRequest: Schema.optionalKey(Schema.Unknown),
        handed: Schema.optionalKey(Schema.Unknown),
        webhookPost: Schema.optionalKey(Schema.Unknown),
        relayed: Schema.optionalKey(Schema.Boolean),
        aside: Schema.optionalKey(Schema.Unknown),
        via: Schema.optionalKey(Schema.String),
        replyToId: Schema.optionalKey(Schema.String),
        reaction: Schema.optionalKey(Schema.String),
        queueId: Schema.optionalKey(NativeId),
        digest: Schema.optionalKey(Schema.Unknown),
        channelMode: Schema.optionalKey(Schema.String),
        automated: Schema.optionalKey(Schema.Boolean),
        requestMessageId: Schema.optionalKey(NativeId),
        fromApp: Schema.optionalKey(Schema.Unknown),
        pointed: Schema.optionalKey(Schema.Unknown),
      }),
    }),
  ),
});
export type SavedNativeRoomMemberEnrollment = typeof NativeRoomMemberEnrollment.Type;
type RoomAnswerBatch = NonNullable<SavedNativeRoomMemberEnrollment["operation"]["parked"]>;

function isOwnRoomRequest(row: SavedNativeRoomMemberEnrollment["rows"][number]) {
  const { provenance } = row;
  return (
    row.role === "user" &&
    row.kind === "text" &&
    provenance.authority === "own" &&
    !provenance.automated &&
    !provenance.fromApp &&
    !provenance.webhookPost &&
    !provenance.handed
  );
}

export function parkedRoomAnswers({ additionalAnswers, ...first }: RoomAnswerBatch) {
  return [first, ...(additionalAnswers ?? [])];
}

export function parkedRoomAnswerText(parked: RoomAnswerBatch) {
  const answers = parkedRoomAnswers(parked);
  if (answers.length === 1) return parked.answer;
  return (
    "Here are the answers to your parked questions in their original order.\n" +
    JSON.stringify(answers.map(({ requestId, answer }) => ({ requestId, answer })))
  );
}

export function parkedRoomCardsMatch(
  parked: RoomAnswerBatch,
  rows: readonly { id: string; parkedAnswer?: RoomAnswerBatch }[],
) {
  const answers = parkedRoomAnswers(parked);
  const ids = answers.map((answer) => answer.cardId);
  if (
    parked.additionalAnswers?.length === 0 ||
    (parked.cardIds
      ? stableStringify(parked.cardIds) !== stableStringify(ids)
      : answers.length !== 1) ||
    new Set(ids).size !== ids.length ||
    new Set(answers.map((answer) => answer.requestId)).size !== ids.length
  )
    return false;
  return answers.every((answer) => {
    const matching = rows.filter((row) => row.id === answer.cardId);
    return (
      matching.length === 1 &&
      answer.nodeId === parked.nodeId &&
      answer.priorTurnId === parked.priorTurnId &&
      answer.sourceMessageId === parked.sourceMessageId &&
      answer.priorGeneration === parked.priorGeneration &&
      answer.priorExecution === parked.priorExecution &&
      answer.restartCount === parked.restartCount &&
      (!answer.restartCount ||
        (Boolean(answer.handoffHash) && (answer.priorExecution ?? 0) > answer.restartCount)) &&
      stableStringify(answer.cardIds) === stableStringify(parked.cardIds) &&
      stableStringify(answer.goal) === stableStringify(parked.goal) &&
      answer.handoffHash === parked.handoffHash &&
      Boolean(
        answer.answer.trim() &&
        answer.answer.length <= 12_000 &&
        answer.person.trim() &&
        answer.requestId.trim(),
      ) &&
      (parked.priorExecution === undefined
        ? parked.priorGeneration === undefined &&
          parked.cardIds === undefined &&
          (matching[0]?.parkedAnswer === undefined ||
            stableStringify(matching[0].parkedAnswer) === stableStringify(answer))
        : parked.priorExecution > 0 &&
          parked.priorGeneration !== undefined &&
          stableStringify(matching[0]?.parkedAnswer) === stableStringify(answer))
    );
  });
}

type RoomSetupBatch = NonNullable<SavedNativeRoomMemberEnrollment["operation"]["setup"]>;

export function roomSetupBatchOperationId(setup: RoomSetupBatch) {
  return setup.nodeId + "-setup-" + (setup.priorExecution + 1);
}

export function roomSetupBatchIds(setup: RoomSetupBatch) {
  return setup.batch.mixed?.cardOrder ?? setup.batch.decisions.map((decision) => decision.cardId);
}

export function roomSetupBatchText(setup: RoomSetupBatch) {
  return parkedSetupStatusText(setup.batch);
}

export function parkedSetupStatusText(batch: MausbotParkedStatus) {
  const ids = batch.mixed?.cardOrder ?? batch.decisions.map((decision) => decision.cardId);
  const decisions = ids.flatMap<{ requestId: string; answer?: string; state?: string }>((id) => {
    const question = batch.mixed?.questions.find((item) => item.cardId === id);
    if (question) return [{ requestId: question.requestId, answer: question.answer }];
    const status = batch.decisions.find((item) => item.cardId === id);
    return status ? [{ requestId: status.requestId, state: status.state }] : [];
  });
  const label = batch.mixed
    ? "Parked decisions: "
    : batch.kind === "team-setup"
      ? "Team setup status: "
      : batch.kind === "signin-ack"
        ? "Sign-in acknowledgement: "
        : batch.kind === "credential-status"
          ? "Credential status: "
          : "Setup status: ";
  const note = batch.decisions.some((item) => item.family === "signin")
    ? " For acknowledged sign-in cards, recheck the intended destination and account on the original surface before continuing. Acknowledgement does not verify sign-in or authorize credential use. Honor cancellations."
    : "";
  return (
    label +
    JSON.stringify(decisions) +
    ". Continue the existing task without repeating the setup or treating its result as approval for another action." +
    note +
    (batch.decisions.some((item) => item.family === "credential")
      ? " A saved credential is available only through its original secure entry. Use the original authorized operation and honor cancellations."
      : "")
  );
}

function setupBatchKindMatches(status: MausbotParkedStatus) {
  const hasCredential = status.decisions.some((item) => item.family === "credential");
  if (
    status.decisions.some((item) =>
      item.family === "credential"
        ? item.requestId !== item.cardId || (item.state !== "saved" && item.state !== "cancelled")
        : item.state === "saved",
    )
  )
    return false;
  const hasSignIn = status.decisions.some((item) => item.family === "signin");
  if (
    status.decisions.some((item) =>
      item.family === "signin"
        ? item.requestId !== item.cardId ||
          (item.state !== "acknowledged" && item.state !== "cancelled")
        : item.state === "acknowledged",
    )
  )
    return false;
  const apps = status.decisions.filter((item) => item.family === "app");
  if (status.decisions.some((item) => item.family !== "app" && item.group)) return false;
  for (const item of apps) {
    const group = item.group;
    if (
      !group ||
      item.requestId !== item.cardId ||
      group.cardIds.length > 12 ||
      !group.cardIds.includes(item.cardId) ||
      stableStringify(group.cardIds) !==
        stableStringify(
          apps.filter((other) => other.group?.id === group.id).map((other) => other.cardId),
        ) ||
      new Set(group.cardIds).size !== group.cardIds.length
    )
      return false;
  }
  const fresh = status.decisions.filter(
    (item) =>
      item.family === "oauth" ||
      item.family === "app" ||
      (item.family === "credential" && item.state === "saved"),
  );
  const flowIds = new Set(fresh.map((item) => item.flowId));
  return (
    status.kind ===
      (hasCredential
        ? "credential-status"
        : hasSignIn
          ? "signin-ack"
          : fresh.some((item) => item.family === "app")
            ? "app-connector"
            : fresh.length
              ? "mcp-oauth"
              : status.decisions.some((item) => item.family === "mcp")
                ? "mcp-setup"
                : "team-setup") &&
    flowIds.size === fresh.length &&
    status.decisions.every((item) =>
      fresh.includes(item)
        ? (item.family === "credential" ? item.state === "saved" : item.state === "applied") &&
          !!item.flowId &&
          /^[a-f0-9-]{36}$/u.test(item.flowId)
        : item.flowId === undefined,
    )
  );
}

export function privateSetupReviewMatches(
  status: MausbotParkedStatus,
  nodeId: string,
  sourceId?: string,
  scopeHash?: string,
) {
  const review = status.privateReview;
  if (!setupBatchKindMatches(status)) return false;
  if (status.kind === "team-setup")
    return !review && status.decisions.every((item) => !item.family && !item.reviewHash);
  if (
    !review ||
    (sourceId !== undefined && review.sourceId !== sourceId) ||
    (scopeHash !== undefined && review.scopeHash !== scopeHash) ||
    !/^p_[\w-]{22}$/u.test(review.person) ||
    !status.decisions.some((item) => item.family) ||
    status.mixed?.questions.some((item) => item.person !== review.person)
  )
    return false;
  return status.decisions.every((item) =>
    item.family
      ? item.reviewHash ===
        NodeCrypto.createHash("sha256")
          .update(
            JSON.stringify([
              nodeId,
              status.priorGeneration,
              status.priorTurnId,
              review.sourceId,
              review.scopeHash,
              review.person,
              item.cardId,
              item.requestId,
              item.actionHash,
              item.state,
              ...(item.flowId ? [item.flowId] : []),
              ...(item.group ? [[item.group.id, item.group.cardIds]] : []),
            ]),
          )
          .digest("hex")
      : !item.family && !item.reviewHash,
  );
}

export function roomSetupBatchMatches(
  snapshot: Pick<
    SavedNativeRoomMemberEnrollment,
    "botId" | "groupId" | "threadId" | "turnId" | "operation" | "rows"
  >,
) {
  const { operation, rows } = snapshot;
  const setup = operation.setup;
  if (
    !setup ||
    setup.batch.privateReview ||
    setup.batch.decisions.some((item) => item.reviewHash) ||
    operation.parked ||
    operation.childRestart ||
    operation.parentResultWake ||
    operation.goal ||
    operation.id !== roomSetupBatchOperationId(setup) ||
    operation.requestId !== setup.sourceId ||
    operation.sourceRowIds.length ||
    operation.queuedIds.length ||
    !operation.nativeOperationId ||
    operation.nativeOperationId === setup.priorOperationId ||
    operation.nativeNodeId !== setup.nodeId ||
    operation.nativeExecution !== setup.priorExecution + 1 ||
    setup.roomId !== snapshot.groupId ||
    setup.memberId !== snapshot.botId ||
    setup.batch.priorGeneration === operation.generation ||
    setup.batch.priorTurnId === snapshot.turnId
  )
    return false;
  const source = rows.find((row) => row.id === setup.sourceId);
  const handoff = operation.handoff;
  if (
    !source ||
    (handoff
      ? operation.kind !== "handoff" ||
        !!handoff.mode ||
        !setup.handoffHash ||
        setup.handoffHash !== handoff.chainHash ||
        setup.nodeId !== handoff.nodeId ||
        setup.person !== handoff.person ||
        source.role !== "bot" ||
        source.provenance.authority !== "on-behalf"
      : operation.kind !== "card" ||
        !!setup.handoffHash ||
        !isOwnRoomRequest(source) ||
        (source.provenance.sender as { id?: string } | undefined)?.id !== setup.person)
  )
    return false;
  const sourceHash = NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        source.id,
        source.at,
        source.text,
        (source.provenance.sender as { id?: string } | undefined)?.id,
      ]),
    )
    .digest("hex");
  if (sourceHash !== setup.sourceHash) return false;
  const questions = setup.batch.mixed?.questions ?? [];
  const decisions = setup.batch.decisions;
  const cards = [...decisions, ...questions];
  const ids = roomSetupBatchIds(setup);
  const selected = new Set(ids);
  const matching = rows.filter((row) => selected.has(row.id));
  if (
    !decisions.length ||
    !setupBatchKindMatches(setup.batch) ||
    (setup.batch.mixed && !questions.length) ||
    ids.length > 32 ||
    selected.size !== cards.length ||
    new Set(cards.map((item) => item.cardId)).size !== selected.size ||
    new Set(cards.map((item) => item.requestId)).size !== selected.size ||
    cards.some((item) => !selected.has(item.cardId)) ||
    stableStringify(matching.map((row) => row.id)) !== stableStringify(ids) ||
    stableStringify(matching.filter((row) => row.setupDecision).map((row) => row.id)) !==
      stableStringify(decisions.map((row) => row.cardId)) ||
    stableStringify(matching.filter((row) => row.parkedAnswer).map((row) => row.id)) !==
      stableStringify(questions.map((row) => row.cardId))
  )
    return false;
  if (
    matching.some(
      (row) =>
        row.role !== "bot" ||
        row.kind !==
          (row.setupDecision?.family === "credential"
            ? "secret"
            : row.setupDecision?.family === "signin"
              ? "signin"
              : row.setupDecision?.family === "oauth" || row.setupDecision?.family === "app"
                ? "connector"
                : "options") ||
        row.attachments?.length ||
        row.j1ProviderMessageId ||
        (row.provenance.from as { botId?: string } | undefined)?.botId !== snapshot.botId,
    )
  )
    return false;
  if (
    !decisions.every((item) => {
      const saved = matching.find((row) => row.id === item.cardId)?.setupDecision;
      if (
        !saved ||
        saved.roomId !== setup.roomId ||
        saved.memberId !== setup.memberId ||
        saved.operationId !== setup.priorOperationId ||
        saved.nodeId !== setup.nodeId ||
        saved.execution !== setup.priorExecution ||
        saved.generation !== setup.batch.priorGeneration ||
        saved.turnId !== setup.batch.priorTurnId ||
        saved.sourceId !== setup.sourceId ||
        saved.sourceHash !== setup.sourceHash ||
        saved.handoffHash !== setup.handoffHash ||
        saved.person !== setup.person ||
        saved.actionHash !== item.actionHash ||
        saved.family !== item.family ||
        saved.flowId !== item.flowId ||
        stableStringify(saved.group) !== stableStringify(item.group) ||
        saved.requestId !== item.requestId ||
        saved.decision.state !== item.state ||
        stableStringify(saved.cardIds) !== stableStringify(ids)
      )
        return false;
      const producer = {
        roomId: saved.roomId,
        memberId: saved.memberId,
        operationId: saved.operationId,
        nodeId: saved.nodeId,
        execution: saved.execution,
        generation: saved.generation,
        turnId: saved.turnId,
        sourceId: saved.sourceId,
        sourceHash: saved.sourceHash,
        ...(saved.handoffHash ? { handoffHash: saved.handoffHash } : {}),
        person: saved.person,
        actionHash: saved.actionHash,
        ...(saved.family ? { family: saved.family } : {}),
      };
      return (
        saved.decision.hash ===
        NodeCrypto.createHash("sha256")
          .update(
            JSON.stringify([
              snapshot.threadId,
              item.cardId,
              item.requestId,
              producer,
              item.state,
              ...(item.flowId ? [item.flowId] : []),
              ...(item.group ? [[item.group.id, item.group.cardIds]] : []),
            ]),
          )
          .digest("hex")
      );
    })
  )
    return false;
  return questions.every((item) => {
    const saved = matching.find((row) => row.id === item.cardId)?.parkedAnswer;
    return (
      saved &&
      saved.cardId === item.cardId &&
      saved.requestId === item.requestId &&
      saved.answer === item.answer &&
      !!item.answer.trim() &&
      saved.person === item.person &&
      item.person === setup.person &&
      !saved.goal &&
      saved.nodeId === setup.nodeId &&
      saved.priorExecution === setup.priorExecution &&
      saved.priorGeneration === setup.batch.priorGeneration &&
      saved.priorTurnId === setup.batch.priorTurnId &&
      saved.sourceMessageId === setup.sourceId &&
      saved.handoffHash === setup.handoffHash &&
      stableStringify(saved.cardIds) ===
        stableStringify(questions.map((question) => question.cardId))
    );
  });
}

export function parkedRoomAnswerOperationId(
  parked: NonNullable<SavedNativeRoomMemberEnrollment["operation"]["parked"]>,
) {
  return (
    parked.nodeId +
    (parked.goal ? "-step-" + parked.goal.step : "") +
    "-answered" +
    (parked.priorExecution === undefined ? "" : "-" + (parked.priorExecution + 1))
  );
}
type NativeRoomBinding = NonNullable<SavedNativeRoomMemberEnrollment["memberBindings"]>[number];

export function ownedNativeRoomProject(
  profileProject: ProjectId | null | undefined,
  binding?: NativeRoomBinding,
  requestedProject?: ProjectId,
) {
  // Room tasks pin a folder. A project override on a separate private bot task does not apply here.
  if (
    !profileProject ||
    (binding?.projectId != null && binding.projectId !== profileProject) ||
    (requestedProject !== undefined && requestedProject !== binding?.projectId)
  )
    return undefined;
  return profileProject;
}
export type ReadSavedNativeRoomMemberEnrollment = (
  botId: string,
  threadId: string,
  turnId: string,
) => Promise<SavedNativeRoomMemberEnrollment | null>;

export function coldNativeRoomThreadId(snapshot: SavedNativeRoomMemberEnrollment) {
  return ThreadId.make(
    "j1-mausbot:room:" + snapshot.groupId + ":" + snapshot.threadId + ":" + snapshot.botId,
  );
}

function roomHandoffChainMatches(
  handoff: NonNullable<SavedNativeRoomMemberEnrollment["operation"]["handoff"]>,
  currentGeneration: string,
) {
  const { chain, chainHash } = handoff;
  if (!chain)
    return (
      chainHash === undefined &&
      handoff.parentId === undefined &&
      handoff.mode === undefined &&
      !handoff.externalConsult
    );
  if (
    !chain.length ||
    new Set([handoff.rootId, ...chain.map((link) => link.nodeId)]).size !== chain.length + 1
  )
    return false;
  let hash: string | undefined;
  const generations = new Set([currentGeneration]);
  const providerTurns = new Set<string>();
  for (const [index, link] of chain.entries()) {
    const parent = chain[index - 1];
    const upstream = link.upstream;
    if (
      (link.reply === "none") !== (link.mode === "notify") ||
      link.since <= 0 ||
      link.since > link.startedAt ||
      !/^[a-f0-9]{64}$/.test(link.assignmentHash) ||
      link.senderId === link.memberId ||
      (parent
        ? !upstream ||
          link.parentId !== parent.nodeId ||
          upstream.nodeId !== parent.nodeId ||
          upstream.startedAt !== parent.startedAt ||
          parent.startedAt > link.since ||
          link.senderId !== parent.memberId ||
          !upstream.generation ||
          !upstream.turnId ||
          upstream.hash !== hash
        : link.parentId !== handoff.rootId ||
          (upstream !== undefined &&
            (!(upstream.result || upstream.resume || upstream.restart?.rootResultHash) ||
              upstream.nodeId !== handoff.rootId ||
              upstream.hash !== handoff.sourceHash ||
              upstream.startedAt !==
                (upstream.result ?? upstream.resume ?? upstream.restart)?.startedAt ||
              !upstream.generation ||
              !upstream.turnId)))
    )
      return false;
    if (upstream) {
      const resume = upstream.resume;
      const restart = upstream.restart;
      const result = upstream.result;
      if (
        Number(Boolean(resume)) + Number(Boolean(restart)) + Number(Boolean(result)) > 1 ||
        (result &&
          (result.execution < 2 ||
            !Number.isSafeInteger(result.execution) ||
            result.startedAt < upstream.startedAt ||
            result.startedAt > link.since ||
            !/^[a-f0-9]{64}$/.test(result.hash))) ||
        (restart &&
          (Boolean(restart.rootResultHash) === Boolean(parent) ||
            restart.restarts < 1 ||
            restart.execution <= restart.restarts ||
            (parent && restart.priorStartedAt < upstream.startedAt) ||
            restart.priorStartedAt > restart.reconciledAt ||
            restart.reconciledAt > restart.startedAt ||
            restart.startedAt > link.since ||
            restart.priorGeneration === upstream.generation ||
            restart.priorTurnId === upstream.turnId)) ||
        generations.has(upstream.generation) ||
        providerTurns.has(upstream.turnId) ||
        (resume &&
          (resume.execution < 2 ||
            !Number.isSafeInteger(resume.execution) ||
            resume.startedAt < upstream.startedAt ||
            resume.startedAt > link.since ||
            !/^[a-f0-9]{64}$/.test(resume.answerHash)))
      )
        return false;
      generations.add(upstream.generation);
      providerTurns.add(upstream.turnId);
    }
    hash = NodeCrypto.createHash("sha256")
      .update(
        JSON.stringify([
          link.nodeId,
          link.parentId,
          link.senderId,
          link.memberId,
          link.groupId,
          link.threadId,
          link.requestId,
          link.rowId,
          link.assignmentHash,
          link.approvalGranted,
          link.reply,
          link.since,
          link.startedAt,
          upstream?.generation,
          upstream?.turnId,
          upstream?.hash,
          ...(link.mode ? [[link.mode]] : []),
          ...(handoff.externalConsult ? [["external", handoff.sourceHash]] : []),
          ...(upstream?.resume
            ? [[upstream.resume.execution, upstream.resume.startedAt, upstream.resume.answerHash]]
            : []),
          ...(upstream?.restart
            ? [
                [
                  "restart",
                  upstream.restart.execution,
                  upstream.restart.restarts,
                  upstream.restart.priorStartedAt,
                  upstream.restart.reconciledAt,
                  upstream.restart.startedAt,
                  upstream.restart.priorGeneration,
                  upstream.restart.priorTurnId,
                  ...(upstream.restart.rootResultHash ? [upstream.restart.rootResultHash] : []),
                ],
              ]
            : []),
          ...(upstream?.result
            ? [
                [
                  "result",
                  upstream.result.execution,
                  upstream.result.startedAt,
                  upstream.result.hash,
                ],
              ]
            : []),
        ]),
      )
      .digest("hex");
  }
  const last = chain.at(-1);
  return (
    hash === chainHash &&
    last?.nodeId === handoff.nodeId &&
    last.parentId === handoff.parentId &&
    last.senderId === handoff.senderId &&
    last.memberId === handoff.memberId &&
    last.groupId === handoff.groupId &&
    last.threadId === handoff.threadId &&
    last.requestId === handoff.requestId &&
    last.rowId === handoff.rowId &&
    last.assignmentHash === handoff.assignmentHash &&
    last.approvalGranted === handoff.approvalGranted &&
    last.reply === handoff.reply &&
    last.mode === handoff.mode &&
    last.since === handoff.since
  );
}

export function roomHandoffMatches(
  snapshot: Pick<
    SavedNativeRoomMemberEnrollment,
    "botId" | "groupId" | "threadId" | "operation" | "rows"
  >,
) {
  const { operation, rows } = snapshot;
  const handoff = operation.handoff;
  const parked = operation.parked;
  const restart = operation.childRestart;
  const resultWake = operation.parentResultWake;
  if (
    !handoff ||
    !roomHandoffChainMatches(handoff, operation.generation) ||
    operation.kind !== "handoff" ||
    operation.goal ||
    operation.requestId !== handoff.rowId ||
    operation.queuedIds.length ||
    (parked
      ? !parked.handoffHash ||
        parked.handoffHash !== handoff.chainHash ||
        parked.goal ||
        parked.nodeId !== handoff.nodeId ||
        parked.sourceMessageId !== handoff.rowId ||
        operation.sourceRowIds.length !== 0 ||
        operation.id !== parkedRoomAnswerOperationId(parked)
      : operation.setup
        ? operation.setup.handoffHash !== handoff.chainHash ||
          operation.setup.nodeId !== handoff.nodeId ||
          operation.setup.sourceId !== handoff.rowId ||
          operation.setup.person !== handoff.person ||
          operation.sourceRowIds.length !== 0 ||
          operation.id !== roomSetupBatchOperationId(operation.setup)
        : resultWake
          ? resultWake.root ||
            !handoff.chainHash ||
            resultWake.priorGeneration === operation.generation ||
            !validParentResultWake(resultWake, handoff.nodeId) ||
            operation.sourceRowIds.length !== 0 ||
            operation.id !== handoff.nodeId + "-results-" + resultWake.execution
          : restart
            ? !handoff.chainHash ||
              restart.rootResultHash ||
              restart.execution <= restart.restarts ||
              restart.priorGeneration === operation.generation ||
              restart.priorStartedAt > restart.reconciledAt ||
              restart.reconciledAt > restart.startedAt ||
              operation.sourceRowIds.length !== 0 ||
              operation.id !== handoff.nodeId + "-restart-" + restart.execution
            : operation.id !== handoff.nodeId ||
              operation.sourceRowIds.length !== 1 ||
              operation.sourceRowIds[0] !== handoff.rowId) ||
    (restart && parked) ||
    (resultWake && (restart || parked)) ||
    (handoff.mode === "consult"
      ? !handoff.consultationText || !!(parked || operation.setup || restart || resultWake)
      : handoff.consultationText !== undefined) ||
    (handoff.reply === "none") !== (handoff.mode === "notify") ||
    handoff.rootId === handoff.nodeId ||
    handoff.senderId === handoff.memberId ||
    handoff.memberId !== snapshot.botId ||
    handoff.groupId !== snapshot.groupId ||
    handoff.threadId !== snapshot.threadId ||
    (handoff.externalConsult
      ? handoff.mode !== "consult" ||
        handoff.reply !== "poll" ||
        handoff.person !== "" ||
        handoff.sourceMessageId !== handoff.rootId ||
        handoff.chain?.length !== 1 ||
        operation.handedFor !== undefined
      : !/^p_[\w-]{22}$/.test(handoff.person) ||
        stableStringify(operation.handedFor) !==
          stableStringify({ person: handoff.person, since: handoff.since })) ||
    handoff.since <= 0 ||
    !/^[a-f0-9]{64}$/.test(handoff.sourceHash) ||
    !handoff.assignment.trim() ||
    handoff.assignment.length > 12_000 ||
    NodeCrypto.createHash("sha256").update(handoff.assignment).digest("hex") !==
      handoff.assignmentHash
  )
    return false;
  const assigned = rows.filter((row) => row.id === handoff.rowId);
  const row = assigned[0];
  return (
    assigned.length === 1 &&
    row?.role === "bot" &&
    row.kind === "text" &&
    row.text === handoff.displayText &&
    row.text.endsWith(" " + handoff.assignment) &&
    row.provenance.authority === (handoff.mode === "consult" ? "information" : "on-behalf") &&
    !row.provenance.sender &&
    !row.attachments?.length &&
    (row.provenance.from as { botId?: string } | undefined)?.botId === handoff.senderId &&
    stableStringify(row.provenance.roomRequest) ===
      stableStringify({ id: handoff.requestId, phase: "request" }) &&
    stableStringify(row.provenance.handed) ===
      stableStringify(handoff.mode === "consult" ? undefined : operation.handedFor)
  );
}

export function validParentResultWake(wake: MausbotParentResultWake, parentId: string) {
  return (
    wake.execution >= 2 &&
    (wake.restarts ?? 0) < wake.execution &&
    wake.priorStartedAt > 0 &&
    wake.priorStartedAt <= wake.cutAt &&
    wake.cutAt <= wake.startedAt &&
    wake.reports.length > 0 &&
    new Set(wake.reports.map((row) => row.childId)).size === wake.reports.length &&
    new Set(wake.reports.map((row) => row.inboxId)).size === wake.reports.length &&
    wake.reports.every(
      (row) =>
        row.childId !== parentId &&
        row.execution >= 1 &&
        row.finishedAt > 0 &&
        row.finishedAt <= row.reportedAt &&
        row.reportedAt <= wake.startedAt &&
        row.report.trim() &&
        NodeCrypto.createHash("sha256").update(row.report).digest("hex") === row.resultHash,
    )
  );
}

export function rootRoomResultWakeMatches(snapshot: SavedNativeRoomMemberEnrollment) {
  const { operation } = snapshot;
  const wake = operation.parentResultWake;
  const root = wake?.root;
  const row = root && snapshot.rows.find((row) => row.id === root.sourceMessageId);
  return Boolean(
    wake &&
    root &&
    operation.kind === "orchestration" &&
    !operation.handoff &&
    !operation.handedFor &&
    !operation.goal &&
    !operation.parked &&
    !operation.childRestart &&
    !operation.queuedIds.length &&
    !operation.sourceRowIds.length &&
    row &&
    isOwnRoomRequest(row) &&
    (row.provenance.sender as { id?: string } | undefined)?.id === root.person &&
    operation.requestId === row.id &&
    operation.id.endsWith("-results-" + wake.execution) &&
    wake.priorGeneration !== operation.generation &&
    wake.priorTurnId !== snapshot.turnId &&
    validParentResultWake(wake, operation.id.slice(0, -("-results-" + wake.execution).length)),
  );
}

export function rootRoomRestartMatches(snapshot: SavedNativeRoomMemberEnrollment) {
  const { operation } = snapshot;
  const restart = operation.childRestart;
  const rows = snapshot.rows.filter((row) => row.id === operation.requestId);
  const row = rows[0];
  return Boolean(
    restart?.rootResultHash &&
    restart.execution > restart.restarts &&
    restart.priorStartedAt <= restart.reconciledAt &&
    restart.reconciledAt <= restart.startedAt &&
    restart.priorGeneration !== operation.generation &&
    restart.priorTurnId !== snapshot.turnId &&
    operation.kind === "orchestration" &&
    !operation.handoff &&
    !operation.handedFor &&
    !operation.goal &&
    !operation.parked &&
    !operation.parentResultWake &&
    !operation.queuedIds.length &&
    !operation.sourceRowIds.length &&
    operation.id.endsWith("-restart-" + restart.execution) &&
    rows.length === 1 &&
    row &&
    isOwnRoomRequest(row),
  );
}

export function validateColdNativeRoomTurn(
  snapshot: SavedNativeRoomMemberEnrollment,
  input: {
    botId: string;
    threadId: string;
    turnId: string;
    instanceId: string;
    model: string;
    variant?: string;
    effort?: string;
    cwd: string;
    approvalMode: string;
    restrictedTools: boolean;
  },
) {
  const { operation, enrollment } = snapshot;
  const bound = snapshot.memberBindings?.find((member) => member.memberId === snapshot.botId);
  const source = new Set(operation.sourceRowIds);
  const currentRows = snapshot.rows.filter((row) => source.has(row.id));
  const goal = operation.goal;
  const parked = operation.parked;
  const parkedSource = parked && snapshot.rows.find((row) => row.id === parked.sourceMessageId);
  const validHandoff = Boolean(bound) && roomHandoffMatches(snapshot);
  const validParked =
    parked &&
    parkedSource &&
    (parked.goal
      ? operation.kind === "goal" &&
        goal &&
        parked.cardIds &&
        parked.priorExecution !== undefined &&
        parked.goal.runId === goal.runId &&
        parked.goal.cardId === goal.cardMessageId &&
        parked.goal.step === goal.turnCount &&
        parked.goal.memberId === snapshot.botId &&
        parked.goal.coordinator === (goal.turnCount % 2 === 1)
      : parked.handoffHash
        ? validHandoff && Boolean(parked.cardIds && parked.priorExecution)
        : operation.kind === "card" && !goal) &&
    parkedRoomCardsMatch(parked, snapshot.rows) &&
    parked.priorTurnId !== snapshot.turnId &&
    (parked.priorGeneration ?? parked.nodeId) !== operation.generation &&
    operation.id === parkedRoomAnswerOperationId(parked) &&
    operation.requestId === parked.sourceMessageId &&
    !operation.sourceRowIds.length &&
    !operation.queuedIds.length &&
    (parked.handoffHash
      ? parkedSource.role === "bot" && parkedSource.provenance.authority === "on-behalf"
      : isOwnRoomRequest(parkedSource)) &&
    parkedRoomAnswers(parked).every((answer) => {
      const row = snapshot.rows.find((card) => card.id === answer.cardId);
      return (
        row?.role === "bot" &&
        row.kind === "options" &&
        (row.provenance.from as { botId?: string } | undefined)?.botId === snapshot.botId
      );
    });
  const goalCard = goal && snapshot.rows.find((row) => row.id === goal.cardMessageId);
  const goalRequest = goal && snapshot.rows.find((row) => row.id === goal.requestId);
  const next = goal?.continuation;
  const validGoal =
    operation.kind === "goal" &&
    goal &&
    goalCard &&
    goalRequest &&
    operation.queuedIds.length === 0 &&
    (next
      ? goal.turnCount > 1 &&
        goal.turnCount <= 13 &&
        operation.sourceRowIds.length === 0 &&
        next.itemIds.length > 0 &&
        new Set(next.itemIds).size === next.itemIds.length &&
        (next.targetMemberId ?? goal.coordinatorBotId) === snapshot.botId &&
        (!next.fromMemberId || snapshot.roster.includes(next.fromMemberId)) &&
        (next.coordinator
          ? (next.fromMemberId ?? goal.coordinatorBotId) === goal.coordinatorBotId
          : snapshot.botId === goal.coordinatorBotId) &&
        next.previousTurnId !== snapshot.turnId &&
        Boolean(next.assignment.trim()) &&
        Boolean(next.reply.trim())
      : goal.turnCount === 1 &&
        goal.coordinatorBotId === snapshot.botId &&
        (parked
          ? Boolean(validParked)
          : currentRows.length === 1 && currentRows[0] === goalRequest)) &&
    operation.requestId === goal.requestId &&
    snapshot.roster.includes(goal.coordinatorBotId) &&
    goalCard.role === "bot" &&
    goalCard.kind === "goal.run" &&
    (goalCard.provenance.from as { botId?: string } | undefined)?.botId === goal.coordinatorBotId &&
    goalCard.at >= goal.startedAt &&
    goal.startedAt >= goalRequest.at &&
    isOwnRoomRequest(goalRequest) &&
    goalRequest.provenance.channelMode === "goal" &&
    goalRequest.text === goal.goal &&
    Boolean(goal.goal.trim()) &&
    Boolean((goalRequest.provenance.sender as { id?: string } | undefined)?.id);
  const rootWake = rootRoomResultWakeMatches(snapshot);
  const rootRestart = Boolean(bound) && rootRoomRestartMatches(snapshot);
  const validSetup = operation.setup && roomSetupBatchMatches(snapshot);
  const supported =
    validSetup ||
    rootWake ||
    rootRestart ||
    (validHandoff && !parked) ||
    (operation.kind === "chat" && !goal && !parked) ||
    (!parked && validGoal) ||
    (validParked && (!goal || validGoal));
  if (
    (operation.setup && !validSetup) ||
    (operation.childRestart &&
      ((!validHandoff && !rootRestart) ||
        operation.childRestart.priorTurnId === snapshot.turnId)) ||
    (operation.parentResultWake &&
      ((!validHandoff && !rootWake) ||
        operation.parentResultWake.priorTurnId === snapshot.turnId)) ||
    snapshot.botId !== input.botId ||
    snapshot.threadId !== input.threadId ||
    snapshot.turnId !== input.turnId ||
    !snapshot.roster.includes(input.botId) ||
    !supported ||
    ((operation.handedFor || operation.handoff) && !validHandoff) ||
    !operation.requestId ||
    (!next &&
      !validParked &&
      !validSetup &&
      !operation.childRestart &&
      !operation.parentResultWake &&
      (!source.has(operation.requestId) || !currentRows.length)) ||
    currentRows.length !== source.size ||
    (!validHandoff &&
      currentRows.some(
        (row) =>
          !isOwnRoomRequest(row) ||
          (row.provenance.channelMode === "goal") !== Boolean(validGoal) ||
          !row.text?.trim() ||
          JSON.stringify(row.provenance.sender) !==
            JSON.stringify(currentRows[0]?.provenance.sender),
      )) ||
    !NodePath.isAbsolute(input.cwd) ||
    !NodePath.isAbsolute(enrollment.workspace) ||
    !samePath(input.cwd, enrollment.workspace) ||
    enrollment.selection.instanceId !== input.instanceId ||
    enrollment.selection.model !== input.model ||
    enrollment.variant !== input.variant ||
    (snapshot.memberBindings !== undefined &&
      (!bound ||
        !samePath(bound.workspace, input.cwd) ||
        bound.selection.instanceId !== input.instanceId ||
        bound.selection.model !== input.model ||
        bound.variant !== input.variant ||
        bound.effort !== input.effort ||
        bound.approvalMode !== input.approvalMode ||
        bound.restrictedTools !== input.restrictedTools)) ||
    enrollment.approvalMode !== input.approvalMode ||
    enrollment.restrictedTools !== input.restrictedTools
  ) {
    throw new Error(
      "The saved room operation is not an owned cold person chat or first person goal step under the current policy.",
    );
  }
  return {
    threadId: coldNativeRoomThreadId(snapshot),
    currentRows,
    goal: validGoal ? goal : undefined,
    parked: validParked ? parked : undefined,
    setup: validSetup ? operation.setup : undefined,
    handoff: validHandoff ? operation.handoff : undefined,
    childRestart: validHandoff || rootRestart ? operation.childRestart : undefined,
    parentResultWake: validHandoff || rootWake ? operation.parentResultWake : undefined,
    historicalRows: snapshot.rows.filter((row) => !source.has(row.id)),
    instructionsBeforeHistory: operation.instructionsBeforeHistory,
    historicalInstructionText: operation.historicalInstructionText,
    instructionsAfterHistory: operation.instructionsAfterHistory,
  };
}

export function roomProviderSystem(
  system: string,
  goal: SavedNativeRoomMemberEnrollment["operation"]["goal"],
  answering = false,
) {
  if (!goal) return system;
  const start = system.indexOf(goal.instructions);
  const marker = "\nGoal: " + goal.goal + "\n";
  const goalAt = goal.instructions.indexOf(marker);
  if (
    start < 0 ||
    system.indexOf(goal.instructions, start + 1) !== -1 ||
    goalAt < 0 ||
    goal.instructions.indexOf(marker, goalAt + 1) !== -1
  ) {
    throw new Error("The native room goal instructions no longer match the current operation.");
  }
  if (answering) return system.slice(0, start) + system.slice(start + goal.instructions.length);
  const replacement = goal.continuation
    ? "\nGoal: Continue the saved room goal."
    : "\nGoal: See the current room request.";
  let instructions =
    goal.instructions.slice(0, goalAt) +
    replacement +
    goal.instructions.slice(goalAt + marker.length - 1);
  if (goal.continuation?.coordinator) {
    const assignment = "\nYour assignment: " + goal.continuation.assignment + "\n";
    const assignmentAt = instructions.indexOf(assignment);
    if (assignmentAt < 0 || instructions.indexOf(assignment, assignmentAt + 1) !== -1)
      throw new Error("The native room assignment no longer matches the current operation.");
    instructions =
      instructions.slice(0, assignmentAt) +
      "\nYour assignment: See the current coordinator assignment.\n" +
      instructions.slice(assignmentAt + assignment.length);
  }
  return system.slice(0, start) + instructions + system.slice(start + goal.instructions.length);
}
const decodeRoom = Schema.decodeUnknownSync(Schema.NullOr(NativeRoomMemberEnrollment));

export function readNativeRoomMemberEnrollment(
  value: unknown,
  botId: string,
  threadId: string,
  turnId: string,
) {
  const snapshot = decodeRoom(value);
  if (snapshot === null) return null;
  const { rows, operation, roster } = snapshot;
  const bindings = snapshot.memberBindings;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const queue = new Set(operation.queuedIds);
  const queuedRows = rows.filter(
    (row) => row.provenance.queueId && queue.has(row.provenance.queueId),
  );
  if (
    snapshot.botId !== botId ||
    snapshot.threadId !== threadId ||
    snapshot.turnId !== turnId ||
    !roster.includes(botId) ||
    new Set(roster).size !== roster.length ||
    byId.size !== rows.length ||
    (bindings &&
      (new Set(bindings.map((binding) => binding.memberId)).size !== bindings.length ||
        bindings.some((binding) => !roster.includes(binding.memberId)))) ||
    new Set(operation.sourceRowIds).size !== operation.sourceRowIds.length ||
    operation.sourceRowIds.some((id) => !byId.has(id)) ||
    (operation.requestId &&
      (!byId.has(operation.requestId) ||
        (!operation.parked &&
          !operation.setup &&
          !operation.childRestart &&
          !operation.parentResultWake &&
          !operation.goal?.continuation &&
          !operation.sourceRowIds.includes(operation.requestId)))) ||
    operation.renderedWindowIds.some((id) => !byId.has(id)) ||
    queue.size !== operation.queuedIds.length ||
    queuedRows.length !== queue.size ||
    (queue.size > 0 && operation.sourceRowIds.length !== queue.size) ||
    queuedRows.some(
      (row, index) =>
        row.id !== operation.sourceRowIds[index] ||
        row.provenance.queueId !== operation.queuedIds[index],
    ) ||
    rows.some((row) => row.turnCompletedAt !== undefined && row.turnCompletedAt < row.at)
  ) {
    throw new Error(
      "The native room snapshot does not own this member turn or its saved row order.",
    );
  }
  return snapshot;
}

const Profile = Schema.Struct({
  botId: NativeId,
  threadId: NativeId,
  name: BotName,
  description: Schema.String.check(Schema.isMaxLength(500)),
  instructions: BotInstructions,
  projectId: Schema.NullOr(ProjectId),
  threadProjectId: Schema.NullOr(ProjectId),
  modelSelection: ModelSelection,
  threadSelection: ModelSelection,
  defaultVariant: Schema.optionalKey(Schema.String),
  threadVariant: Schema.optionalKey(Schema.String),
  approvalMode: Schema.Literals(["ask", "edits", "auto", "full"]),
  restrictedTools: Schema.Boolean,
});
const Message = Schema.Struct({
  nativeMessageId: NativeId,
  mirrorMessageId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  ),
  createdAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
});
const NativeAssignmentOrigin = Schema.Struct({
  root: Schema.optionalKey(Schema.Literal(true)),
  nodeId: NativeId,
  requestId: NativeId,
  execution: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  dispatch: Schema.Literals(["first", "resume", "rerun", "computer"]),
  computerSelection: Schema.optionalKey(MausbotComputerSelection),
  incidentBatch: Schema.optionalKey(MausbotIncidentBatch),
  consultation: Schema.optionalKey(MausbotConsultation),
  parkedStatus: Schema.optionalKey(MausbotParkedStatus),
  privateHandoffHash: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
  privateHandoffGeneration: Schema.optionalKey(NativeId),
  privateAnswers: Schema.optionalKey(MausbotPrivateAnswers),
  childRestart: Schema.optionalKey(MausbotChildRestart),
  parentResultWake: Schema.optionalKey(MausbotParentResultWake),
  restarts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sourceMessageId: NativeId,
  approvalMode: Profile.fields.approvalMode,
  restrictedTools: Schema.Boolean,
});
const CurrentTurn = Schema.Struct({
  turnId: NativeId,
  anchorMessageId: NativeId,
  authoredInputText: Schema.optionalKey(Schema.String),
  origin: Schema.optionalKey(NativeAssignmentOrigin),
  promptText: Schema.String,
});
const NativeAttachment = Schema.Struct({
  root: Schema.optionalKey(Schema.Literals(["managed", "workspace", "bot"])),
  filename: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  mime: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  type: Schema.Literals(["image", "file"]),
});
const NativeSource = Schema.Struct({
  ...Profile.fields,
  nativeHistory: Schema.optionalKey(
    Schema.Struct({
      ...CurrentTurn.fields,
      workspaceRoot: Schema.optionalKey(Schema.NullOr(Schema.String)),
      promptAttachments: Schema.Array(NativeAttachment),
      authoredSource: Schema.optionalKey(
        Schema.Struct({ ...Message.fields, attachments: Schema.Array(NativeAttachment) }),
      ),
      messages: Schema.Array(
        Schema.Struct({
          ...Message.fields,
          attachments: Schema.Array(NativeAttachment),
        }),
      ),
    }),
  ),
});
const SavedNativeBotEnrollment = Schema.Struct({
  ...Profile.fields,
  savedResumeCursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
  savedIncidentFailure: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
  savedIncidentNote: Schema.optionalKey(MausbotIncidentRetryNote),
  coldHistory: Schema.optionalKey(
    Schema.Struct({
      ...CurrentTurn.fields,
      workspaceRoot: Schema.optionalKey(Schema.NullOr(Schema.String)),
      promptAttachments: Schema.Array(ChatAttachment),
      authoredSource: Schema.optionalKey(
        Schema.Struct({ ...Message.fields, attachments: Schema.Array(ChatAttachment) }),
      ),
      messages: Schema.Array(
        Schema.Struct({
          ...Message.fields,
          attachments: Schema.Array(ChatAttachment),
        }),
      ),
    }),
  ),
});
export type SavedNativeBotEnrollment = typeof SavedNativeBotEnrollment.Type;

export interface SavedNativeHistoryRequest {
  readonly turnId: string;
  readonly attachmentsDir: string;
  readonly workspace?: {
    readonly projectId: ProjectId;
    readonly root: string;
  };
}

export interface SavedNativeResumeRequest {
  readonly resumeTurnId: string;
}

export type ReadSavedNativeBotEnrollment = (
  botId: string,
  threadId: string,
  request?: SavedNativeHistoryRequest | SavedNativeResumeRequest,
) => Promise<SavedNativeBotEnrollment | null>;

const decodeResume = Schema.decodeUnknownSync(
  Schema.NullOr(
    Schema.Struct({
      ...Profile.fields,
      savedResumeCursor: Schema.String.check(Schema.isMaxLength(4096)),
      savedIncidentFailure: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
      savedIncidentNote: Schema.optionalKey(MausbotIncidentRetryNote),
    }),
  ),
);

const decode = Schema.decodeUnknownSync(Schema.NullOr(Profile));
const decodeNative = Schema.decodeUnknownSync(Schema.NullOr(NativeSource));
const decodeAttachment = Schema.decodeUnknownSync(ChatAttachment);

function assertOwner(
  snapshot: { readonly botId: string; readonly threadId: string },
  expectedBotId: string,
  expectedThreadId: string,
) {
  if (snapshot.botId !== expectedBotId || snapshot.threadId !== expectedThreadId) {
    throw new Error("The saved native bot or thread does not match its requested owner.");
  }
}

export function readNativeBotEnrollmentSnapshot(
  raw: unknown,
  expectedBotId: string,
  expectedThreadId: string,
  resume = false,
): SavedNativeBotEnrollment | null {
  const snapshot = (resume ? decodeResume : decode)(raw, { onExcessProperty: "error" });
  if (snapshot) assertOwner(snapshot, expectedBotId, expectedThreadId);
  return snapshot;
}

const sameFile = (left: NodeFS.BigIntStats, right: NodeFS.BigIntStats) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

const samePath = (left: string, right: string) => NodePath.relative(left, right) === "";
const inSecretFolder = (path: string) =>
  path.split(/[\\\\/]/u).some((part) => part.toLowerCase() === ".openmausbot-secrets");

function attachmentSegments(filename: string, managed: boolean): ReadonlyArray<string> {
  const parts = filename.split("/");
  if (
    (managed && parts.length !== 1) ||
    parts.some(
      (part) =>
        !part ||
        part.length > 255 ||
        part === "." ||
        part === ".." ||
        part.endsWith(".") ||
        part.endsWith(" ") ||
        /[\\\\:*?"<>|\u0000-\u001f]/u.test(part) ||
        /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu.test(
          part,
        ),
    )
  ) {
    throw new Error("Invalid saved native attachment name.");
  }
  return parts;
}

async function readScopedAttachment(
  root: string,
  parts: ReadonlyArray<string>,
  limit: number,
  current: () => boolean,
  allowScopedAlias = false,
): Promise<Buffer> {
  if (!NodePath.isAbsolute(root) || inSecretFolder(NodePath.join(root, ...parts))) {
    throw new Error("The saved native attachment is outside its file scope.");
  }
  const canonicalRoot = await NodeFSP.realpath(root);
  const originalRoot = await NodeFSP.lstat(root, { bigint: true });
  const source = NodePath.join(root, ...parts);
  const changed = () => new Error("The saved native attachment changed or escaped its file scope.");
  const inspect = async () => {
    const rootNow = await NodeFSP.lstat(root, { bigint: true });
    if (
      !rootNow.isDirectory() ||
      !samePath(root, canonicalRoot) ||
      !samePath(await NodeFSP.realpath(root), canonicalRoot) ||
      originalRoot.dev !== rootNow.dev ||
      originalRoot.ino !== rootNow.ino
    )
      throw changed();
    const canonical = await NodeFSP.realpath(source);
    const relative = NodePath.relative(canonicalRoot, canonical);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(".." + NodePath.sep) ||
      NodePath.isAbsolute(relative) ||
      inSecretFolder(canonical) ||
      (!allowScopedAlias && !samePath(source, canonical))
    )
      throw changed();
    const stat = await NodeFSP.lstat(canonical, { bigint: true });
    if (!stat.isFile()) throw changed();
    return { canonical, stat };
  };
  const baseline = await inspect();
  if (baseline.stat.size < 1n || baseline.stat.size > BigInt(limit)) {
    throw new Error("The saved native attachment is empty or exceeds its limit.");
  }
  if (!current()) throw new Error("The native history owner disconnected.");
  const file = await NodeFSP.open(
    baseline.canonical,
    NodeFS.constants.O_RDONLY |
      (NodeFS.constants.O_NOFOLLOW ?? 0) |
      (NodeFS.constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await file.stat({ bigint: true });
    const stillSamePath = async () => {
      const verified = await inspect();
      return samePath(baseline.canonical, verified.canonical) && sameFile(opened, verified.stat);
    };
    if (!opened.isFile() || !sameFile(baseline.stat, opened) || !(await stillSamePath()))
      throw changed();
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      if (!current()) throw new Error("The native history owner disconnected.");
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (
      offset !== bytes.length ||
      !sameFile(opened, await file.stat({ bigint: true })) ||
      !(await stillSamePath())
    )
      throw changed();
    return bytes;
  } finally {
    await file.close();
  }
}

async function stageOwnedNativeAttachment(input: {
  item: { type: "image" | "file"; mime: string; name: string };
  root: string;
  parts: ReadonlyArray<string>;
  kind: "managed" | "workspace" | "bot";
  messageId: string;
  index: number;
  j1ThreadId: ThreadId;
  attachmentsDir: string;
  current: () => boolean;
}) {
  const { item, root, parts, kind, messageId, index, j1ThreadId, attachmentsDir, current } = input;
  const limit =
    item.type === "image" ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
  const bytes = await readScopedAttachment(root, parts, limit, current, kind !== "managed");
  const mimeType = item.mime.split(";")[0]!.trim().toLowerCase();
  if (item.type === "image" && !matchesImageSignature(mimeType, bytes)) {
    throw new Error("The saved native image has invalid content.");
  }
  const id = createDeterministicAttachmentId(
    j1ThreadId,
    chatAttachmentStableKey(
      kind === "managed" ? messageId : JSON.stringify([messageId, kind, root, parts]),
      index,
      bytes,
    ),
  );
  if (!id || !current()) throw new Error("Could not stage the saved native attachment.");
  const attachment = decodeAttachment({
    type: item.type,
    id,
    name: item.name,
    mimeType,
    sizeBytes: bytes.length,
  });
  const destination = resolveAttachmentPath({ attachmentsDir, attachment });
  if (!destination) throw new Error("Invalid J1 destination for saved history.");
  await NodeFSP.mkdir(attachmentsDir, { recursive: true });
  const temp = destination + "." + NodeCrypto.randomUUID() + ".part";
  await NodeFSP.writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
  try {
    if (!current()) throw new Error("The native history owner disconnected.");
    await NodeFSP.link(temp, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readScopedAttachment(
      attachmentsDir,
      [NodePath.basename(destination)],
      bytes.length,
      current,
    );
    if (!existing.equals(bytes)) {
      throw new Error("A saved attachment staging ID belongs to different content.");
    }
  } finally {
    await NodeFSP.unlink(temp);
  }
  return attachment;
}

export type StageSavedColdRoomTurn = (
  input: Parameters<typeof validateColdNativeRoomTurn>[1] & {
    attachmentsDir: string;
    current: () => boolean;
    previousRoomSnapshot?: string;
  },
) => Promise<Awaited<ReturnType<typeof stageColdNativeRoomAttachments>> | null>;

export async function stageColdNativeRoomAttachments(
  snapshot: SavedNativeRoomMemberEnrollment,
  sourceDir: string,
  attachmentsDir: string,
  j1ThreadId: ThreadId,
  current: () => boolean,
  previousRoomSnapshot?: string,
) {
  const validHandoff = roomHandoffMatches(snapshot);
  if (
    (!validHandoff &&
      !rootRoomResultWakeMatches(snapshot) &&
      !rootRoomRestartMatches(snapshot) &&
      snapshot.operation.kind !== "chat" &&
      snapshot.operation.kind !== "goal" &&
      !(
        snapshot.operation.kind === "card" &&
        (snapshot.operation.parked || snapshot.operation.setup)
      )) ||
    (snapshot.operation.setup && !roomSetupBatchMatches(snapshot)) ||
    ((snapshot.operation.handedFor || snapshot.operation.handoff) && !validHandoff) ||
    (!snapshot.operation.parked &&
      !snapshot.operation.setup &&
      !snapshot.operation.childRestart &&
      !snapshot.operation.parentResultWake &&
      !snapshot.operation.goal?.continuation &&
      !snapshot.operation.sourceRowIds.length) ||
    j1ThreadId !== coldNativeRoomThreadId(snapshot)
  )
    throw new Error("The room operation is not an owned cold chat.");
  const reference = (path: string) => {
    const prefix = "/api/attachments/";
    if (!path.startsWith(prefix))
      throw new Error("The saved room attachment is outside managed room storage.");
    return attachmentSegments(path.slice(prefix.length), true);
  };
  const previous =
    previousRoomSnapshot === undefined
      ? []
      : (
          JSON.parse(previousRoomSnapshot) as {
            rows: Array<
              SavedNativeRoomMemberEnrollment["rows"][number] & {
                stagedAttachments: ChatAttachment[];
              }
            >;
          }
        ).rows;
  const oldRows = new Map(previous.map((row) => [row.id, row]));
  const rows = [];
  for (const row of snapshot.rows) {
    for (const original of row.attachments ?? []) reference(original.path);
  }
  for (const row of snapshot.rows) {
    if (!current()) throw new Error("The native room turn no longer owns this file staging.");
    const old = oldRows.get(row.id);
    if (old) {
      const { stagedAttachments, ...saved } = old;
      // A local person's old request can lose its active claim without changing the saved row.
      const priorOwnRequest =
        saved.provenance.authority === "own" &&
        row.provenance.authority === "information" &&
        !saved.provenance.sender &&
        !row.provenance.sender &&
        !snapshot.operation.sourceRowIds.includes(row.id);
      const verified = priorOwnRequest
        ? { ...row, provenance: { ...row.provenance, authority: "own" as const } }
        : row;
      if (stableStringify(saved) !== stableStringify(verified))
        throw new Error("The saved room history changed before file staging.");
      rows.push({ ...verified, stagedAttachments });
      continue;
    }
    const stagedAttachments = [];
    for (const [index, original] of (row.attachments ?? []).entries()) {
      const parts = reference(original.path);
      const item = {
        type: original.kind === "image" ? ("image" as const) : ("file" as const),
        name: original.name ?? parts[0]!,
        mime: original.mime,
      };
      stagedAttachments.push(
        await stageOwnedNativeAttachment({
          item,
          root: sourceDir,
          parts,
          kind: "managed",
          messageId: row.id,
          index,
          j1ThreadId,
          attachmentsDir,
          current,
        }),
      );
    }
    rows.push({ ...row, stagedAttachments });
  }
  if (!current()) throw new Error("The native room turn no longer owns this file staging.");
  return { ...snapshot, rows };
}

export async function stageNativeBotEnrollment(
  raw: unknown,
  expectedBotId: string,
  expectedThreadId: string,
  sourceDir: string,
  request: SavedNativeHistoryRequest,
  current: () => boolean,
): Promise<SavedNativeBotEnrollment | null> {
  const snapshot = decodeNative(raw, { onExcessProperty: "error" });
  if (!snapshot) return null;
  assertOwner(snapshot, expectedBotId, expectedThreadId);
  const { nativeHistory, ...profile } = snapshot;
  if (!nativeHistory || nativeHistory.turnId !== request.turnId || !current()) {
    throw new Error("The native history is unavailable for this turn.");
  }
  const validTimestamp = (value: string) => {
    const millis = Date.parse(value);
    return Number.isFinite(millis) && DateTime.formatIso(DateTime.makeUnsafe(millis)) === value;
  };
  const origin = nativeHistory.origin;
  const authoredSource = nativeHistory.authoredSource;
  const authoredRoot = origin?.root === true && origin.dispatch === "first";
  if (
    authoredRoot !== (nativeHistory.authoredInputText !== undefined) ||
    authoredRoot !== Boolean(authoredSource) ||
    (authoredSource &&
      (authoredSource.nativeMessageId !== nativeHistory.anchorMessageId ||
        authoredSource.role !== "user" ||
        authoredSource.mirrorMessageId !== undefined ||
        !validTimestamp(authoredSource.createdAt) ||
        (authoredSource.completedAt !== null &&
          (!validTimestamp(authoredSource.completedAt) ||
            Date.parse(authoredSource.completedAt) < Date.parse(authoredSource.createdAt))) ||
        JSON.stringify(authoredSource.attachments) !==
          JSON.stringify(nativeHistory.promptAttachments)))
  ) {
    throw new Error("The native coordinator root does not own the authored input.");
  }
  const computer = origin?.computerSelection;
  const incident = origin?.incidentBatch;
  const consultation = origin?.consultation;
  if (
    consultation &&
    (!origin?.privateHandoffHash ||
      origin.root ||
      origin.dispatch !== "first" ||
      origin.execution !== 1 ||
      origin.restarts !== 0 ||
      origin.privateAnswers ||
      origin.childRestart ||
      origin.parentResultWake ||
      incident ||
      computer ||
      !consultation.brief.trim() ||
      consultation.envelopeHash !==
        NodeCrypto.createHash("sha256").update(nativeHistory.promptText).digest("hex"))
  )
    throw new Error("The consultation does not match the current native envelope.");
  const privateAnswers = origin?.privateAnswers;
  const childRestart = origin?.childRestart;
  const resultWake = origin?.parentResultWake;
  const parkedStatus = origin?.parkedStatus;
  if (
    parkedStatus &&
    (!origin ||
      (!origin.root && !origin.privateHandoffHash) ||
      !origin.privateHandoffGeneration ||
      !privateSetupReviewMatches(
        parkedStatus,
        origin.nodeId,
        origin.sourceMessageId,
        origin.privateHandoffHash,
      ) ||
      origin.dispatch !== "resume" ||
      origin.execution < 2 ||
      origin.restarts >= origin.execution ||
      parkedStatus.priorGeneration === origin.privateHandoffGeneration ||
      parkedStatus.priorTurnId === nativeHistory.turnId ||
      incident ||
      computer ||
      privateAnswers ||
      childRestart ||
      resultWake ||
      consultation)
  )
    throw new Error("The setup status does not match the current native continuation.");
  const rootContinuation =
    origin?.root && Boolean(resultWake || privateAnswers || childRestart || parkedStatus);
  if (
    (rootContinuation &&
      origin &&
      (!origin.privateHandoffGeneration ||
        incident ||
        computer ||
        origin.dispatch !== (childRestart ? "rerun" : "resume") ||
        origin.execution < 2 ||
        origin.restarts >= origin.execution ||
        !nativeHistory.messages.some(
          (row) =>
            row.nativeMessageId === origin.sourceMessageId &&
            row.role === "user" &&
            !row.mirrorMessageId,
        ))) ||
    (resultWake &&
      ((!origin?.privateHandoffHash && !origin?.root) ||
        Boolean(origin.root) !== Boolean(resultWake.root) ||
        (resultWake.root && resultWake.root.sourceMessageId !== origin.sourceMessageId) ||
        !origin.privateHandoffGeneration ||
        childRestart ||
        privateAnswers ||
        origin.execution !== resultWake.execution ||
        !validParentResultWake(resultWake, origin.nodeId) ||
        resultWake.priorTurnId === nativeHistory.turnId ||
        resultWake.priorGeneration === origin.privateHandoffGeneration)) ||
    (childRestart &&
      ((!origin?.privateHandoffHash && !origin?.root) ||
        Boolean(origin.root) !== Boolean(childRestart.rootResultHash) ||
        !origin.privateHandoffGeneration ||
        privateAnswers ||
        origin.execution !== childRestart.execution ||
        origin.restarts !== childRestart.restarts ||
        childRestart.priorTurnId === nativeHistory.turnId ||
        childRestart.priorGeneration === origin.privateHandoffGeneration ||
        childRestart.priorStartedAt > childRestart.reconciledAt ||
        childRestart.reconciledAt > childRestart.startedAt)) ||
    (!rootContinuation &&
      Boolean(origin?.privateHandoffHash) !== Boolean(origin?.privateHandoffGeneration)) ||
    (privateAnswers &&
      ((!origin?.privateHandoffHash && !origin?.root) ||
        !origin.privateHandoffGeneration ||
        privateAnswers.priorTurnId === nativeHistory.turnId ||
        privateAnswers.priorGeneration === origin.privateHandoffGeneration ||
        new Set(privateAnswers.answers.map((row) => row.cardId)).size !==
          privateAnswers.answers.length ||
        new Set(privateAnswers.answers.map((row) => row.requestId)).size !==
          privateAnswers.answers.length ||
        !privateAnswers.answers.every(
          (answer) => answer.answer.trim() && answer.person === privateAnswers.answers[0]?.person,
        ))) ||
    (origin?.privateHandoffHash &&
      (origin.root ||
        incident ||
        computer ||
        origin.dispatch !==
          (childRestart
            ? "rerun"
            : privateAnswers || resultWake || parkedStatus
              ? "resume"
              : "first") ||
        (privateAnswers || childRestart || resultWake || parkedStatus
          ? origin.restarts >= origin.execution
          : origin.restarts !== 0) ||
        !nativeHistory.messages.some(
          (row) =>
            row.nativeMessageId === origin.sourceMessageId &&
            row.role === "assistant" &&
            !row.mirrorMessageId &&
            !row.attachments.length,
        )))
  ) {
    throw new Error("The private handoff does not match its saved assignment row.");
  }
  if (incident) {
    const ids = incident.reports.map((report) => report.nativeMessageId);
    if (
      origin.root ||
      computer ||
      origin.execution !== 1 ||
      origin.restarts !== 0 ||
      origin.dispatch !== "first" ||
      ids.at(-1) !== nativeHistory.anchorMessageId ||
      new Set(ids).size !== ids.length ||
      !incident.reports.every((report, index) => {
        const row = nativeHistory.messages.filter((row) => row.role === "user").slice(-ids.length)[
          index
        ];
        return (
          row?.nativeMessageId === report.nativeMessageId &&
          !row.attachments.length &&
          NodeCrypto.createHash("sha256").update(row.text).digest("hex") === report.textHash
        );
      })
    ) {
      throw new Error("The native incident batch does not match its saved report rows.");
    }
  }
  if (
    origin &&
    ((origin.dispatch === "computer") !== Boolean(computer) ||
      (computer &&
        (!origin.root ||
          origin.execution < 2 ||
          origin.restarts !== 0 ||
          !NativeSelectionId.test(computer.id) ||
          !NativeSelectionId.test(computer.dispatchGeneration) ||
          !NativeSelectionId.test(computer.sourceGeneration) ||
          computer.dispatchGeneration === origin.nodeId ||
          computer.dispatchGeneration === computer.sourceGeneration ||
          computer.selected === computer.sourceSurface ||
          (computer.previousChoiceId !== undefined
            ? !NativeSelectionId.test(computer.previousChoiceId) ||
              computer.id === computer.previousChoiceId ||
              origin.execution === 2 ||
              computer.sourceGeneration === origin.nodeId ||
              computer.sourceSurface === null
            : origin.execution !== 2 || computer.sourceGeneration !== origin.nodeId))) ||
      origin.nodeId !== origin.requestId ||
      (origin.dispatch === "first") !== (origin.execution === 1) ||
      (origin.dispatch === "rerun" && origin.restarts === 0) ||
      origin.sourceMessageId !== nativeHistory.anchorMessageId ||
      (!authoredRoot &&
        (nativeHistory.promptAttachments.length !== 0 ||
          !nativeHistory.messages.some(
            (row) =>
              row.nativeMessageId === origin.sourceMessageId &&
              row.role === (origin.root || incident ? "user" : "assistant"),
          ))))
  ) {
    throw new Error("The saved assignment has no bot-authored request.");
  }
  const ids = new Set(origin && !authoredRoot ? [] : [nativeHistory.anchorMessageId]);
  for (const row of nativeHistory.messages) {
    if (
      ids.has(row.nativeMessageId) ||
      !validTimestamp(row.createdAt) ||
      (row.completedAt !== null &&
        (!validTimestamp(row.completedAt) ||
          Date.parse(row.completedAt) < Date.parse(row.createdAt)))
    ) {
      throw new Error("The native history has conflicting message identity or time.");
    }
    ids.add(row.nativeMessageId);
  }
  const j1ThreadId = ThreadId.make("j1-mausbot:" + expectedBotId + ":" + expectedThreadId);
  const stage = async (items: ReadonlyArray<typeof NativeAttachment.Type>, messageId: string) => {
    const attachments: ChatAttachment[] = [];
    for (const [index, item] of items.entries()) {
      if (!current()) throw new Error("The native history owner disconnected.");
      const kind = item.root ?? "managed";
      const parts = attachmentSegments(item.filename, kind === "managed");
      let root = sourceDir;
      if (kind === "workspace") {
        const workspace = request.workspace;
        if (
          !workspace ||
          !nativeHistory.workspaceRoot ||
          !NodePath.isAbsolute(nativeHistory.workspaceRoot) ||
          !samePath(workspace.root, nativeHistory.workspaceRoot) ||
          (profile.threadProjectId !== null && profile.threadProjectId !== workspace.projectId)
        ) {
          throw new Error("The saved native workspace does not match the current J1 project.");
        }
        root = workspace.root;
      } else if (kind === "bot") {
        root = NodePath.join(NodePath.dirname(sourceDir), "workspaces", expectedBotId);
      }
      attachments.push(
        await stageOwnedNativeAttachment({
          item,
          root,
          parts,
          kind,
          messageId,
          index,
          j1ThreadId,
          attachmentsDir: request.attachmentsDir,
          current,
        }),
      );
    }
    return attachments;
  };
  const messages = [];
  for (const row of nativeHistory.messages) {
    messages.push({ ...row, attachments: await stage(row.attachments, row.nativeMessageId) });
  }
  const promptAttachments = await stage(
    nativeHistory.promptAttachments,
    nativeHistory.anchorMessageId,
  );
  if (!current()) throw new Error("The native history owner disconnected.");
  return {
    ...profile,
    coldHistory: {
      turnId: nativeHistory.turnId,
      anchorMessageId: nativeHistory.anchorMessageId,
      promptText: nativeHistory.promptText,
      promptAttachments,
      messages,
      ...(origin ? { origin } : {}),
      ...(authoredSource && nativeHistory.authoredInputText !== undefined
        ? {
            authoredSource: { ...authoredSource, attachments: promptAttachments },
            authoredInputText: nativeHistory.authoredInputText,
          }
        : {}),
      workspaceRoot: nativeHistory.workspaceRoot ?? null,
    },
  };
}
