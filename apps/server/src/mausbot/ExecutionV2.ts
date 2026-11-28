// @effect-diagnostics nodeBuiltinImport:off - copies validated images at the existing attachment boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  BotId, BotProfile, CommandId, MessageId, ProjectId, ProviderInstanceId, RuntimeRequestId, ThreadId,
  ProviderUserInputAnswers, MAUSBOT_CHILD_RESTART_TEXT, mausbotParentResultText, isRuntimeModeAbove, resolveProjectProviderInstanceEnabled,
  type ServerSettings, type ChatAttachment, type OrchestrationV2DomainEvent, type OrchestrationV2ThreadShell, type OrchestrationV2Run, type RunId,
  type ServerProvider, type OrchestrationV2Command, type MausbotOriginStart, type OrchestrationV2ThreadProjection,
} from "@j1code/contracts";
import { modelSelectionsEqual } from "@j1code/shared/model";
import { MausbotProjectOverride, nativeBotRuntimeMode } from "../orchestration-v2/MausbotProjectOverride.ts";
import { roomSetupBatchText } from "./NativeBotEnrollment.ts";
import { MausbotOrigin, MausbotRoomCreation, matchesMausbotOrigin, mausbotRoomThreadId, roomPredecessor, roomHandoffPredecessorMatches, roomGoalHistoryItems, roomParkedAnswerMatches, coordinatorHistoryPrefix, coordinatorRowHash, coordinatorPredecessor, incidentPredecessor, privateAnswerHistory, privateStatusHistory, privateRestartInput, privateResultWakeInput, privateHandoffInput, privateHandoffPredecessor, matchesCoordinatorContinuation, mausbotOriginCommandId, mausbotOriginInputId } from "../orchestration-v2/MausbotOrigin.ts";
import { MausbotNativeProofError } from "../orchestration-v2/MausbotNativeProofError.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import {
  MausbotHistoryImport, mausbotHistoryCommandId, mausbotHistoryMessageId, type MausbotHistoryImportCommand,
} from "../orchestration-v2/MausbotHistoryImport.ts";
import type { OrchestratorV2Shape } from "../orchestration-v2/Orchestrator.ts";
import type { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import type { ProviderTurnControlServiceV2Shape } from "../orchestration-v2/ProviderTurnControlService.ts";
import type { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { registerBotExecutionContext } from "./ExecutionContext.ts";
import {
  CompatibilityApprovalOwner, compatibilityApprovalCommand, compatibilityMessageId, compatibilityStartCommandId,
} from "./CompatibilityApproval.ts";
import { stableStringify } from "@j1code/shared/relaySigning";
import { MausbotResume, MAUSBOT_RESUME_CURSOR_PREFIX, findMausbotResumeTarget, findMausbotIncidentFailure,
  readMausbotResumeCursor, mausbotResumeCommandId } from "../orchestration-v2/MausbotResume.ts";
import { ownedNativeRoomProject, parkedRoomAnswerText, roomProviderSystem, validateColdNativeRoomTurn } from "./NativeBotEnrollment.ts";
import type { ReadSavedNativeBotEnrollment, ReadSavedNativeRoomMemberEnrollment, SavedNativeRoomMemberEnrollment, StageSavedColdRoomTurn } from "./NativeBotEnrollment.ts";
import type { MausbotExecutionHost, MausbotExecutionOwner } from "./ExecutionHost.ts";
import type { ServerSettingsService } from "../serverSettings.ts";
import { nativeDefaultAccount, sharedModelOptions } from "./ExecutionAccounts.ts";
import {
  createAttachmentId, parseThreadSegmentFromAttachmentId, resolveAttachmentPath, toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";

const readNativeProof = <A>(message: string, read: () => Promise<A>) =>
  Effect.tryPromise({
    try: read,
    catch: (cause) => new MausbotNativeProofError({ message, cause }),
  });

const decodeProviderAnswers = Schema.decodeSync(ProviderUserInputAnswers);
const decodeBotProfile = Schema.decodeSync(BotProfile);

const id = Schema.String.check(Schema.isPattern(/^[\w-]{1,120}$/u));
const start = Schema.Struct({
  action: Schema.Literal("start"),
  botId: id,
  threadId: id,
  turnId: id,
  botName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  instanceId: ProviderInstanceId,
  model: Schema.String,
  effort: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  projectId: Schema.optional(ProjectId),
  cwd: Schema.String,
  text: Schema.String,
  system: Schema.String,
  recoveryText: Schema.optional(Schema.String),
  transcript: Schema.optional(
    Schema.Array(
      Schema.Struct({ role: Schema.Literals(["user", "assistant"]), text: Schema.String }),
    ),
  ),
  sharedContinuation: Schema.Boolean,
  nativeRoomTurn: Schema.optionalKey(Schema.Literal(true)),
  nativeIncidentRetry: Schema.optionalKey(Schema.Literal(true)),
  nativeIncidentNote: Schema.optionalKey(Schema.Literal(true)),
  nativeOriginStart: Schema.optionalKey(Schema.Literal(true)),
  trackCoordinatorRoot: Schema.optionalKey(Schema.Literal(true)),
  restrictedTools: Schema.Boolean,
  approvalMode: Schema.Literals(["ask", "edits", "auto", "full"]),
  guestConfined: Schema.Boolean,
  images: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      mime: Schema.Literals(["image/png", "image/jpeg", "image/gif", "image/webp"]),
      bytes: Schema.Number,
      source: Schema.optional(Schema.String),
    }),
  ).check(Schema.isMaxLength(100)),
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.optional(Schema.String),
      inputSchema: Schema.Unknown,
    }),
  ),
});
const source = { botId: id, threadId: id };
const invocation = Schema.Union([
  start,
  Schema.Struct({ action: Schema.Literal("catalog") }),
  Schema.Struct({ action: Schema.Literal("watch-catalog") }),
  Schema.Struct({ action: Schema.Literal("projects") }),
  Schema.Struct({ action: Schema.Literal("binding"), ...source }),
  Schema.Struct({ action: Schema.Literal("interrupt"), ...source }),
  Schema.Struct({ action: Schema.Literal("stop"), ...source }),
  Schema.Struct({
    action: Schema.Literal("respond"),
    ...source,
    requestId: Schema.String,
    decision: Schema.Literals(["accept", "decline", "cancel"]),
  }),
  Schema.Struct({
    action: Schema.Literal("answer"),
    ...source,
    requestId: Schema.String,
    answers: Schema.Record(Schema.String, Schema.Unknown),
  }),
  Schema.Struct({
    action: Schema.Literal("tool-result"),
    ...source,
    requestId: Schema.String,
    value: Schema.Unknown,
  }),
]);
type Invocation = typeof invocation.Type;
export type ExecutionV2StartInput = typeof start.Type;
type Start = ExecutionV2StartInput;
type Emit = (event: unknown) => void;
export const botExecutionThreadIdV2 = (botId: string, threadId: string) =>
  ThreadId.make(`j1-mausbot:${botId}:${threadId}`);

const executionV2IntegrationGaps = {
  history: "Cold bot history requires a saved native transcript and an unreplayed message.",
  resume: "The saved bot turn has no exact native continuation to resume.",
} as const;

const savedMausProfileId = (nativeBotId: string) => BotId.make(`mausbot:${nativeBotId}`);

/** The namespace is a lookup key. Only a saved J1 record can authorize new enrollment. */
function resolveSavedMausProfile(
  profiles: ServerSettings["bots"],
  nativeBotId: string,
  allowMissing: boolean,
): BotProfile | undefined {
  const key = savedMausProfileId(nativeBotId);
  const profile = Object.hasOwn(profiles, key) ? profiles[key] : undefined;
  if (profile && (profile.id !== key || profile.archived)) {
    throw new Error("The saved J1 bot profile is unavailable.");
  }
  if (!profile && !allowMissing) {
    throw new Error("The saved Maus bot has no authorized J1 bot profile.");
  }
  return profile;
}

function requireSavedBotThread(shell: OrchestrationV2ThreadShell | null, threadId: ThreadId, botId: BotId) {
  if (!shell || shell.id !== threadId || shell.archivedAt != null || shell.deletedAt != null ||
      shell.bot?.id !== botId)
    throw new Error("The saved J1 thread is unavailable or belongs to a different bot.");
  return { ...shell, bot: shell.bot };
}

const sameWorkspace = (left: string, right: string) =>
  left.trim() !== "" && right.trim() !== "" && NodePath.resolve(left) === NodePath.resolve(right);

function matchesEnrollmentWinner(profile: BotProfile, candidate: BotProfile): boolean {
  return profile.id === candidate.id &&
    profile.name === candidate.name &&
    profile.description === candidate.description &&
    profile.instructions === candidate.instructions &&
    profile.projectId === candidate.projectId &&
    modelSelectionsEqual(profile.modelSelection, candidate.modelSelection);
}

function supportsBotStart(provider: ServerProvider, input: Pick<Start, "instanceId" | "model">) {
  return provider.instanceId === input.instanceId && provider.enabled && provider.installed &&
    (provider.status === "ready" || provider.status === "warning") &&
    provider.availability !== "unavailable" && provider.auth.status !== "unauthenticated" &&
    provider.models.some(model => model.slug === input.model);
}

type PendingTool = { resolve(value: unknown): void; reject(error: Error): void };
export type ExecutionV2Turn = {
  readonly input: Start;
  readonly owner: MausbotExecutionOwner;
  readonly current: () => boolean;
  readonly emit: Emit;
  messageId: MessageId;
  compatibilityOwner?: NonNullable<typeof CompatibilityApprovalOwner.Service>;
  runId?: RunId;
  readonly resumeSource?: RunId;
  runBinding?: Pick<OrchestrationV2Run, "activeAttemptId" | "rootNodeId" | "providerThreadId">;
  releaseContext?: () => void;
  refreshOriginReceipt?: () => Promise<boolean>;
  refreshRetryReceipt?: () => Promise<boolean>;
  readonly pending: Map<string, PendingTool>;
  readonly requests: Map<RuntimeRequestId, "approval" | "user_input">;
  readonly emittedItems: Set<string>;
  sent: boolean;
  stopping?: boolean;
  terminalPending?: boolean;
};

/** Connection ownership and tool correlation are independent of pooled provider sessions. */
export class ExecutionV2Turns {
  private readonly turns = new Map<ThreadId, ExecutionV2Turn>();
  private readonly roomThreads = new Map<ThreadId, ThreadId>();
  forNative(botId: string, nativeThreadId: string) {
    const direct = botExecutionThreadIdV2(botId, nativeThreadId);
    return this.roomThreads.get(direct) ?? direct;
  }
  claim(input: Start, owner: MausbotExecutionOwner, current: () => boolean, emit: Emit,
    resume?: { messageId: MessageId; sourceRunId: RunId }, roomThreadId?: ThreadId,
  ) {
    if (!current()) throw new Error("The bot runtime disconnected.");
    if (input.guestConfined) throw new Error("Shared execution is not available to guest turns.");
    const direct = botExecutionThreadIdV2(input.botId, input.threadId);
    const threadId = roomThreadId ?? direct;
    if (this.turns.has(threadId) || this.turns.has(this.forNative(input.botId, input.threadId))) throw new Error("This bot thread already has an active turn.");
    const turn: ExecutionV2Turn = { input, owner, current, emit,
      messageId: resume?.messageId ?? MessageId.make(NodeCrypto.randomUUID()),
      ...(resume ? { resumeSource: resume.sourceRunId } : {}),
      pending: new Map(), requests: new Map(), emittedItems: new Set(), sent: false };
    this.turns.set(threadId, turn);
    if (roomThreadId) this.roomThreads.set(direct, roomThreadId);
    return { threadId, turn };
  }
  owned(threadId: ThreadId, owner: MausbotExecutionOwner) {
    const turn = this.turns.get(threadId);
    if (!turn || turn.owner !== owner || !turn.current())
      throw new Error("This bot turn is not active on this runtime connection.");
    return turn;
  }
  get(threadId: ThreadId) { return this.turns.get(threadId); }
  forOwner(owner: MausbotExecutionOwner) { return [...this.turns].filter(([, turn]) => turn.owner === owner); }
  owners() { return [...new Set([...this.turns.values()].map(turn => turn.owner))]; }
  release(threadId: ThreadId, expected: ExecutionV2Turn) {
    if (this.turns.get(threadId) !== expected) return;
    this.turns.delete(threadId);
    const direct = botExecutionThreadIdV2(expected.input.botId, expected.input.threadId);
    if (this.roomThreads.get(direct) === threadId) this.roomThreads.delete(direct);
    expected.releaseContext?.();
    for (const pending of expected.pending.values()) pending.reject(new Error("The bot turn ended."));
    expected.pending.clear();
    expected.requests.clear();
  }
  tool(threadId: ThreadId, turn: ExecutionV2Turn, name: string, arguments_: unknown, signal: AbortSignal) {
    if (this.turns.get(threadId) !== turn || !turn.current() || signal.aborted)
      return Promise.reject(new Error("The bot turn is no longer active."));
    if (!turn.input.tools.some(tool => tool.name === name))
      return Promise.reject(new Error("This tool was not offered to the bot turn."));
    return new Promise<unknown>((resolve, reject) => {
      const requestId = NodeCrypto.randomUUID();
      const { botId, threadId: sourceThreadId, turnId } = turn.input;
      const envelope = { botId, threadId: sourceThreadId, turnId, requestId };
      const clear = () => { signal.removeEventListener("abort", abort); turn.pending.delete(requestId); };
      const abort = () => {
        clear();
        try {
          if (turn.current()) turn.emit({ kind: "tool-cancel", ...envelope });
        } catch { /* The runtime connection may have closed. */ }
        reject(new Error("The bot tool was cancelled."));
      };
      turn.pending.set(requestId, { resolve: value => { clear(); resolve(value); }, reject: error => { clear(); reject(error); } });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) return abort();
      try {
        turn.emit({ kind: "tool-call", ...envelope, name, arguments: arguments_ });
      } catch (error) {
        clear();
        reject(error);
      }
    });
  }
  result(threadId: ThreadId, owner: MausbotExecutionOwner, requestId: string, value: unknown) {
    const pending = this.owned(threadId, owner).pending.get(requestId);
    if (!pending) throw new Error("This bot tool request is no longer active.");
    pending.resolve(value);
  }
}

export interface ExecutionV2Services {
  readonly orchestrator: Pick<OrchestratorV2Shape, "dispatch" | "getThreadShell" | "getThreadRecords" | "getThreadProjection">;
  readonly projects: Pick<ProjectStoreV2["Service"], "getShell" | "listShells">;
  readonly instances: Pick<ProviderInstanceRegistry["Service"], "getInstance" | "listInstances" | "listUnavailable">;
  readonly control: Pick<ProviderTurnControlServiceV2Shape, "interrupt">;
  readonly settings: Pick<ServerSettingsService["Service"], "getSettings" | "managedPolicy" | "insertBotProfileIfAbsent">;
  readonly attachmentsDir: string;
  readonly mausbotDataDir: string;
}
const command = () => CommandId.make(`mausbot:${NodeCrypto.randomUUID()}`);
const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

async function imageAttachments(
  input: Start, threadId: ThreadId, attachmentsDir: string, createdPaths: string[],
  warn: (message: string) => Promise<void>,
) {
  const result: ChatAttachment[] = [];
  if (input.images.length === 0) return result;
  let total = 0;
  await NodeFSP.mkdir(attachmentsDir, { recursive: true });
  for (const image of input.images) {
    const stat = await NodeFSP.stat(image.path);
    total += stat.size;
    if (!stat.isFile() || stat.size !== image.bytes || stat.size > 20 * 1024 * 1024 || total > 80 * 1024 * 1024)
      throw new Error("The bot image attachment changed or exceeds the attachment budget.");
    const bytes = await NodeFSP.readFile(image.path);
    const signature = image.mime === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : image.mime === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : image.mime === "image/gif" ? /^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString("ascii"))
      : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    if (bytes.length !== image.bytes || !signature) throw new Error("Invalid bot image content.");
    const attachment: ChatAttachment = { type: "image", id: createAttachmentId(threadId)!, name: NodePath.basename(image.path), mimeType: image.mime, sizeBytes: bytes.length };
    const destination = resolveAttachmentPath({ attachmentsDir, attachment });
    if (!destination) throw new Error("Invalid bot image attachment.");
    const file = await NodeFSP.open(destination, "wx");
    // Track ownership only after exclusive creation, including partial writes.
    createdPaths.push(destination);
    try {
      await file.writeFile(bytes);
    } catch (error) {
      await file.close().catch(() => warn("Could not close a failed bot image write."));
      throw error;
    }
    await file.close();
    result.push(attachment);
  }
  return result;
}

type ExecutionV2Call = MausbotExecutionHost["Service"]["call"];

type ExecutionV2Host = MausbotExecutionHost["Service"] & {
  readonly close: () => Promise<void>;
  readonly call: ExecutionV2Call;
  readonly acceptEvent: (event: OrchestrationV2DomainEvent) => void;
  readonly turns: ExecutionV2Turns;
  readonly catalogChanged: (signal?: AbortSignal) => Promise<void>;
};

/** Constructs the host and its local event handlers without providing a service layer. */
export function createMausbotExecutionV2(
  deps: ExecutionV2Services,
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
  eventDelivery: "receipts" | "stream" = "receipts",
): ExecutionV2Host {
  const turns = new ExecutionV2Turns();
  const resolveRoomProject = async (
    profileProject: ProjectId | null | undefined,
    binding: NonNullable<SavedNativeRoomMemberEnrollment["memberBindings"]>[number] | undefined,
    requestedProject: ProjectId | undefined,
    cwd: string,
  ) => {
    const bound = ownedNativeRoomProject(profileProject, binding, requestedProject);
    if (profileProject || requestedProject || binding?.projectId !== null) return bound;
    const workspace = NodePath.join(deps.mausbotDataDir, "workspaces", binding.memberId);
    if (!sameWorkspace(binding.workspace, workspace) || !sameWorkspace(cwd, workspace)) return;
    const matches = (await run(deps.projects.listShells())).filter(project =>
      project.archivedAt == null && sameWorkspace(project.workspaceRoot, workspace),
    );
    if (matches.length === 1) return matches[0]!.id;
  };
  const subscribers = new Map<MausbotExecutionOwner, { current: () => boolean; emit: Emit }>();
  // Keep the final Stop receipt for as long as the runtime retains its generation.
  const retiredOwners = new WeakMap<MausbotExecutionOwner, Promise<void>>();
  const disconnecting = new Set<MausbotExecutionOwner>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const catalog = async () => {
    const configured = await run(deps.settings.getSettings);
    const instances = await run(deps.instances.listInstances);
    const unavailable = await run(deps.instances.listUnavailable);
    const providers = await Promise.all(instances.map(instance => run(instance.snapshot.getSnapshot)));
    return [...providers, ...unavailable].map(row => ({
      ...row, nativeDefault: nativeDefaultAccount(row,
        configured.providerInstances[row.instanceId]),
    }));
  };
  const runtime = (turn: ExecutionV2Turn, event: unknown) => {
    if (!turn.current()) return;
    try { turn.emit({ kind: "runtime", botId: turn.input.botId, threadId: turn.input.threadId, turnId: turn.input.turnId, event }); }
    catch { /* A closed transport must not poison the shared event reader. */ }
  };
  const acceptEvent = (event: OrchestrationV2DomainEvent) => {
    const turn = turns.get(event.threadId);
    if (!turn || !turn.current()) return;
    if ((event.type === "run.created" || event.type === "run.updated") &&
        event.payload.userMessageId === turn.messageId) {
      if (turn.resumeSource !== undefined &&
          event.payload.manualContinuationOfRunId !== turn.resumeSource) return;
      if (turn.runId !== undefined && turn.runId !== event.payload.id) return;
      if (event.runId !== event.payload.id) return;
      turn.runId = event.payload.id;
      turn.runBinding = event.payload;
      if (terminal.has(event.payload.status)) {
        if (turn.terminalPending) return;
        turn.terminalPending = true;
        const state = event.payload.status === "failed" ? "failed" : event.payload.status === "completed" ? "completed" : "interrupted";
        const finish = (failure?: ReturnType<typeof findMausbotIncidentFailure>) => {
          if (turns.get(event.threadId) !== turn) return;
          runtime(turn, { type: "turn.completed", payload: { state, ...(!turn.stopping && failure ? {
            incidentFailure: stableStringify({ ...failure, policy: resumeSignature(turn.input) }),
          } : {}) } });
          turns.release(event.threadId, turn);
        };
        if (state === "failed" && turn.sent && !turn.stopping) {
          void run(deps.orchestrator.getThreadProjection(event.threadId)).then(
            projection => finish(findMausbotIncidentFailure(projection, event.payload.id)),
            () => finish(),
          );
        } else finish();
      }
      return;
    }
    if (turn.runId === undefined || event.runId !== turn.runId) return;
    if (event.type === "provider-turn.updated" && event.payload.status === "running" && !turn.sent) {
      const binding = turn.runBinding;
      if (!binding || binding.activeAttemptId === null || binding.rootNodeId === null ||
          binding.providerThreadId === null || event.payload.runAttemptId !== binding.activeAttemptId ||
          event.payload.nodeId !== binding.rootNodeId || event.payload.providerThreadId !== binding.providerThreadId ||
          event.payload.startedAt === null || event.payload.nativeTurnRef?.nativeId == null ||
          event.payload.nativeTurnRef.strength === "none") return;
      turn.sent = true;
      runtime(turn, { type: "turn.started", payload: {
        resumeCursor: MAUSBOT_RESUME_CURSOR_PREFIX + turn.input.botId + ":" + turn.input.threadId +
          ":" + resumeSignature(turn.input) + ":" + turn.runId,
      } });
    } else if (event.type === "message.updated" && event.payload.role === "assistant" && !event.payload.streaming) {
      const key = `message:${event.payload.id}`;
      if (turn.emittedItems.has(key)) return;
      turn.emittedItems.add(key);
      runtime(turn, { type: "item.completed", itemId: event.payload.id, payload: { itemType: "assistant_message", data: { text: event.payload.text } } });
    } else if (event.type === "runtime-request.updated") {
      const request = event.payload;
      if (request.status === "pending") {
        if (request.kind === "user_input") turn.requests.set(request.id, "user_input");
      } else if (turn.requests.delete(request.id)) {
        if (turn.input.nativeRoomTurn && request.kind === "user_input" &&
            (request.status === "cancelled" || request.status === "expired") &&
            !request.decision && !request.answers) return;
        runtime(turn, { type: request.kind === "user_input" ? "user-input.resolved" : "request.resolved", requestId: request.id, payload: { decision: request.decision } });
      }
    } else if (event.type === "turn-item.updated" && (event.payload.type === "approval_request" || event.payload.type === "user_input_request")) {
      const item = event.payload;
      if (item.status !== "pending" && item.status !== "running") return;
      const key = `request:${item.requestId}`;
      if (turn.emittedItems.has(key)) return;
      turn.emittedItems.add(key);
      turn.requests.set(item.requestId, item.type === "user_input_request" ? "user_input" : "approval");
      runtime(turn, item.type === "user_input_request"
        ? { type: "user-input.requested", requestId: item.requestId, payload: { questions: item.questions } }
        : { type: "request.opened", requestId: item.requestId, payload: { appName: item.appName, requestType: item.requestKind, detail: item.prompt ?? item.reason } });
    } else if (event.type === "turn-item.updated" && event.payload.type !== "assistant_message" &&
        event.payload.type !== "user_message") {
      const item = event.payload;
      const finished = terminal.has(item.status);
      if (!finished && !["pending", "running", "waiting"].includes(item.status)) return;
      const key = `activity:${item.id}:${finished ? "completed" : "started"}`;
      if (turn.emittedItems.has(key)) return;
      turn.emittedItems.add(key);
      runtime(turn, { type: finished ? "item.completed" : "item.started", itemId: item.id,
        payload: { itemType: item.type === "reasoning" ? "reasoning" : "tool", title: item.title ?? item.type,
          status: item.status, detail: "output" in item && typeof item.output === "string" ? item.output : undefined } });
    }
  };
  const resumeSignature = (input: Start) => NodeCrypto.createHash("sha256").update(stableStringify({
    approval: input.approvalMode, restricted: input.restrictedTools, account: input.instanceId,
    model: input.model, effort: input.effort ?? null, variant: input.variant ?? null,
    tools: [...input.tools].sort((a, b) => a.name.localeCompare(b.name)),
  })).digest("hex");

  const resumeSaved = async (
    input: Start, owner: MausbotExecutionOwner, current: () => boolean, emit: Emit,
    readEnrollment?: ReadSavedNativeBotEnrollment,
  ) => {
    const fail = () => new Error(executionV2IntegrationGaps.resume);
    if (!readEnrollment || input.guestConfined || !input.sharedContinuation) throw fail();
    const ids = { resumeTurnId: input.turnId };
    const native = await readEnrollment(input.botId, input.threadId, ids);
    const sourceId = native?.savedResumeCursor && readMausbotResumeCursor(
      native.savedResumeCursor, input.botId, input.threadId, resumeSignature(input),
    );
    if (!native || !sourceId || native.botId !== input.botId || native.threadId !== input.threadId ||
        native.approvalMode !== input.approvalMode || native.restrictedTools !== input.restrictedTools ||
        native.threadSelection.instanceId !== input.instanceId || native.threadSelection.model !== input.model ||
        native.threadVariant !== input.variant) throw fail();
    const threadId = botExecutionThreadIdV2(input.botId, input.threadId);
    const botId = savedMausProfileId(input.botId);
    const saved = requireSavedBotThread(await run(deps.orchestrator.getThreadShell(threadId)), threadId, botId);
    const settings = await run(deps.settings.getSettings);
    const profile = resolveSavedMausProfile(settings.bots, input.botId, true);
    const project = Option.getOrUndefined(await run(deps.projects.getShell(saved.projectId)));
    const limit = { runtimeMode: nativeBotRuntimeMode(input.approvalMode), interactionMode: saved.interactionMode };
    const workspace = saved.worktreePath ?? project?.workspaceRoot;
    if (!project || project.id !== saved.projectId || project.archivedAt != null || !workspace ||
        !sameWorkspace(workspace, input.cwd) || (input.projectId && input.projectId !== saved.projectId) ||
        (native.threadProjectId !== null && native.threadProjectId !== saved.projectId) ||
        (profile?.projectId != null && (profile.projectId !== native.projectId ||
          (profile.projectId !== saved.projectId && native.threadProjectId !== saved.projectId))) ||
        limit.runtimeMode !== saved.runtimeMode ||
        isRuntimeModeAbove(limit.runtimeMode, deps.settings.managedPolicy?.limits?.maxRuntimeMode) ||
        !resolveProjectProviderInstanceEnabled(settings, project.id, input.instanceId)) throw fail();
    const instance = await run(deps.instances.getInstance(input.instanceId));
    if (!instance?.enabled || instance.instanceId !== input.instanceId ||
        !supportsBotStart(await run(instance.snapshot.getSnapshot), input)) throw fail();
    const projection = await run(deps.orchestrator.getThreadProjection(threadId));
    const source = findMausbotResumeTarget(projection, sourceId);
    if (!source || source.run.providerInstanceId !== input.instanceId ||
        source.run.modelSelection.model !== input.model || !sameWorkspace(workspace, source.session.cwd)) throw fail();
    const failed = input.nativeIncidentRetry ? findMausbotIncidentFailure(projection, sourceId) : undefined;
    const failure = failed && stableStringify({ ...failed, policy: resumeSignature(input) });
    if (input.nativeIncidentRetry ? (!failure || failure !== native.savedIncidentFailure) : native.savedIncidentFailure !== undefined)
      throw fail();
    const note = native.savedIncidentNote;
    if (Boolean(input.nativeIncidentNote) !== Boolean(note) ||
        (note && (!failure || !input.nativeIncidentRetry || input.text !== note.text || !note.text.trim() ||
          note.chiefId === input.botId || note.chiefThreadId === input.threadId)) ||
        (!note && (input.nativeIncidentRetry ? input.text !== "" : Boolean(input.text.trim())))) throw fail();
    const target = { ...source.target, ...(failure ? { incidentFailure: failure } : {}),
      ...(note ? { incidentNote: note } : {}) };
    // Codex exposes the guarded empty native operation. Its bot adapter cannot enforce a restricted tool set.
    if (source.session.driver !== "codex" || input.restrictedTools)
      throw new Error("The original provider cannot resume this bot run with its selected tool scope.");
    const { turn } = turns.claim(input, owner, current, emit, {
      messageId: source.run.userMessageId, sourceRunId: sourceId,
    });
    try {
      const isCurrent = () => turns.get(threadId) === turn && current() && !turn.stopping;
      const refresh = async (currentRunId?: string) => {
        if (!isCurrent()) return false;
        const currentShell = await run(deps.orchestrator.getThreadShell(threadId));
        const currentProject = Option.getOrUndefined(await run(deps.projects.getShell(project.id)));
        const currentSettings = await run(deps.settings.getSettings);
        resolveSavedMausProfile(currentSettings.bots, input.botId, true);
        const refreshed = await readEnrollment(input.botId, input.threadId, ids);
        if (failure) {
          const latestProjection = await run(deps.orchestrator.getThreadProjection(threadId));
          const preceding = findMausbotIncidentFailure({
            ...latestProjection,
            runs: latestProjection.runs.filter(row => row.id !== currentRunId),
          }, sourceId);
          if (!preceding || stableStringify({ ...preceding, policy: resumeSignature(input) }) !== failure)
            return false;
        }
        return isCurrent() && currentShell?.bot?.id === botId &&
          currentShell.projectId === project.id && currentShell.runtimeMode === limit.runtimeMode &&
          currentShell.interactionMode === limit.interactionMode &&
          currentShell.archivedAt == null && currentShell.deletedAt == null &&
          currentProject?.id === project.id && currentProject.archivedAt == null &&
          sameWorkspace(currentShell.worktreePath ?? currentProject.workspaceRoot, workspace) &&
          resolveProjectProviderInstanceEnabled(currentSettings, project.id, input.instanceId) &&
          stableStringify(refreshed) === stableStringify(native);
      };
      turn.releaseContext = registerBotExecutionContext(threadId, {
        prompt: "", restrictedTools: input.restrictedTools, tools: input.tools,
        resume: { ...target, ...limit, projectId: project.id, cwd: workspace,
          ...(failure ? { verifyIncident: refresh } : {}) },
        call: (name, arguments_, signal) => turns.tool(threadId, turn, name, arguments_, signal),
      }, { botId: input.botId, messageId: turn.messageId, isCurrent });
      const dispatch = {
        type: "message.dispatch", threadId, commandId: mausbotResumeCommandId(sourceId),
        messageId: turn.messageId, text: note?.text ?? "", attachments: [], modelSelection: source.run.modelSelection,
        manualContinuationOfRunId: sourceId, dispatchMode: { type: "start_immediately" },
        createdBy: note ? "agent" : "user", creationSource: "server",
      } as const;
      const result = await run(deps.orchestrator.dispatch(dispatch).pipe(
        Effect.provideService(DispatchModeLimit, limit),
        Effect.provideService(MausbotResume, {
          command: dispatch, target, current: isCurrent,
          refresh: readNativeProof("Could not refresh the saved native continuation.", refresh),
        }),
      ));
      if (result.replayed) {
        turns.release(threadId, turn);
        return { turnId: input.turnId, replayed: true };
      }
      if (eventDelivery === "receipts") {
        for (const { event } of result.storedEvents) acceptEvent(event);
      }
      if (failure) turn.refreshRetryReceipt = () => refresh(turn.runId);
      return { turnId: input.turnId };
    } catch (error) { turns.release(threadId, turn); throw error; }
  };

  const invoke = async (
    input: Invocation,
    current: () => boolean,
    emit: Emit,
    owner: MausbotExecutionOwner,
    readEnrollment?: ReadSavedNativeBotEnrollment,
    readRoomEnrollment?: ReadSavedNativeRoomMemberEnrollment,
    stageRoomTurn?: StageSavedColdRoomTurn,
  ): Promise<unknown> => {
    if (!current()) throw new Error("The bot runtime disconnected.");
    if (input.action === "catalog") return catalog();
    if (input.action === "watch-catalog") {
      const subscription = { current, emit };
      subscribers.set(owner, subscription);
      try { return await catalog(); }
      catch (error) {
        if (subscribers.get(owner) === subscription) subscribers.delete(owner);
        throw error;
      }
    }
    if (input.action === "projects") return (await run(deps.projects.listShells())).map(project => ({ id: project.id, title: project.title, workspaceRoot: project.workspaceRoot }));
    const threadId = turns.forNative(input.botId, input.threadId);
    const held = turns.get(threadId);
    if (held && held.owner !== owner) throw new Error("This bot turn belongs to another runtime connection.");
    if (input.action === "start" && input.nativeRoomTurn) {
      if (!readRoomEnrollment || !stageRoomTurn || input.guestConfined || input.trackCoordinatorRoot || input.nativeOriginStart ||
          input.nativeIncidentRetry || input.nativeIncidentNote)
        throw new Error("The shared V2 provider cannot start a room turn without saved room-member ownership.");
      const snapshot = await readRoomEnrollment(input.botId, input.threadId, input.turnId);
      if (!snapshot || !current())
        throw new Error("The shared V2 provider cannot start a room turn without saved room-member ownership.");
      const { effort, variant, ...roomInput } = input;
      const roomRequest = {
        ...roomInput,
        ...(effort === undefined ? {} : { effort }),
        ...(variant === undefined ? {} : { variant }),
      };
      const plan = validateColdNativeRoomTurn(snapshot, roomRequest);
      const system = roomProviderSystem(input.system, plan.goal, Boolean(plan.parked));
      const assignment = plan.goal?.continuation;
      const handedGoal = !plan.parked && assignment?.coordinator && assignment.fromMemberId && assignment.fromMemberId !== input.botId;
      if (held) {
        if (threadId === plan.threadId && stableStringify(held.input) === stableStringify(input) &&
            await held.refreshOriginReceipt?.()) return { turnId: input.turnId };
        throw new Error("Another native room operation already owns this member.");
      }
      const botId = savedMausProfileId(input.botId);
      const settings = await run(deps.settings.getSettings);
      const profile = resolveSavedMausProfile(settings.bots, input.botId, true);
      const roomBinding = snapshot.memberBindings?.find(binding => binding.memberId === input.botId);
      const projectId = await resolveRoomProject(profile?.projectId, roomBinding, input.projectId, input.cwd);
      const instance = await run(deps.instances.getInstance(input.instanceId));
      const project = projectId && Option.getOrUndefined(await run(deps.projects.getShell(projectId)));
      const runtimeMode = nativeBotRuntimeMode(input.approvalMode);
      if (!projectId || !project || project.archivedAt != null || !sameWorkspace(project.workspaceRoot, input.cwd) ||
          !instance?.enabled || !resolveProjectProviderInstanceEnabled(settings, projectId, input.instanceId) ||
          isRuntimeModeAbove(runtimeMode, deps.settings.managedPolicy?.limits?.maxRuntimeMode))
        throw new Error("The room member is outside its saved J1 project or provider policy.");
      const provider = await run(instance.snapshot.getSnapshot);
      if (!supportsBotStart(provider, input) || (provider.supportedRuntimeModes && !provider.supportedRuntimeModes.includes(runtimeMode)))
        throw new Error("The room member's original provider is unavailable.");
      const options = sharedModelOptions(provider, input.model, input.effort, input.variant);
      const modelSelection = { instanceId: input.instanceId, model: input.model, ...(options.length ? { options } : {}) };
      const existing = await run(deps.orchestrator.getThreadShell(plan.threadId));
      if (existing && (existing.pendingRuntimeRequest !== null ||
          existing.bot?.id !== botId || existing.projectId !== projectId ||
          existing.runtimeMode !== runtimeMode || existing.interactionMode !== "default" ||
          !modelSelectionsEqual(existing.modelSelection, modelSelection) ||
          existing.archivedAt != null || existing.deletedAt != null))
        throw new Error("The shared V2 provider cannot start a warm or foreign room turn.");
      const { turn } = turns.claim(input, owner, current, emit, undefined, plan.threadId);
      const isCurrent = () => turns.get(plan.threadId) === turn && current() && !turn.stopping;
      try {
        const refreshed = async () => {
          if (!isCurrent()) return false;
          const live = await readRoomEnrollment(input.botId, input.threadId, input.turnId);
          const currentProject = Option.getOrUndefined(await run(deps.projects.getShell(projectId)));
          const latest = await run(deps.settings.getSettings);
          const selected = await run(deps.instances.getInstance(input.instanceId));
          const selectedSnapshot = selected?.enabled ? await run(selected.snapshot.getSnapshot) : undefined;
          const currentProfile = resolveSavedMausProfile(latest.bots, input.botId, true);
          const ownerProject = await resolveRoomProject(currentProfile?.projectId, roomBinding, input.projectId, input.cwd);
          return isCurrent() && stableStringify(live) === stableStringify(snapshot) &&
            ownerProject === projectId &&
            Boolean(currentProject && currentProject.archivedAt == null &&
              sameWorkspace(currentProject.workspaceRoot, input.cwd)) &&
            Boolean(selectedSnapshot && supportsBotStart(selectedSnapshot, input) &&
              (!selectedSnapshot.supportedRuntimeModes || selectedSnapshot.supportedRuntimeModes.includes(runtimeMode)) &&
              stableStringify(sharedModelOptions(selectedSnapshot, input.model, input.effort, input.variant)) ===
              stableStringify(options)) &&
            resolveProjectProviderInstanceEnabled(latest, projectId, input.instanceId) &&
            !isRuntimeModeAbove(runtimeMode, deps.settings.managedPolicy?.limits?.maxRuntimeMode);
        };
        const roomIdentity = {
          groupId: snapshot.groupId, nativeThreadId: snapshot.threadId, memberId: snapshot.botId,
          generation: snapshot.operation.generation, operationId: snapshot.operation.id,
          currentRowIds: snapshot.operation.sourceRowIds,
        };
        const priorProjection = existing ? await run(deps.orchestrator.getThreadProjection(plan.threadId)) : undefined;
        const latest = priorProjection?.runs.find(row => row.id === existing?.latestRunId)?.mausbotOriginStart;
        const sameOperation = latest?.room?.operationId === roomIdentity.operationId &&
          latest.room.generation === roomIdentity.generation;
        const continuation = priorProjection && roomPredecessor(priorProjection, roomIdentity, modelSelection);
        const previousRoomSnapshot = priorProjection?.runs.find(row => row.id === continuation?.predecessorRunId)
          ?.mausbotOriginStart?.room?.snapshot;
        if (input.sharedContinuation && !continuation && !sameOperation)
          throw new Error("The room resume hint has no matching owned provider session.");
        const nextGoal = plan.goal?.continuation;
        const coldAssignment = !plan.parked && nextGoal?.coordinator === true && nextGoal.fromMemberId !== undefined &&
          nextGoal.fromMemberId !== input.botId && nextGoal.targetMemberId === input.botId &&
          (!existing || (sameOperation && !latest?.continuation) ||
            (!existing.latestRunId && existing.itemCount === 0 && !existing.activeProviderThreadId && !existing.activeRunId));
        if (snapshot.operation.kind === "goal" && !coldAssignment && (!continuation || !previousRoomSnapshot))
          throw new Error("The room goal has no exact settled predecessor on its original provider.");
        if ((plan.setup || plan.parked || plan.childRestart || plan.parentResultWake) && (!continuation || !previousRoomSnapshot))
          throw new Error("The parked answer has no exact settled predecessor on its original provider.");
        if (existing && (existing.latestRunId !== null || existing.itemCount !== 0 || existing.activeProviderThreadId !== null) &&
            !sameOperation && (!continuation || existing.activeProviderThreadId !== continuation.providerThreadId ||
              existing.activeRunId !== null || !previousRoomSnapshot))
          throw new Error("The warm room has no exact settled predecessor on its original provider.");
        const stageRequest = { ...roomRequest, attachmentsDir: deps.attachmentsDir, current: isCurrent,
          ...(previousRoomSnapshot ? { previousRoomSnapshot } : {}) };
        const staged = await stageRoomTurn(stageRequest);
        if (!staged || !await refreshed()) throw new Error("The cold native room operation changed during staging.");
        const currentIds = new Set(snapshot.operation.sourceRowIds);
        const currentRows = staged.rows.filter(row => currentIds.has(row.id));
        const attachments = currentRows.flatMap(row => row.stagedAttachments);
        const imageNames = attachments.filter(item => item.type === "image").map(item => item.name).sort();
        if (input.images.length && stableStringify(input.images.map(item => NodePath.basename(item.path)).sort()) !==
            stableStringify(imageNames)) throw new Error("The room input images do not match its saved managed attachments.");
        if (plan.handoff?.mode === "consult" && input.tools.length)
          throw new Error("The consultation cannot mount action tools.");
        const text = plan.setup ? roomSetupBatchText(plan.setup) : plan.parentResultWake ? mausbotParentResultText(plan.parentResultWake) : plan.childRestart ? MAUSBOT_CHILD_RESTART_TEXT : plan.parked ? parkedRoomAnswerText(plan.parked) :
          plan.handoff?.consultationText ?? plan.handoff?.assignment ?? plan.goal?.continuation?.assignment ?? currentRows.map(row => row.text ?? "").join("\n\n");
        const room = { ...roomIdentity, snapshot: stableStringify(staged) };
        const history = staged.rows.map(row => ({
          nativeMessageId: row.id, createdAt: DateTime.formatIso(DateTime.makeUnsafe(row.at)),
          completedAt: row.turnCompletedAt === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(row.turnCompletedAt)),
          role: row.role === "user" ? "user" as const : "assistant" as const,
          text: row.text ?? "", attachments: row.stagedAttachments,
          ...(row.j1ProviderMessageId && (row.provenance.from as { botId?: string } | undefined)?.botId === snapshot.botId
            ? { mirrorMessageId: row.j1ProviderMessageId } : {}),
        }));
        const origin: MausbotOriginStart = {
          room, nodeId: room.operationId, requestId: room.operationId, execution: 1, dispatch: "first", restarts: 0,
          ...(plan.handoff?.mode === "consult" ? { consultation: { reply: plan.handoff.reply === "poll" ? "poll" as const : "resume" as const,
            brief: plan.handoff.assignment, envelopeHash: NodeCrypto.createHash("sha256").update(text).digest("hex") } } : {}),
          ...(plan.childRestart ? { childRestart: plan.childRestart } : {}),
          ...(plan.parentResultWake ? { parentResultWake: plan.parentResultWake } : {}),
          ...(continuation ? { continuation } : {}),
          sourceMessageId: mausbotHistoryMessageId(plan.threadId, snapshot.operation.requestId!),
          text, attachments, historyPrefix: coordinatorHistoryPrefix(history),
          fingerprint: NodeCrypto.createHash("sha256").update(stableStringify({
            room, projectId, modelSelection, system: input.system, tools: input.tools,
          })).digest("hex"),
        };
        const sourceMembers = new Set(snapshot.goalHistory?.flatMap(journal =>
          journal.steps.map(step => step.memberId ?? journal.coordinatorId)));
        sourceMembers.delete(input.botId);
        const readGoalSources = async () => {
          const sources = new Map<string, OrchestrationV2ThreadProjection>();
          if (!sourceMembers.size) return sources;
          const sourceSettings = await run(deps.settings.getSettings);
          for (const memberId of sourceMembers) {
            if (!snapshot.roster.includes(memberId)) return null;
            const binding = snapshot.memberBindings?.find(row => row.memberId === memberId);
            if (snapshot.memberBindings !== undefined && !binding) return null;
            const sourceProfile = resolveSavedMausProfile(sourceSettings.bots, memberId, true);
            const sourceProjectId = await resolveRoomProject(sourceProfile?.projectId, binding, undefined, binding?.workspace ?? "");
            if (!sourceProjectId || (sourceProjectId !== projectId &&
                (binding?.projectId !== sourceProjectId || roomBinding?.projectId !== projectId))) return null;
            const sourceThreadId = ThreadId.make(mausbotRoomThreadId({ ...room, memberId }));
            const shell = await run(deps.orchestrator.getThreadShell(sourceThreadId));
            if (!shell || shell.bot?.id !== savedMausProfileId(memberId) || shell.projectId !== sourceProjectId ||
                shell.archivedAt != null || shell.deletedAt != null || shell.activeRunId !== null ||
                shell.pendingRuntimeRequest !== null) return null;
            if (binding) {
              const project = Option.getOrUndefined(await run(deps.projects.getShell(sourceProjectId)));
              const account = await run(deps.instances.getInstance(binding.selection.instanceId));
              if (!project || project.archivedAt != null || !sameWorkspace(project.workspaceRoot, binding.workspace) ||
                  shell.worktreePath != null || !account?.enabled ||
                  !resolveProjectProviderInstanceEnabled(sourceSettings, sourceProjectId, binding.selection.instanceId) ||
                  shell.runtimeMode !== nativeBotRuntimeMode(binding.approvalMode) ||
                  isRuntimeModeAbove(shell.runtimeMode, deps.settings.managedPolicy?.limits?.maxRuntimeMode)) return null;
              const provider = await run(account.snapshot.getSnapshot);
              if (!supportsBotStart(provider, binding.selection) ||
                  (provider.supportedRuntimeModes && !provider.supportedRuntimeModes.includes(shell.runtimeMode))) return null;
              const options = sharedModelOptions(provider, binding.selection.model, binding.effort, binding.variant);
              if (!modelSelectionsEqual(shell.modelSelection, { ...binding.selection, ...(options.length ? { options } : {}) }))
                return null;
            }
            sources.set(memberId, await run(deps.orchestrator.getThreadProjection(sourceThreadId)));
          }
          return sources;
        };
        const roomGoalSources = await readGoalSources();
        if (!roomGoalSources || !roomGoalHistoryItems(priorProjection, origin, roomGoalSources))
          throw new Error("The native goal decision does not match the settled provider reply.");
        if ((plan.handoff || plan.parentResultWake || plan.childRestart) && continuation && (!priorProjection || !roomHandoffPredecessorMatches(priorProjection, origin)))
          throw new Error("The room handoff changed its recipient scope or was already dispatched.");
        if ((plan.setup || plan.parked) && (!priorProjection || !roomParkedAnswerMatches(priorProjection, origin)))
          throw new Error("The saved room decisions do not own this settled provider turn.");
        const refresh = async () => {
          if (!await refreshed()) return false;
          const shell = await run(deps.orchestrator.getThreadShell(plan.threadId));
          if (shell && (shell.bot?.id !== botId || shell.projectId !== projectId || shell.runtimeMode !== runtimeMode ||
              shell.interactionMode !== "default" || !modelSelectionsEqual(shell.modelSelection, modelSelection) ||
              shell.archivedAt != null || shell.deletedAt != null)) return false;
          const sources = await readGoalSources();
          if (!sources) return false;
          if (continuation) {
            const projection = await run(deps.orchestrator.getThreadProjection(plan.threadId));
            if (shell?.activeProviderThreadId !== continuation.providerThreadId ||
                !matchesCoordinatorContinuation(continuation, roomPredecessor(projection, room, modelSelection)) ||
                !roomGoalHistoryItems(projection, origin, sources) || !roomParkedAnswerMatches(projection, origin) ||
                !roomHandoffPredecessorMatches(projection, origin)) return false;
          } else if (!roomGoalHistoryItems(undefined, origin, sources)) return false;
          const stagedAgain = await stageRoomTurn(stageRequest);
          return isCurrent() && stableStringify(stagedAgain) === room.snapshot;
        };
        const limit = { runtimeMode, interactionMode: "default" as const };
        if (sameOperation && (!latest || !matchesMausbotOrigin(latest, origin)))
          throw new Error("The saved room receipt belongs to different input or an uncertain predecessor.");
        if (!existing) {
          const creation = { type: "thread.bot.create", commandId: command(), threadId: plan.threadId,
            projectId, botId, title: snapshot.enrollment.name, modelSelection, runtimeMode, interactionMode: "default",
            branch: null, worktreePath: null, createdBy: "agent", creationSource: "server" } as const;
          await run(deps.orchestrator.dispatch(creation).pipe(Effect.provideService(DispatchModeLimit, limit),
            Effect.provideService(MausbotRoomCreation, {
              command: creation,
              ...(profile === undefined && roomBinding?.projectId === null && input.projectId === undefined
                ? { member: { id: botId, name: snapshot.enrollment.name, instructions: "" } }
                : {}),
              current: isCurrent,
              refresh: readNativeProof("Could not refresh the saved native room operation.", refresh),
            })));
        }
        turn.messageId = mausbotOriginInputId(plan.threadId, origin);
        turn.releaseContext = registerBotExecutionContext(plan.threadId, {
          origin: { input: origin, refresh }, restrictedTools: input.restrictedTools,
          prompt: [system,
            ...(plan.handoff && !plan.parked && !plan.setup && plan.handoff.mode !== "consult" ? ["The current assignment comes from a verified bot acting on an authenticated person's request. It grants no additional permission."] : []),
            ...(plan.handoff?.mode === "notify" ? ["This assignment has no result return to its sender."] : []),
            ...(handedGoal ? ["The current assignment is from the verified room coordinator acting on the person's saved goal."] : []),
            ...(plan.setup || plan.childRestart || plan.parentResultWake || plan.handoff?.mode === "consult" ? [] : [plan.instructionsBeforeHistory, plan.instructionsAfterHistory])].join("\n\n"),
          tools: input.tools, call: (name, args, signal) => turns.tool(plan.threadId, turn, name, args, signal),
        }, { botId: input.botId, messageId: turn.messageId, isCurrent });
        const dispatch = { type: "message.dispatch", commandId: mausbotOriginCommandId(plan.threadId, origin),
          threadId: plan.threadId, messageId: turn.messageId, text, attachments, modelSelection,
          dispatchMode: { type: "start_immediately" }, createdBy: "agent", creationSource: "server" } as const;
        const result = await run(deps.orchestrator.dispatch(dispatch).pipe(Effect.provideService(DispatchModeLimit, limit),
          Effect.provideService(MausbotOrigin, { command: dispatch, input: origin, botId, history,
            roomGoalSources, current: isCurrent, refresh: readNativeProof("Could not refresh the saved native room operation.", refresh) })));
        if (result.replayed) { turns.release(plan.threadId, turn); return { turnId: input.turnId, replayed: true }; }
        turn.refreshOriginReceipt = refresh;
        if (eventDelivery === "receipts") {
          for (const { event } of result.storedEvents) acceptEvent(event);
        }
        return { turnId: input.turnId };
      } catch (error) { turns.release(plan.threadId, turn); throw error; }
    }
    if (input.action === "start" && !input.trackCoordinatorRoot && !input.nativeOriginStart &&
        input.sharedContinuation && input.images.length === 0 &&
        (input.nativeIncidentNote ? input.nativeIncidentRetry && Boolean(input.text.trim()) : !input.text.trim())) {
      if (held?.resumeSource && stableStringify(held.input) === stableStringify(input) && !held.stopping && held.current()) {
        if (input.nativeIncidentRetry && !await held.refreshRetryReceipt?.())
          throw new Error("The failed-run retry receipt is uncertain.");
        return { turnId: input.turnId };
      }
      return resumeSaved(input, owner, current, emit, readEnrollment);
    }
    if (input.action === "start" && (input.nativeIncidentRetry || input.nativeIncidentNote)) throw new Error("A native incident retry must resume the original failed execution.");
    if (input.action === "binding") {
      const saved = await run(deps.orchestrator.getThreadShell(threadId));
      if (!saved) return { locked: false };
      const thread = requireSavedBotThread(saved, threadId, savedMausProfileId(input.botId));
      const { bots } = await run(deps.settings.getSettings);
      const profile = resolveSavedMausProfile(bots, input.botId, true);
      if (profile?.projectId != null && profile.projectId !== thread.projectId) {
        const savedTask = await readEnrollment?.(input.botId, input.threadId);
        if (!savedTask || savedTask.botId !== input.botId || savedTask.threadId !== input.threadId ||
            savedTask.projectId !== profile.projectId || savedTask.threadProjectId !== thread.projectId) {
          throw new Error("The saved J1 bot profile is bound to a different project.");
        }
      }
      if (!current()) throw new Error("The bot runtime disconnected.");
      return { locked: true, projectId: thread.projectId };
    }
    if (input.action === "tool-result") { turns.result(threadId, owner, input.requestId, input.value); return {}; }
    if (input.action !== "start") {
      const turn = turns.owned(threadId, owner);
      if (input.action === "stop") {
        if (!turn.stopping) {
          turn.stopping = true;
          try { await run(deps.orchestrator.dispatch({ type: "thread.stop", commandId: command(), threadId })); }
          catch (error) { turn.stopping = false; throw error; }
        }
        // Durable Stop acceptance is not native completion. The matching terminal event releases the turn.
      } else if (input.action === "interrupt") {
        const projection = await run(deps.orchestrator.getThreadProjection(threadId));
        const activeRun = projection.runs.find(row => row.id === turn.runId);
        const providerTurn = projection.providerTurns.find(row => activeRun?.activeAttemptId !== null && row.runAttemptId === activeRun?.activeAttemptId && row.status === "running");
        const providerThread = projection.providerThreads.find(row => row.id === providerTurn?.providerThreadId);
        if (!providerTurn || !providerThread?.providerSessionId) throw new Error("The owned provider turn is not active.");
        await run(deps.control.interrupt({ threadId, providerThreadId: providerThread.id, providerSessionId: providerThread.providerSessionId, providerTurnId: providerTurn.id }));
      } else {
        const requestId = RuntimeRequestId.make(input.requestId);
        if (turn.requests.get(requestId) !== (input.action === "answer" ? "user_input" : "approval"))
          throw new Error("This request does not belong to the active bot turn.");
        if (input.action === "respond" && turn.compatibilityOwner) {
          await run(deps.orchestrator.dispatch(
            compatibilityApprovalCommand(turn.compatibilityOwner, requestId, input.decision),
          ).pipe(Effect.provideService(CompatibilityApprovalOwner, turn.compatibilityOwner)));
        } else {
          await run(deps.orchestrator.dispatch({ type: "runtime-request.respond", commandId: command(), threadId, requestId,
            ...(input.action === "answer" ? { answers: decodeProviderAnswers(input.answers) } : { decision: input.decision }) }));
        }
        // Keep the request pending until the projected resolution, permitting a safe retry on failed dispatch.
      }
      return {};
    }
    const receiptHeld = turns.get(threadId);
    if (receiptHeld?.refreshOriginReceipt && receiptHeld.owner === owner && receiptHeld.current() && !receiptHeld.stopping &&
        stableStringify(input) === stableStringify(receiptHeld.input) && await receiptHeld.refreshOriginReceipt())
      return { turnId: input.turnId };
    const claimed = turns.claim(input, owner, current, emit);
    const turn = claimed.turn;
    const createdImagePaths: string[] = [];
    let canRemoveImages = true;
    try {
      const botId = savedMausProfileId(input.botId);
      const saved = await run(deps.orchestrator.getThreadShell(threadId));
      const existing = saved ? requireSavedBotThread(saved, threadId, botId) : null;
      if (input.projectId && existing && input.projectId !== existing.projectId)
        throw new Error("Start a new bot thread to change its project; the existing session is preserved.");
      if (existing?.activeRunId != null || existing?.pendingRuntimeRequest != null)
        throw new Error("This bot thread already has an active V2 run or a pending request.");
      const emptyHistory = !existing || (existing.itemCount === 0 && existing.latestRunId === null);
      const replayHint = Boolean(input.transcript?.length || input.recoveryText?.trim());
      const needsOwnedHistory = input.nativeOriginStart || emptyHistory || (!input.sharedContinuation && replayHint);
      const captureOwnedHistory = needsOwnedHistory || input.trackCoordinatorRoot;
      if (input.trackCoordinatorRoot && (!readEnrollment || input.nativeOriginStart))
        throw new Error("The authored coordinator root requires the private native intake.");
      if (input.nativeOriginStart && (!readEnrollment || input.sharedContinuation || input.images.length ||
          input.transcript !== undefined || input.recoveryText !== undefined)) {
        throw new Error("The coordinator start requires a private current input and no replay payload.");
      }
      if (needsOwnedHistory && !readEnrollment && (replayHint || input.sharedContinuation))
        throw new Error(executionV2IntegrationGaps.history);
      const settings = await run(deps.settings.getSettings);
      let profile = resolveSavedMausProfile(settings.bots, input.botId, existing !== null || readEnrollment !== undefined);
      const requestedProject = existing?.projectId ?? input.projectId;
      const requestsOverride = profile?.projectId != null &&
        requestedProject !== undefined && requestedProject !== profile.projectId;
      const optionalRootTracking = Boolean(input.trackCoordinatorRoot && existing && !needsOwnedHistory && !requestsOverride);
      const savedTask = ((!existing && !profile) || requestsOverride || captureOwnedHistory) && readEnrollment
        ? await readEnrollment(input.botId, input.threadId).catch((error: unknown) => {
            if (optionalRootTracking) return null;
            throw error;
          })
        : null;
      const enrollment = !existing && !profile ? savedTask : null;
      if (!existing && !profile && !enrollment)
        throw new Error("The saved Maus bot has no authorized J1 bot profile.");
      const runtimeMode = nativeBotRuntimeMode(input.approvalMode);
      if (savedTask &&
          (savedTask.botId !== input.botId || savedTask.threadId !== input.threadId ||
            savedTask.threadSelection.instanceId !== input.instanceId ||
            savedTask.threadSelection.model !== input.model ||
            savedTask.threadVariant !== input.variant ||
            (requestedProject !== undefined &&
              (savedTask.threadProjectId !== null || input.projectId !== undefined || requestsOverride) &&
              requestedProject !== savedTask.threadProjectId) ||
            isRuntimeModeAbove(runtimeMode, nativeBotRuntimeMode(savedTask.approvalMode)) ||
            (savedTask.restrictedTools && !input.restrictedTools))) {
        throw new Error("The bot turn does not match the saved native enrollment selection or limits.");
      }
      const boundProject = profile?.projectId ?? enrollment?.projectId;
      const selectedProjectId =
        requestedProject ?? savedTask?.threadProjectId ?? boundProject;
      const override = boundProject != null && selectedProjectId !== boundProject
        ? boundProject
        : undefined;
      if (override) {
        if (!savedTask || savedTask.projectId !== override || savedTask.threadProjectId !== selectedProjectId) {
          throw new Error("The saved J1 bot profile is bound to a different project.");
        }
        const source = Option.getOrUndefined(await run(deps.projects.getShell(override)));
        if (!source || source.id !== override || source.archivedAt != null) {
          throw new Error("The saved native default project is unavailable.");
        }
      }
      const projects = selectedProjectId ? [] : (await run(deps.projects.listShells())).filter(row =>
        row.archivedAt == null && sameWorkspace(input.cwd, row.workspaceRoot),
      );
      const project = selectedProjectId
        ? Option.getOrUndefined(await run(deps.projects.getShell(selectedProjectId)))
        : projects.length === 1 ? projects[0] : undefined;
      if (!project || project.archivedAt != null || (selectedProjectId && project.id !== selectedProjectId))
        throw new Error("The selected J1 project is unavailable or ambiguous.");
      const cwd = existing?.worktreePath ?? project.workspaceRoot;
      if (!sameWorkspace(input.cwd, cwd))
        throw new Error("The bot workspace does not match its saved project binding.");

      const instance = await run(deps.instances.getInstance(input.instanceId));
      if (!instance?.enabled || instance.instanceId !== input.instanceId ||
          !resolveProjectProviderInstanceEnabled(settings, project.id, input.instanceId))
        throw new Error("The selected shared provider account is unavailable for this project.");
      const provider = await run(instance.snapshot.getSnapshot);
      if (!supportsBotStart(provider, input))
        throw new Error("The selected shared provider account or model is unavailable.");
      const options = sharedModelOptions(provider, input.model, input.effort, input.variant);
      const modelSelection = { instanceId: input.instanceId, model: input.model, ...(options.length ? { options } : {}) };
      if (provider.supportedRuntimeModes && !provider.supportedRuntimeModes.includes(runtimeMode))
        throw new Error("The selected provider account does not support this approval mode.");
      if (isRuntimeModeAbove(runtimeMode, deps.settings.managedPolicy?.limits?.maxRuntimeMode))
        throw new Error("The selected approval mode exceeds the managed J1 runtime limit.");
      const historyRequest = captureOwnedHistory && readEnrollment && (!optionalRootTracking || savedTask)
        ? {
            turnId: input.turnId, attachmentsDir: deps.attachmentsDir,
            workspace: { projectId: project.id, root: cwd },
          }
        : undefined;
      const historySnapshot = historyRequest && readEnrollment
        ? await readEnrollment(input.botId, input.threadId, historyRequest).catch((error: unknown) => {
            if (optionalRootTracking) return null;
            throw error;
          })
        : null;
      const coldHistory = historySnapshot?.coldHistory;
      const nativeOrigin = coldHistory?.origin;
      const authoredRoot = nativeOrigin?.root === true && nativeOrigin.dispatch === "first";
      if (Boolean(input.trackCoordinatorRoot && (!optionalRootTracking || coldHistory)) !== authoredRoot ||
          Boolean(input.nativeOriginStart) !== Boolean(nativeOrigin && !authoredRoot) ||
          (nativeOrigin && (!coldHistory || !savedTask ||
            (authoredRoot ? coldHistory.authoredInputText !== input.text : coldHistory.promptText !== input.text) ||
            coldHistory.turnId !== input.turnId || (!authoredRoot && coldHistory.promptAttachments.length) ||
            nativeOrigin.approvalMode !== input.approvalMode || nativeOrigin.restrictedTools !== input.restrictedTools ||
            savedTask.threadSelection.instanceId !== input.instanceId || savedTask.threadSelection.model !== input.model ||
            savedTask.threadVariant !== input.variant))) {
        throw new Error("The saved coordinator execution does not own this input.");
      }
      if (nativeOrigin?.incidentBatch) {
        const ids = nativeOrigin.incidentBatch.reports.map(report => report.nativeMessageId);
        const expected = "incident-" + NodeCrypto.createHash("sha256")
          .update(JSON.stringify([input.botId, input.threadId, ids])).digest("hex");
        if (nativeOrigin.nodeId !== expected || nativeOrigin.requestId !== expected ||
            nativeOrigin.incidentBatch.reports.some(report => report.sourceThreadId === input.threadId)) {
          throw new Error("The Chief report batch does not belong to this native notices thread.");
        }
      }
      const rootSourceRow = nativeOrigin?.root
        ? authoredRoot ? coldHistory?.authoredSource : coldHistory?.messages.find(row =>
            row.nativeMessageId === nativeOrigin.sourceMessageId && row.role === "user")
        : undefined;
      if (nativeOrigin?.consultation && input.tools.length)
        throw new Error("The consultation cannot mount action tools.");
      if (nativeOrigin?.root && !rootSourceRow)
        throw new Error("The authored coordinator root is missing its exact saved message.");
      const privateHandoffGeneration = nativeOrigin?.privateHandoffGeneration ??
        (nativeOrigin?.dispatch === "first" ? nativeOrigin.nodeId : undefined);
      const originKey = nativeOrigin && {
        nodeId: nativeOrigin.nodeId, requestId: nativeOrigin.requestId, execution: nativeOrigin.execution,
        dispatch: nativeOrigin.dispatch, restarts: nativeOrigin.restarts,
        ...(nativeOrigin.computerSelection ? { computerSelection: nativeOrigin.computerSelection } : {}),
        ...(nativeOrigin.incidentBatch ? { incidentBatch: nativeOrigin.incidentBatch } : {}),
        ...(nativeOrigin.privateHandoffHash ? { privateHandoffHash: nativeOrigin.privateHandoffHash } : {}),
        ...(nativeOrigin.consultation ? { consultation: nativeOrigin.consultation } : {}),
        ...(nativeOrigin.privateHandoffHash || nativeOrigin.root ? {
          privateHandoffTurnId: input.turnId,
          ...(privateHandoffGeneration === undefined ? {} : { privateHandoffGeneration }),
        } : {}),
        ...(nativeOrigin.privateAnswers ? { privateAnswers: nativeOrigin.privateAnswers } : {}),
        ...(nativeOrigin.parkedStatus ? { parkedStatus: nativeOrigin.parkedStatus } : {}),
        ...(nativeOrigin.childRestart ? { childRestart: nativeOrigin.childRestart } : {}),
        ...(nativeOrigin.parentResultWake ? { parentResultWake: nativeOrigin.parentResultWake } : {}),
        ...(rootSourceRow ? { rootSource: { nativeMessageId: rootSourceRow.nativeMessageId,
          hash: coordinatorRowHash(rootSourceRow) } } : {}),
        sourceMessageId: nativeOrigin.root
          ? mausbotOriginInputId(threadId, { nodeId: nativeOrigin.nodeId, execution: 1 })
          : mausbotHistoryMessageId(threadId, nativeOrigin.sourceMessageId),
      };
      const priorProjection = originKey && existing && (originKey.dispatch !== "first" || originKey.incidentBatch || originKey.privateHandoffHash)
        ? await run(deps.orchestrator.getThreadProjection(threadId))
        : undefined;
      const warmAssignment = priorProjection && (originKey?.incidentBatch || originKey?.privateHandoffHash) &&
        (priorProjection.runs.length > 0 || priorProjection.providerThreads.length > 0 ||
          priorProjection.providerSessions.length > 0);
      const continuation = originKey && priorProjection
        ? originKey.incidentBatch ? incidentPredecessor(priorProjection, originKey, modelSelection)
          : (originKey.privateHandoffHash || originKey.parentResultWake || originKey.privateAnswers || originKey.parkedStatus || originKey.childRestart) ? privateHandoffPredecessor(priorProjection, originKey, modelSelection)
           : coordinatorPredecessor(priorProjection, originKey, modelSelection)
        : undefined;
      if (originKey && (originKey.dispatch !== "first" || warmAssignment) && !continuation)
        throw new Error("The coordinator execution has no exact settled predecessor on its original provider.");
      const exactText = authoredRoot && !needsOwnedHistory ? coldHistory?.authoredInputText : coldHistory?.promptText;
      const origin: MausbotOriginStart | undefined = originKey && coldHistory && exactText !== undefined ? {
        ...originKey,
        historyPrefix: coordinatorHistoryPrefix(coldHistory.messages),
        ...(continuation ? { continuation } : {}),
        text: exactText,
        attachments: coldHistory.promptAttachments,
        fingerprint: NodeCrypto.createHash("sha256").update(stableStringify({
          origin: nativeOrigin, history: coldHistory.messages,
          text: exactText,
          attachments: coldHistory.promptAttachments, system: input.system,
          botId: input.botId, threadId, projectId: project.id, cwd, modelSelection,
          approvalMode: input.approvalMode, restrictedTools: input.restrictedTools,
          tools: [...input.tools].sort((a, b) => a.name.localeCompare(b.name)),
        })).digest("hex"),
      } : undefined;
      if (origin?.parentResultWake && (!coldHistory || !continuation || !privateResultWakeInput(origin, coldHistory.messages, threadId)))
        throw new Error("The private result wake does not own its original assignment.");
      if (origin?.childRestart && (!coldHistory || !continuation || !privateRestartInput(origin, coldHistory.messages, threadId)))
        throw new Error("The private restart does not own its original saved assignment.");
      if (origin?.parkedStatus && (!coldHistory || !continuation || !privateStatusHistory(origin, coldHistory.messages)))
        throw new Error("The team setup status does not own the saved native cards.");
      if (origin?.privateAnswers && coldHistory && !privateAnswerHistory(origin, coldHistory.messages))
        throw new Error("The private answers do not match the saved assignment history.");
      if (origin?.privateHandoffHash && coldHistory && !continuation &&
          !privateHandoffInput(origin, coldHistory.messages, threadId))
        throw new Error("The private assignment has saved history without a settled provider owner.");
      if (origin) turn.messageId = mausbotOriginInputId(threadId, origin);
      if (historyRequest && (!optionalRootTracking || coldHistory) &&
          (!savedTask || !coldHistory || coldHistory.turnId !== input.turnId ||
          JSON.stringify({ ...historySnapshot, coldHistory: undefined }) !==
            JSON.stringify({ ...savedTask, coldHistory: undefined }))) {
        throw new Error(executionV2IntegrationGaps.history);
      }
      if (!(coldHistory?.promptText ?? input.text).trim() &&
          (coldHistory?.promptAttachments ?? input.images).length === 0)
        throw new Error("A bot turn needs a message or an attachment.");
      if (coldHistory) {
        const segment = toSafeThreadAttachmentSegment(threadId);
        const historical = coldHistory.messages.flatMap(row => row.attachments);
        for (const attachment of [...historical, ...coldHistory.promptAttachments]) {
          const filepath = resolveAttachmentPath({ attachmentsDir: deps.attachmentsDir, attachment });
          if (!filepath || !segment || parseThreadSegmentFromAttachmentId(attachment.id) !== segment)
            throw new Error("A saved bot history attachment does not belong to this thread.");
          const stat = await NodeFSP.lstat(filepath);
          if (!stat.isFile() || stat.size !== attachment.sizeBytes)
            throw new Error("A staged bot history attachment is unavailable.");
        }
      }
      const interactionMode = existing?.interactionMode ?? "default";
      const limit = { runtimeMode, interactionMode };
      turns.owned(threadId, owner);

      const attachments = coldHistory?.promptAttachments ?? await imageAttachments(
        input, threadId, deps.attachmentsDir, createdImagePaths,
        (message) => run(Effect.logWarning(message)),
      );
      turns.owned(threadId, owner);

      if (enrollment) {
        const defaults = enrollment.modelSelection;
        const defaultInstance = await run(deps.instances.getInstance(defaults.instanceId));
        if (!defaultInstance?.enabled || defaultInstance.instanceId !== defaults.instanceId ||
            !resolveProjectProviderInstanceEnabled(settings, enrollment.projectId, defaults.instanceId)) {
          throw new Error("The saved native default account is unavailable for enrollment.");
        }
        const defaultProvider = await run(defaultInstance.snapshot.getSnapshot);
        if (!supportsBotStart(defaultProvider, defaults)) {
          throw new Error("The saved native default account or model is unavailable for enrollment.");
        }
        const defaultOptions = sharedModelOptions(
          defaultProvider,
          defaults.model,
          undefined,
          enrollment.defaultVariant,
        );
        const now = DateTime.formatIso(DateTime.nowUnsafe());
        const candidate = decodeBotProfile({
          id: botId,
          name: enrollment.name,
          description: enrollment.description,
          instructions: enrollment.instructions,
          projectId: enrollment.projectId,
          modelSelection: {
            ...defaults,
            ...(defaultOptions.length ? { options: defaultOptions } : {}),
          },
          createdAt: now,
          updatedAt: now,
          pinned: false,
          archived: false,
        });
        turns.owned(threadId, owner);
        const write = await run(deps.settings.insertBotProfileIfAbsent(candidate).pipe(Effect.result));
        const persisted = write._tag === "Success" ? write.success : await run(deps.settings.getSettings);
        const winner = resolveSavedMausProfile(persisted.bots, input.botId, true);
        if (!winner && write._tag === "Failure") throw write.failure;
        if (!winner || !matchesEnrollmentWinner(winner, candidate)) {
          throw new Error("A different saved J1 bot profile won enrollment.");
        }
        if (!resolveProjectProviderInstanceEnabled(persisted, project.id, input.instanceId) ||
            !resolveProjectProviderInstanceEnabled(persisted, enrollment.projectId, defaults.instanceId)) {
          throw new Error("The saved provider selection is no longer enabled.");
        }
        profile = winner;
        turns.owned(threadId, owner);
      }

      let thread = existing;
      if (!thread) {
        if (!profile) throw new Error("The saved Maus bot has no authorized J1 bot profile.");
        // The private command rechecks the saved profile and reserves the exact external thread id.
        const creationId = command();
        const creation = {
          type: "thread.bot.create", commandId: creationId, threadId, projectId: project.id,
          botId, title: profile.name, modelSelection, runtimeMode, interactionMode,
          branch: null, worktreePath: null, createdBy: "user", creationSource: "server",
        } as const;
        const proof = override && readEnrollment ? {
          command: creation,
          nativeBotId: input.botId,
          nativeThreadId: input.threadId,
          defaultProjectId: override,
          workspaceRoot: project.workspaceRoot,
          restrictedTools: input.restrictedTools,
          current: () => turns.get(threadId) === turn && current() && !turn.stopping,
          read: readNativeProof(
            "Could not refresh the saved native task project.",
            () => readEnrollment(input.botId, input.threadId),
          ).pipe(Effect.flatMap(saved => Effect.gen(function* () {
            if (!saved) return null;
            const task = yield* deps.instances.getInstance(saved.threadSelection.instanceId);
            const defaults = yield* deps.instances.getInstance(saved.modelSelection.instanceId);
            if (!task?.enabled || task.instanceId !== saved.threadSelection.instanceId ||
                !defaults?.enabled || defaults.instanceId !== saved.modelSelection.instanceId) return null;
            const taskProvider = yield* task.snapshot.getSnapshot;
            const defaultProvider = yield* defaults.snapshot.getSnapshot;
            if (!supportsBotStart(taskProvider, saved.threadSelection) ||
                !supportsBotStart(defaultProvider, saved.modelSelection) ||
                (taskProvider.supportedRuntimeModes &&
                  !taskProvider.supportedRuntimeModes.includes(runtimeMode))) return null;
            yield* Effect.try({
              try: () => {
                sharedModelOptions(defaultProvider, saved.modelSelection.model, undefined, saved.defaultVariant);
                sharedModelOptions(taskProvider, saved.threadSelection.model, input.effort, saved.threadVariant);
              },
              catch: (cause) => new MausbotNativeProofError({
                message: "Could not validate the saved native task model options.", cause,
              }),
            });
            return saved;
          }))),
        } : undefined;
        await run(deps.orchestrator.dispatch(creation).pipe(
          Effect.provideService(DispatchModeLimit, limit),
          Effect.provideService(MausbotProjectOverride, proof),
          Effect.catchTags({
            OrchestratorThreadAlreadyExistsError: error =>
              error.commandId === creationId && error.threadId === threadId ? Effect.void : Effect.fail(error),
          }),
        ));
        thread = requireSavedBotThread(await run(deps.orchestrator.getThreadShell(threadId)), threadId, botId);
        if (thread.projectId !== project.id || thread.worktreePath !== null || thread.branch !== null ||
            (enrollment && thread.bot.name !== profile.name) ||
            thread.providerInstanceId !== modelSelection.instanceId ||
            !modelSelectionsEqual(thread.modelSelection, modelSelection) ||
            thread.runtimeMode !== runtimeMode || thread.interactionMode !== interactionMode ||
            thread.activeRunId !== null || thread.pendingRuntimeRequest !== null)
          throw new Error("The saved J1 thread does not match the authorized new bot thread.");
      }
      const refreshHistory = historyRequest && readEnrollment ? async () => {
        const currentProject = Option.getOrUndefined(await run(deps.projects.getShell(project.id)));
        const currentThread = await run(deps.orchestrator.getThreadShell(threadId));
        if (!currentProject || currentProject.id !== project.id || currentProject.archivedAt != null ||
            !sameWorkspace(currentProject.workspaceRoot, project.workspaceRoot) ||
            !currentThread || currentThread.projectId !== project.id ||
            currentThread.archivedAt != null || currentThread.deletedAt != null ||
            currentThread.bot?.id !== botId ||
            !sameWorkspace(currentThread.worktreePath ?? currentProject.workspaceRoot, cwd)) return null;
        turns.owned(threadId, owner);
        const refreshed = await readEnrollment(input.botId, input.threadId, historyRequest);
        return JSON.stringify(refreshed) === JSON.stringify(historySnapshot) ? refreshed : null;
      } : undefined;
      const [firstHistoryRow, ...restHistory] = coldHistory?.messages ?? [];
      if (coldHistory && firstHistoryRow && refreshHistory && needsOwnedHistory && !continuation) {
        const history: MausbotHistoryImportCommand = {
          type: "thread.bot.history.import", commandId: mausbotHistoryCommandId(threadId),
          threadId, botId, messages: [firstHistoryRow, ...restHistory],
        };
        turns.owned(threadId, owner);
        await run(deps.orchestrator.dispatch(history).pipe(
          Effect.provideService(MausbotHistoryImport, {
            command: history, botId: input.botId, threadId: input.threadId,
            turnId: input.turnId, anchorMessageId: coldHistory.anchorMessageId,
            promptText: coldHistory.promptText, promptAttachments: coldHistory.promptAttachments,
            current: () => turns.get(threadId) === turn && current() && !turn.stopping,
            read: readNativeProof("Could not refresh the saved native task for history import.", refreshHistory),
          }),
        ));
      } else if (coldHistory?.promptAttachments.length && refreshHistory && !await refreshHistory()) {
        throw new Error(executionV2IntegrationGaps.history);
      }
      if (origin && thread.runtimeMode !== runtimeMode)
        throw new Error("The saved coordinator runtime mode changed.");
      if (existing && thread.runtimeMode !== runtimeMode) {
        // Setting the explicit caller-selected mode also lets a higher saved mode be lowered.
        // The actual turn below still carries the caller's ceiling into the locked writer.
        await run(deps.orchestrator.dispatch({ type: "thread.runtime-mode.set", commandId: command(), threadId, runtimeMode }));
      }
      turns.owned(threadId, owner);
      const isCurrent = () => turns.get(threadId) === turn && turn.current() && !turn.stopping;
      const submissionOwner = {
        botId: input.botId,
        nativeThreadId: input.threadId,
        nativeTurnId: input.turnId,
        current: isCurrent,
      };
      if (!origin) {
        turn.compatibilityOwner = submissionOwner;
        turn.messageId = compatibilityMessageId(submissionOwner);
      }
      const refreshOrigin = async () => {
        if (!origin || !isCurrent() || !refreshHistory || !await refreshHistory()) return false;
        const shell = await run(deps.orchestrator.getThreadShell(threadId));
        if (origin.continuation) {
          const projection = await run(deps.orchestrator.getThreadProjection(threadId));
          const target = origin.incidentBatch ? incidentPredecessor(projection, origin, modelSelection)
            : (origin.privateHandoffHash || origin.parentResultWake || origin.privateAnswers || origin.parkedStatus || origin.childRestart) ? privateHandoffPredecessor(projection, origin, modelSelection, origin)
             : coordinatorPredecessor(projection, origin, modelSelection);
          if (!matchesCoordinatorContinuation(origin.continuation, target) ||
              shell?.activeProviderThreadId !== origin.continuation.providerThreadId) return false;
        }
        const settings = await run(deps.settings.getSettings);
        const instance = await run(deps.instances.getInstance(input.instanceId));
        const profile = resolveSavedMausProfile(settings.bots, input.botId, true);
        if (!instance?.enabled || !resolveProjectProviderInstanceEnabled(settings, project.id, input.instanceId))
          return false;
        const snapshot = await run(instance.snapshot.getSnapshot);
        if (!supportsBotStart(snapshot, input) ||
            (snapshot.supportedRuntimeModes && !snapshot.supportedRuntimeModes.includes(runtimeMode)) ||
            stableStringify(sharedModelOptions(snapshot, input.model, input.effort, input.variant)) !==
              stableStringify(options)) return false;
        return isCurrent() && shell?.projectId === project.id && shell.runtimeMode === runtimeMode &&
          shell.interactionMode === interactionMode && shell.bot?.id === botId &&
          shell.providerInstanceId === input.instanceId && modelSelectionsEqual(shell.modelSelection, modelSelection) &&
          (!profile?.projectId || profile.projectId === project.id || profile.projectId === savedTask?.projectId) &&
          !isRuntimeModeAbove(runtimeMode, deps.settings.managedPolicy?.limits?.maxRuntimeMode);
      };
      turn.releaseContext = registerBotExecutionContext(threadId, {
        ...(origin ? { origin: { input: origin, refresh: refreshOrigin } } : {}),
        restrictedTools: input.restrictedTools,
        prompt: [input.system, `You are ${thread.bot.name}. Work as this bot in its original conversation.`, `J1 execution workspace: ${cwd}.`, "Use bot_tools and bot_call for this bot's selected tools and team. Preserve its original identity, tool scope and delivery receipts."].filter(Boolean).join("\n\n"),
        tools: input.tools,
        call: (name, arguments_, signal) => turns.tool(threadId, turn, name, arguments_, signal),
      }, {
        botId: input.botId,
        messageId: turn.messageId,
        isCurrent: () => turns.get(threadId) === turn && turn.current() && !turn.stopping,
      });
      const dispatch: Extract<OrchestrationV2Command, { type: "message.dispatch" }> = {
        type: "message.dispatch",
        commandId: origin ? mausbotOriginCommandId(threadId, origin) : compatibilityStartCommandId(submissionOwner),
        threadId, messageId: turn.messageId, text: origin?.text ?? coldHistory?.promptText ?? input.text, attachments, modelSelection,
        dispatchMode: { type: "start_immediately" }, createdBy: origin && !authoredRoot ? "agent" : "user", creationSource: "server",
      };
      // Once dispatch begins, preserve files unless V2 explicitly proves refusal.
      // A generic dispatch error can follow a durable commit.
      canRemoveImages = false;
      const result = await run(deps.orchestrator.dispatch(dispatch).pipe(
        Effect.tapError((error) => Effect.sync(() => {
          canRemoveImages =
            (error._tag === "OrchestratorCommandPreviouslyRejectedError" ||
              error._tag === "OrchestratorThreadAboveModeLimitError" ||
              error._tag === "OrchestratorRuntimeModeAboveCeilingError") &&
            error.commandId === dispatch.commandId;
        })),
        Effect.provideService(DispatchModeLimit, limit),
        Effect.provideService(CompatibilityApprovalOwner, turn.compatibilityOwner),
        Effect.provideService(MausbotOrigin, origin ? {
          command: dispatch, input: origin, botId, current: isCurrent,
          history: coldHistory?.messages ?? [],
          refresh: readNativeProof("Could not refresh the saved native assignment.", refreshOrigin),
        } : undefined),
      ));
      if (turn.compatibilityOwner && result.replayed) {
        canRemoveImages = true;
        throw new Error("This bot turn was already submitted.");
      }
      if (origin && result.replayed) {
        turns.release(threadId, turn);
        return { turnId: input.turnId, replayed: true };
      }
      if (origin) turn.refreshOriginReceipt = refreshOrigin;
      if (eventDelivery === "receipts") {
        for (const { event } of result.storedEvents) acceptEvent(event);
      }
      return { turnId: input.turnId };
    } catch (error) {
      try {
        if (canRemoveImages) {
          const cleanup = await Promise.allSettled(createdImagePaths.map((path) =>
            NodeFSP.rm(path, { force: true }),
          ));
          if (cleanup.some((result) => result.status === "rejected")) {
            await run(Effect.logWarning("Could not remove one or more uncommitted bot image attachments."));
          }
        }
      } finally {
        turns.release(threadId, turn);
      }
      throw error;
    }
  };
  const gates = new Map<ThreadId, Promise<void>>();
  const serial = async <A>(threadId: ThreadId, work: () => Promise<A>): Promise<A> => {
    const prior = gates.get(threadId) ?? Promise.resolve();
    let unlock: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const chained = prior.then(() => gate);
    gates.set(threadId, chained);
    await prior;
    try { return await work(); }
    finally { unlock?.(); if (gates.get(threadId) === chained) gates.delete(threadId); }
  };
  const call: ExecutionV2Call = async (raw, current, emit, owner, readEnrollment, readRoomEnrollment, stageRoomTurn) => {
    const isCurrent = () => !closed && !retiredOwners.has(owner) && current();
    if (owner === null || typeof owner !== "object" || !isCurrent()) throw new Error("The bot runtime disconnected.");
    const input = Schema.decodeUnknownSync(invocation)(raw, { onExcessProperty: "error" });
    return "botId" in input
      ? serial(botExecutionThreadIdV2(input.botId, input.threadId), () => invoke(input, isCurrent, emit, owner, readEnrollment, readRoomEnrollment, stageRoomTurn))
      : invoke(input, isCurrent, emit, owner, readEnrollment);
  };
  const disconnect = (owner: MausbotExecutionOwner): Promise<void> => {
    const existing = retiredOwners.get(owner);
    if (existing) return existing;
    subscribers.delete(owner);
    const operation = Promise.allSettled(turns.forOwner(owner).map(([threadId, turn]) =>
      serial(botExecutionThreadIdV2(turn.input.botId, turn.input.threadId), async () => {
        if (turns.get(threadId) !== turn) return;
        try {
          if (!turn.stopping) await run(deps.orchestrator.dispatch({ type: "thread.stop", commandId: command(), threadId }));
        } finally {
          turns.release(threadId, turn);
        }
      }),
    )).then(results => {
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length > 0) throw new AggregateError(failures, "Some owned V2 executions could not be stopped.");
    }).finally(() => disconnecting.delete(owner));
    retiredOwners.set(owner, operation);
    disconnecting.add(owner);
    return operation;
  };

  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    subscribers.clear();
    closing = Promise.allSettled([...new Set([...turns.owners(), ...disconnecting.keys()])].map(disconnect))
      .then(results => {
        const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
        if (failures.length > 0) throw new AggregateError(failures, "Some bot owners could not be stopped.");
      });
    return closing;
  };

  return { call, disconnect, close, acceptEvent, turns,
    async catalogChanged(signal) {
      if (closed || signal?.aborted || subscribers.size === 0) return;
      const recipients = [...subscribers];
      const snapshot = await catalog();
      if (closed || signal?.aborted) return;
      for (const [owner, sub] of recipients) {
        if (subscribers.get(owner) !== sub) continue;
        if (!sub.current()) subscribers.delete(owner);
        else {
          try { sub.emit({ kind: "catalog", providers: snapshot }); }
          catch { subscribers.delete(owner); }
        }
      }
    },
  };
}
