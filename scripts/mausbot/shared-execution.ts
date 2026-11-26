// Copied into the captured runtime. Provider accounts and agent processes stay
// in J1; the original bot harness retains its tool scopes, approvals and UI.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inSecretFolder } from "../secret-folder.ts";
import type { ModelCatalog, ProviderDriver, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { newEventId } from "../contracts.ts";
import { mountChatTools, type ChatToolSession } from "./chat-mcp-tools.ts";
import { createChatToolApproval, refusal } from "./chat-tool-approval.ts";
import {
  sharedExecutionRequest,
  sharedCatalog as catalog,
  onSharedExecution,
  sharedObject as object,
  type SharedObject as ObjectValue,
} from "./j1-shared-client.ts";
export { sharedExecutionRequest } from "./j1-shared-client.ts";
export { encodeSharedModel } from "../j1-shared-selection.ts";
import { encodeSharedModel } from "../j1-shared-selection.ts";

type EventInput<T = RuntimeEvent> = T extends RuntimeEvent
  ? Omit<T, "eventId" | "provider" | "threadId" | "createdAt">
  : never;
export function decodeSharedModel(value: string) {
  const separator = value.indexOf(":");
  if (separator < 1 || separator === value.length - 1)
    throw new Error("Select an account and model from J1's shared catalog.");
  return {
    instanceId: decodeURIComponent(value.slice(0, separator)),
    model: decodeURIComponent(value.slice(separator + 1)),
  };
}

type Turn = {
  input: SendTurnInput;
  turnId: string;
  controller: AbortController;
  tools: ChatToolSession | null;
  approvals: ReturnType<typeof createChatToolApproval>;
  questions: Map<string, string[]>;
  assistant: Map<string, string>;
  sessionAnnounced: boolean;
  sent: boolean;
  errorReported: boolean;
  toolCalls: Map<string, AbortController>;
};

export interface NativeIncidentBatch {
  readonly generation: string;
  readonly reports: readonly {
    readonly nativeMessageId: string;
    readonly sourceBotId: string;
    readonly sourceThreadId: string;
    readonly sourceBotName: string;
    readonly textHash: string;
    readonly notified: boolean;
  }[];
}

export function savedIncidentReports(path: ReadonlyArray<SavedHistoryLine>, ids: readonly string[], recipientThreadId: string, recipientBotId: string) {
  const rows = path.filter(row => row.kind !== "activity" || row.attachments?.length);
  const suffix = rows.slice(-ids.length);
  if (!ids.length || new Set(ids).size !== ids.length || suffix.length !== ids.length) return undefined;
  const reports = [];
  for (const [index, row] of suffix.entries()) {
    const ask = row.peerAsk;
    if (row.id !== ids[index] || row.role !== "user" || row.kind !== "text" || row.sender ||
        row.requestCancelled || row.attachments?.length || !row.text?.trim() ||
        !ask?.unattended || !ask.incident || !ask.botId || !ask.incident.threadId ||
        ask.incident.threadId === recipientThreadId ||
        ask.incident.j1Recipient?.threadId !== recipientThreadId ||
        ask.incident.j1Recipient.botId !== recipientBotId) return undefined;
    reports.push({ nativeMessageId: row.id, sourceBotId: ask.botId, sourceThreadId: ask.incident.threadId,
      sourceBotName: ask.name, notified: ask.incident.notified === true,
      textHash: NodeCrypto.createHash("sha256").update(row.text).digest("hex") });
  }
  return reports;
}

export interface NativeAssignmentOrigin {
  readonly incidentBatch?: NativeIncidentBatch;
  readonly privateHandoffHash?: string;
  readonly parkedStatus?: { readonly kind: "team-setup" | "mcp-setup" | "mcp-oauth" | "app-connector" | "signin-ack" | "credential-status"; readonly priorGeneration: string; readonly priorTurnId: string;
    readonly privateReview?: { readonly person: string; readonly sourceId: string; readonly scopeHash: string };
    readonly decisions: readonly { cardId: string; requestId: string; actionHash: string;
      family?: "mcp" | "oauth" | "app" | "signin" | "credential"; flowId?: string; reviewHash?: string; group?: { id: string; cardIds: readonly string[] };
      state: "applied" | "denied" | "cancelled" | "failed" | "acknowledged" | "saved" }[];
    readonly mixed?: { readonly cardOrder: readonly string[];
      readonly questions: readonly { cardId: string; requestId: string; answer: string; person: string }[] }; };
  readonly consultation?: { readonly reply: "resume" | "poll"; readonly brief: string; readonly envelopeHash: string };
  readonly privateHandoffGeneration?: string;
  readonly parentResultWake?: {
    readonly root?: { readonly sourceMessageId: string; readonly sourceHash: string; readonly person: string };
    readonly priorGeneration: string;
    readonly priorTurnId: string;
    readonly execution: number;
    readonly priorStartedAt: number;
    readonly cutAt: number;
    readonly restarts?: number;
    readonly startedAt: number;
    readonly reports: readonly {
      inboxId: string; childId: string; childBotId: string; childThreadId: string;
      execution: number; finishedAt: number; reportedAt: number; resultHash: string; report: string;
    }[];
  };
  readonly childRestart?: {
    readonly rootResultHash?: string;
    readonly priorGeneration: string;
    readonly priorTurnId: string;
    readonly execution: number;
    readonly restarts: number;
    readonly priorStartedAt: number;
    readonly reconciledAt: number;
    readonly startedAt: number;
  };
  readonly privateAnswers?: {
    readonly priorTurnId: string;
    readonly priorGeneration: string;
    readonly answers: readonly { cardId: string; requestId: string; person: string; answer: string }[];
  };
  readonly root?: true;
  readonly nodeId: string;
  readonly requestId: string;
  readonly execution: number;
  readonly dispatch: "first" | "resume" | "rerun" | "computer";
  readonly computerSelection?: {
    readonly id: string;
    readonly sourceGeneration: string;
    readonly dispatchGeneration: string;
    readonly previousChoiceId?: string;
    readonly sourceSurface: "cloud" | "vm" | "local" | "browser" | null;
    readonly selected: "cloud" | "vm" | "local" | "browser";
    readonly previousSurface: "cloud" | "vm" | "local" | "browser" | null;
  };
  readonly restarts: number;
  readonly sourceMessageId: string;
  readonly approvalMode: NonNullable<SendTurnInput["approvalMode"]>;
  readonly restrictedTools: boolean;
}

export interface SavedHistoryAnchor {
  readonly messageId: string;
  readonly origin?: NativeAssignmentOrigin & { current(): boolean; stopped?(): boolean };
  readonly promptText: string;
  readonly authoredInputText?: string;
  readonly currentImages: ReadonlyArray<{ path: string; mime: string }>;
}

interface SavedHistoryLine {
  readonly id: string;
  readonly role: "user" | "bot";
  readonly kind: string;
  readonly text?: string;
  readonly at: number;
  readonly turnCompletedAt?: number;
  readonly j1ProviderMessageId?: string;
  readonly j1CoordinatorRootId?: string;
  readonly j1ComputerSelections?: ReadonlyArray<
    Omit<NonNullable<NativeAssignmentOrigin["computerSelection"]>, "dispatchGeneration"> &
    { readonly dispatchGeneration?: string }
  >;
  readonly roomRequest?: { readonly id: string; readonly phase: string };
  readonly requestCancelled?: boolean;
  readonly sender?: unknown;
  readonly peerAsk?: { botId: string; name: string; unattended?: boolean; incident?: { threadId: string; notified?: boolean; j1Recipient?: { botId: string; threadId: string } } };
  readonly attachments?: ReadonlyArray<{
    kind: "image" | "audio" | "file";
    path: string;
    mime: string;
    name?: string;
  }>;
}

export type NativeRoomMemberRead = (turnId: string) => unknown;

const roomTurns = new Map<string, {
  botId: string; threadId: string; signal: AbortSignal; read: NativeRoomMemberRead;
}>();

export function readOwnedNativeRoomTurn(
  owner: { botId: string; threadId: string; signal: AbortSignal; read: NativeRoomMemberRead } | undefined,
  botId: string, threadId: string, turnId: string,
) {
  if (!owner || owner.signal.aborted || owner.botId !== botId || owner.threadId !== threadId) return null;
  return owner.read(turnId);
}

export interface NativeIncidentRetryNote {
  id: string; chiefId: string; chiefThreadId: string; text: string;
}

const resumeTurns = new Map<string, {
  botId: string; threadId: string; cursor: string; signal: AbortSignal; current(): boolean; incidentFailure?: string; incidentNote?: NativeIncidentRetryNote;
}>();

const historyTurns = new Map<string, {
  botId: string; threadId: string; anchor: SavedHistoryAnchor; signal: AbortSignal;
}>();

type SavedAttachmentRoots = {
  readonly managed: string;
  readonly workspace?: string;
  readonly bot?: string;
};

function ownedAttachmentReference(path: string, roots: SavedAttachmentRoots) {
  const invalid = () => new Error("A saved attachment is outside the native file scope.");
  const segments = (name: string) => {
    const parts = name.split(/[\\\\/]/u);
    if (inSecretFolder(name) || parts.some(part => !part || part === "." || part === ".." || part.length > 255 ||
        /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu.test(part) ||
        /[:*?"<>|\u0000-\u001f]/u.test(part) || part.endsWith(".") || part.endsWith(" "))) throw invalid();
    return parts;
  };
  const prefix = "/api/attachments/";
  const reference = (root: keyof SavedAttachmentRoots, name: string) => {
    const parts = segments(name);
    const base = roots[root];
    if (!base || (root === "managed" && parts.length !== 1) ||
        inSecretFolder(NodePath.join(base, ...parts))) throw invalid();
    return { root, filename: parts.join("/") };
  };
  if (path.startsWith(prefix)) return reference("managed", path.slice(prefix.length));
  // Reject traversal before file URL parsing can normalize it away.
  const asFileUrl = path.startsWith("file:");
  const spelling = asFileUrl ? decodeURIComponent(path) : path;
  if (/(?:^|[\\\\/])\.{1,2}(?:[\\\\/]|$)/u.test(spelling)) throw invalid();
  let local = path;
  if (asFileUrl) {
    const url = new URL(path);
    if (url.username || url.password || url.port || url.search || url.hash) throw invalid();
    local = fileURLToPath(url);
  }
  if (/^[\\\\/]{2}[.?][\\\\/]/u.test(local)) throw invalid();
  if (NodePath.isAbsolute(local)) {
    for (const root of ["managed", "bot", "workspace"] as const) {
      const base = roots[root];
      if (!base) continue;
      const relative = NodePath.relative(base, local);
      if (relative && relative !== ".." && !relative.startsWith(".." + NodePath.sep) &&
          !NodePath.isAbsolute(relative)) return reference(root, relative);
    }
    throw invalid();
  }
  const parts = segments(local);
  // Bare blob names were used by the native upload store before workspace references.
  if (parts.length === 1 && existsSync(NodePath.join(roots.managed, local))) return reference("managed", local);
  for (const root of ["workspace", "bot"] as const) {
    const base = roots[root];
    if (base && existsSync(NodePath.join(base, ...parts))) return reference(root, local);
  }
  if (parts.length === 1) return reference("managed", local);
  throw invalid();
}

export function savedHistoryForTurn(
  path: ReadonlyArray<SavedHistoryLine>,
  anchor: SavedHistoryAnchor,
  attachmentRoots: SavedAttachmentRoots,
) {
  const origin = anchor.origin;
  const authoredRoot = origin?.root === true && origin.dispatch === "first";
  const index = path.findIndex(line => line.id === anchor.messageId && (origin?.incidentBatch
    ? line.role === "user" && Boolean(line.peerAsk?.incident)
    : origin?.root
    ? line.role === "user" && line.j1CoordinatorRootId === origin.nodeId
    : origin
      ? line.role === "bot" && line.roomRequest?.id === origin.requestId && line.roomRequest.phase === "request"
      : line.role === "user"));
  if (index < 0 || ((!origin || origin.dispatch === "first") &&
      path.slice(index + 1).some(line => line.kind !== "activity" || Boolean(line.attachments?.length)))) {
    throw new Error("The active native branch moved beyond the current message.");
  }
  const nativeAttachment = (attachment: NonNullable<SavedHistoryLine["attachments"]>[number]) => {
    const reference = ownedAttachmentReference(attachment.path, attachmentRoots);
    return {
      ...reference, name: attachment.name ?? NodePath.basename(reference.filename), mime: attachment.mime,
      type: attachment.kind === "image" ? "image" : "file",
    };
  };
  const choice = origin?.computerSelection;
  const choices = path[index]?.j1ComputerSelections;
  const choiceIndex = (origin?.execution ?? 0) - 2;
  const savedChoice = choices?.[choiceIndex];
  const previousChoice = choiceIndex > 0 ? choices?.[choiceIndex - 1] : undefined;
  if ((origin?.dispatch === "computer") !== Boolean(choice) ||
      (choice && (!savedChoice || savedChoice.id !== choice.id ||
        savedChoice.sourceGeneration !== choice.sourceGeneration || savedChoice.dispatchGeneration !== choice.dispatchGeneration ||
        savedChoice.selected !== choice.selected || savedChoice.previousSurface !== choice.previousSurface ||
        savedChoice.sourceSurface !== choice.sourceSurface || savedChoice.previousChoiceId !== choice.previousChoiceId ||
        (choiceIndex > 0
          ? !previousChoice || previousChoice.id !== choice.previousChoiceId ||
            previousChoice.dispatchGeneration !== choice.sourceGeneration || previousChoice.selected !== choice.sourceSurface
          : choice.previousChoiceId !== undefined || choice.sourceGeneration !== origin?.nodeId) ||
        path.findLast(line => line.role === "user" && line.kind === "text")?.id !== anchor.messageId))) {
    throw new Error("The native computer selection no longer owns this branch.");
  }
  if (origin && (!origin.current() || origin.sourceMessageId !== anchor.messageId ||
      (!authoredRoot && anchor.currentImages.length))) {
    throw new Error("The coordinator assignment does not own this saved input.");
  }
  const promptAttachments = origin && !authoredRoot ? [] : (path[index]?.attachments ?? []).map(nativeAttachment);
  for (const image of anchor.currentImages) {
    const saved = nativeAttachment({ ...image, kind: "image" });
    if (!promptAttachments.some(item => item.root === saved.root && item.filename === saved.filename &&
        item.type === "image" &&
        item.mime === saved.mime)) {
      throw new Error("The current image was not saved on the anchored native message.");
    }
  }
  const toRow = (line: SavedHistoryLine) => {
    if (!Number.isSafeInteger(line.at) || (line.turnCompletedAt !== undefined &&
        (!Number.isSafeInteger(line.turnCompletedAt) || line.turnCompletedAt < line.at))) {
      throw new Error("A saved native message has an invalid timestamp.");
    }
    return {
      nativeMessageId: line.id,
      ...(origin && line.j1ProviderMessageId ? { mirrorMessageId: line.j1ProviderMessageId } : {}),
      createdAt: new Date(line.at).toISOString(),
      completedAt: line.turnCompletedAt === undefined ? null : new Date(line.turnCompletedAt).toISOString(),
      role: line.role === "user" ? "user" : "assistant",
      text: line.text ?? "",
      attachments: (line.attachments ?? []).map(nativeAttachment),
    };
  };
  const messages = (origin && !authoredRoot ? path : path.slice(0, index)).map(toRow);
  return {
    anchorMessageId: anchor.messageId, promptText: anchor.promptText, promptAttachments, messages,
    ...(authoredRoot ? { authoredSource: toRow(path[index]!), authoredInputText: anchor.authoredInputText } : {}),
    ...(origin ? { origin: { ...(origin.root ? { root: true as const } : {}), nodeId: origin.nodeId, requestId: origin.requestId,
      execution: origin.execution, dispatch: origin.dispatch, restarts: origin.restarts,
      ...(origin.computerSelection ? { computerSelection: origin.computerSelection } : {}),
      ...(origin.incidentBatch ? { incidentBatch: origin.incidentBatch } : {}),
      ...(origin.privateHandoffHash ? { privateHandoffHash: origin.privateHandoffHash } : {}),
      ...(origin.consultation ? { consultation: origin.consultation } : {}),
      ...(origin.privateHandoffGeneration ? { privateHandoffGeneration: origin.privateHandoffGeneration } : {}),
      ...(origin.privateAnswers ? { privateAnswers: origin.privateAnswers } : {}),
      ...(origin.parkedStatus ? { parkedStatus: origin.parkedStatus } : {}),
      ...(origin.childRestart ? { childRestart: origin.childRestart } : {}),
      ...(origin.parentResultWake ? { parentResultWake: origin.parentResultWake } : {}),
      sourceMessageId: origin.sourceMessageId,
      approvalMode: origin.approvalMode, restrictedTools: origin.restrictedTools } } : {}),
    workspaceRoot: attachmentRoots.workspace ?? null,
  };
}

/** Answers a parent-owned request from the saved native store, outside turn delivery. */
/** Native storage carries the message anchor outside the private V2 cursor. */
export function nativeResumeCursor(value: unknown, botId: string, threadId: string) {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  const prefix = "j1-shared:v2:" + botId + ":" + threadId + ":";
  if (!value.startsWith(prefix)) return undefined;
  const match = /^[\w.-]+:(?:[\w:.-]|%[0-9A-F]{2})+~([\w-]+)$/.exec(value.slice(prefix.length));
  if (!match) return undefined;
  return {
    cursor: value.slice(0, value.lastIndexOf("~")),
    messageId: match[1]!,
    revision: NodeCrypto.createHash("sha256").update(value).digest("hex"),
  };
}

export function registerSavedBotEnrollmentReader(
  read: (botId: string, threadId: string, history?: {
    turnId: string; anchor: SavedHistoryAnchor;
  }, resumeCursor?: string, incidentFailure?: string, incidentNote?: NativeIncidentRetryNote) => unknown,
) {
  if (process.env.J1_MAUSBOT_MANAGED !== "1" || !process.send) return;
  process.on("message", (message: unknown) => {
    if (!object(message) || message.type !== "j1:saved-bot-enrollment-query") return;
    const { requestId, botId, threadId, turnId, resumeTurnId, roomTurnId } = message;
    if (typeof requestId !== "string" || !/^[a-f0-9-]{36}$/u.test(requestId)) return;
    const id = /^[\w-]{1,120}$/u;
    if (typeof botId !== "string" || !id.test(botId) ||
        typeof threadId !== "string" || !id.test(threadId)) return;
    try {
      if (roomTurnId !== undefined) {
        const value = typeof roomTurnId === "string" && id.test(roomTurnId) &&
            turnId === undefined && resumeTurnId === undefined
          ? readOwnedNativeRoomTurn(roomTurns.get(roomTurnId), botId, threadId, roomTurnId)
          : null;
        process.send?.({ type: "j1:saved-bot-enrollment-result", requestId, value });
        return;
      }
      let history: { turnId: string; anchor: SavedHistoryAnchor } | undefined;
      if (turnId !== undefined) {
        const owner = typeof turnId === "string" ? historyTurns.get(turnId) : undefined;
        if (typeof turnId !== "string" || !owner || owner.signal.aborted ||
            owner.botId !== botId || owner.threadId !== threadId) {
          throw new Error("The saved history request has no current native turn.");
        }
        history = { turnId, anchor: owner.anchor };
      }
      const resume = typeof resumeTurnId === "string" ? resumeTurns.get(resumeTurnId) : undefined;
      if (resumeTurnId !== undefined && (history || !resume || resume.signal.aborted ||
          resume.botId !== botId || resume.threadId !== threadId || !resume.current())) {
        throw new Error("The saved continuation does not own this native turn.");
      }
      process.send?.({ type: "j1:saved-bot-enrollment-result", requestId,
        value: read(botId, threadId, history, resume?.cursor, resume?.incidentFailure, resume?.incidentNote) });
    } catch {
      process.send?.({ type: "j1:saved-bot-enrollment-result", requestId, value: null });
    }
  });
}

export const J1SharedDriver: ProviderDriver<Record<string, never>> = {
  driverKind: "j1-shared",
  metadata: {
    displayName: "J1 shared providers",
    supportsMultipleInstances: false,
    access: "subscription",
  },
  models: { default: "", options: [] },
  defaultConfig: () => ({}),
  decodeConfig(raw) {
    if (!object(raw) || Object.keys(raw).length)
      throw new Error("Configure these provider accounts in J1's Model providers settings.");
    return {};
  },
  async create(input) {
    const events = new Set<(event: RuntimeEvent) => void>();
    const turns = new Map<string, Turn>();
    const models: ModelCatalog = { default: "", options: [] };
    const emit = (threadId: string, value: EventInput) => {
      const event = {
        eventId: newEventId(),
        provider: "j1-shared",
        providerInstanceId: input.instanceId,
        threadId,
        createdAt: new Date().toISOString(),
        ...value,
      } as RuntimeEvent;
      for (const listener of events) listener(event);
    };
    const cleanup = async (threadId: string) => {
      const turn = turns.get(threadId);
      if (!turn) return;
      turns.delete(threadId);
      historyTurns.delete(turn.turnId);
      resumeTurns.delete(turn.turnId);
      roomTurns.delete(turn.turnId);
      turn.controller.abort();
      turn.approvals.close();
      await turn.tools?.close();
    };
    const source = (turn: Turn) => ({ botId: turn.input.botId, threadId: turn.input.threadId });
    const onBridgeEvent = (message: ObjectValue) => {
      if (message.kind === "catalog") {
        void refreshModels().catch(() => {});
        return;
      }
      if (message.kind === "disconnected") {
        for (const [threadId, turn] of turns) {
          emit(threadId, {
            type: "runtime.error",
            turnId: turn.turnId,
            message: "J1 disconnected; this conversation can be resumed.",
            terminal: true,
          });
          emit(threadId, {
            type: "turn.completed",
            turnId: turn.turnId,
            ok: false,
            stopReason: "J1 disconnected; this conversation can be resumed.",
          });
          void cleanup(threadId);
        }
        return;
      }
      if (typeof message.threadId !== "string") return;
      const turn = turns.get(message.threadId);
      if (!turn || turn.input.botId !== message.botId || turn.turnId !== message.turnId) return;
      if (message.kind === "tool-cancel" && typeof message.requestId === "string") {
        turn.toolCalls.get(message.requestId)?.abort();
        return;
      }
      if (message.kind === "tool-call") {
        if (typeof message.requestId !== "string" || turn.toolCalls.has(message.requestId)) return;
        const requestId = message.requestId;
        const controller = new AbortController();
        const stop = () => controller.abort();
        turn.controller.signal.addEventListener("abort", stop, { once: true });
        if (turn.controller.signal.aborted) controller.abort();
        turn.toolCalls.set(requestId, controller);
        void (async () => {
          let value: unknown;
          try {
            if (typeof message.name !== "string" || !object(message.arguments))
              throw new Error("Invalid tool call.");
            const tools = turn.tools;
            if (!tools) throw new Error("This consultation does not have action tools.");
            tools.validate(message.name, message.arguments);
            const shown = tools.view(message.name, message.arguments);
            const full = (turn.input.approvalModeNow?.() ?? turn.input.approvalMode) === "full";
            const block = turn.approvals.floored({
              full,
              threadId: turn.input.threadId,
              botId: turn.input.botId,
              shown,
            });
            const allowed =
              !block &&
              (full ||
                !shown.ask ||
                (await turn.approvals.ask(shown.title, JSON.stringify(shown.input), shown.grant)));
            if (controller.signal.aborted) throw new Error("The bot tool was cancelled.");
            value = allowed
              ? await tools.execute(message.name, message.arguments, controller.signal)
              : { ok: false, text: refusal(block, () => {}) };
          } catch (error) {
            value = { ok: false, text: String(error) };
          } finally {
            turn.toolCalls.delete(requestId);
            turn.controller.signal.removeEventListener("abort", stop);
          }
          await sharedExecutionRequest({
            action: "tool-result",
            ...source(turn),
            requestId: message.requestId,
            value,
          });
        })().catch(() => {});
        return;
      }
      if (message.kind === "failed") {
        emit(turn.input.threadId, {
          type: "runtime.error",
          turnId: turn.turnId,
          message: String(message.message),
          setup: true,
          terminal: true,
        });
        emit(turn.input.threadId, {
          type: "turn.completed",
          turnId: turn.turnId,
          ok: false,
          stopReason: String(message.message),
        });
        void cleanup(turn.input.threadId);
        return;
      }
      if (message.kind !== "runtime") return;
      const event = message.event;
      if (!object(event) || !object(event.payload)) return;
      const payload = event.payload;
      const base = {
        turnId: turn.turnId,
        ...(typeof event.itemId === "string" ? { itemId: event.itemId } : {}),
        ...(typeof event.requestId === "string" ? { requestId: event.requestId } : {}),
      };
      const send = (value: object) =>
        emit(turn.input.threadId, { ...base, ...value } as RuntimeEvent);
      const announce = () => {
        if (turn.sessionAnnounced) return;
        turn.sessionAnnounced = true;
        const cursor = payload.resumeCursor;
        const messageId = turn.input.j1SavedHistoryAnchor?.messageId;
        const anchored = typeof cursor === "string" && messageId ? cursor + "~" + messageId : undefined;
        const sessionId = anchored && turn.input.botId && nativeResumeCursor(anchored, turn.input.botId, turn.input.threadId)
          ? anchored : typeof cursor === "string" ? cursor : "j1-shared:" + turn.input.botId + ":" + turn.input.threadId;
        send({
          type: "session.started",
          sessionId,
          model: turn.input.model,
        });
      };
      const assistantKey = typeof event.itemId === "string" ? event.itemId : "assistant";
      switch (event.type) {
        case "runtime.error":
          turn.errorReported = true;
          send({
            type: "runtime.error",
            message:
              typeof payload.message === "string"
                ? payload.message
                : "The shared provider reported an error.",
          });
          break;
        case "session.started":
          announce();
          break;
        case "turn.started":
          announce();
          if (!turn.sent) {
            turn.sent = true;
            turn.input.onInputSent?.(turn.turnId);
          }
          send({ type: "turn.started" });
          break;
        case "content.delta":
          if (payload.streamKind === "assistant_text" && typeof payload.delta === "string")
            turn.assistant.set(
              assistantKey,
              (turn.assistant.get(assistantKey) ?? "") + payload.delta,
            );
          if (payload.streamKind === "assistant_text" || payload.streamKind === "reasoning_text")
            send({ type: "content.delta", streamKind: payload.streamKind, delta: payload.delta });
          break;
        case "item.started":
          if (payload.itemType !== "assistant_message")
            send({
              type: "item.started",
              itemType: payload.itemType === "reasoning" ? "reasoning" : "tool",
              title: payload.title ?? payload.itemType,
            });
          break;
        case "item.completed":
          if (payload.itemType === "assistant_message") {
            const text =
              turn.assistant.get(assistantKey) ??
              (object(payload.data) && typeof payload.data.text === "string"
                ? payload.data.text
                : typeof payload.detail === "string"
                  ? payload.detail
                  : "");
            turn.assistant.delete(assistantKey);
            if (text) send({ type: "item.completed", itemType: "assistant_text", text });
          } else if (payload.itemType !== "reasoning")
            send({
              type: "item.completed",
              itemType: "tool",
              ok: payload.status !== "failed",
              output: payload.detail,
            });
          break;
        case "request.opened":
          send({
            type: "request.opened",
            requestType: "permission",
            tool: payload.appName ?? payload.requestType,
            summary: payload.detail ?? "The shared provider requests permission.",
            input: payload.args ?? {},
            requiresExplicitApproval: true,
          });
          break;
        case "user-input.requested": {
          const questions = Array.isArray(payload.questions)
            ? payload.questions.filter(object)
            : [];
          if (typeof event.requestId === "string")
            turn.questions.set(
              event.requestId,
              questions.map((q) => String(q.id)),
            );
          send({
            type: "request.opened",
            requestType: "question",
            tool: "AskUserQuestion",
            summary: "The shared provider has a question.",
            questions: questions.map((q) => ({
              question: q.question,
              header: q.header,
              options: q.options,
              multiSelect: q.multiSelect,
            })),
            input: {},
          });
          break;
        }
        case "request.resolved":
        case "user-input.resolved":
          send({
            type: "request.resolved",
            behavior:
              event.type === "user-input.resolved"
                ? "answer"
                : payload.decision === "decline"
                  ? "deny"
                  : "allow",
            source: "user",
          });
          break;
        case "turn.completed":
        case "turn.aborted":
        case "session.exited":
          for (const [itemId, text] of turn.assistant) {
            if (text)
              send({
                type: "item.completed",
                itemType: "assistant_text",
                itemId: itemId === "assistant" ? undefined : itemId,
                text,
              });
          }
          turn.assistant.clear();
          if (
            (event.type === "session.exited" ||
              (event.type === "turn.completed" && payload.state === "failed")) &&
            !turn.errorReported
          )
            send({
              type: "runtime.error",
              message:
                payload.errorMessage ??
                (event.type === "session.exited"
                  ? "The shared provider session ended before the turn completed."
                  : "The shared provider turn failed."),
              terminal: true,
            });
          send({
            type: "turn.completed",
            ok:
              event.type === "turn.completed" &&
              payload.state !== "failed" &&
              payload.state !== "interrupted",
            stopReason: payload.errorMessage ?? payload.reason ?? payload.stopReason,
            ...(event.type === "turn.completed" && payload.state === "failed" &&
                typeof payload.incidentFailure === "string" && payload.incidentFailure.length <= 4096
              ? { j1IncidentFailure: payload.incidentFailure } : {}),
            cost: payload.totalCostUsd,
            ...(object(payload.tokenUsage)
              ? {
                  usage: {
                    input: payload.tokenUsage.inputTokens ?? 0,
                    output: payload.tokenUsage.outputTokens ?? 0,
                    cachedInput: payload.tokenUsage.cachedInputTokens,
                  },
                }
              : {}),
          });
          void cleanup(turn.input.threadId);
          break;
      }
    };
    const removeBridgeListener = onSharedExecution(onBridgeEvent);
    const refreshModels = async () => {
      const rows = (await catalog()).filter((row) => row.enabled);
      models.options = rows.flatMap((row) =>
        row.models.map((model) => ({
          id: encodeSharedModel(row.instanceId, model.slug),
          label: `${model.name} · ${row.displayName ?? row.driver}`,
          variants: model.capabilities?.optionDescriptors
            ?.find((option) => option.id === "variant")
            ?.options?.map((option) => ({ id: option.id, label: option.label })),
        })),
      );
      models.default = models.options[0]?.id ?? "";
    };
    return {
      instanceId: input.instanceId,
      driverKind: "j1-shared",
      displayName: input.displayName,
      enabled: input.enabled,
      models,
      refreshModels,
      startupModelRefresh: refreshModels().catch(() => {}),
      async snapshot() {
        try {
          const ready = (await catalog()).some(
            (row) => row.enabled && row.installed && row.auth.status !== "unauthenticated",
          );
          return ready
            ? { state: "available", authenticated: true }
            : {
                state: "unavailable",
                authenticated: false,
                reason: "Connect a provider account in J1's Model providers settings.",
              };
        } catch {
          return {
            state: "unavailable",
            authenticated: false,
            reason: "J1's shared execution connection is unavailable.",
          };
        }
      },
      adapter: {
        provider: "j1-shared",
        capabilities: {
          sessionModelSwitch: "unsupported",
          agentsMcp: true,
          computerMcp: true,
          localComputerMcp: true,
          composioMcp: true,
          phoneMcp: true,
          browserMcp: true,
          dataMcp: true,
          emailMcp: true,
          deviceMcp: true,
          customMcp: true,
          images: true,
          nativeImageInput: true,
          strictResume: true,
          engineAdmission: true,
          effortLevels: ["low", "medium", "high", "xhigh", "max"],
        },
        async sendTurn(turnInput) {
          if (!turnInput.botId)
            throw new Error("Shared execution requires the original bot identity.");
          if (turns.has(turnInput.threadId))
            throw new Error("This bot conversation is already running.");
          if (turnInput.guestConfined)
            throw new Error("Shared execution is unavailable to guest turns.");
          if (turnInput.approvalMode === "custom")
            throw new Error("Select a supported J1 permission mode before using shared execution.");
          if (
            [...(turnInput.toolScope?.allow ?? []), ...(turnInput.toolScope?.deny ?? [])].some(
              (selector) => selector.startsWith("native:"),
            )
          )
            throw new Error(
              "This bot has native-tool restrictions that its selected shared provider cannot yet enforce. Its existing engine and permissions are preserved.",
            );
          const selected = decodeSharedModel(turnInput.model ?? models.default);
          await turnInput.engineAdmission?.("session");
          const controller = new AbortController();
          const tools = turnInput.j1Consultation ? null : await mountChatTools(
            turnInput.integrations,
            controller.signal,
            true,
            turnInput.toolScope,
            turnInput.mcpCallTimeoutMs,
            undefined,
            turnInput.toolResultFolder,
          );
          const turnId = NodeCrypto.randomUUID();
          const approvals = createChatToolApproval({
            signal: controller.signal,
            open: (ask) =>
              emit(turnInput.threadId, {
                type: "request.opened",
                turnId,
                requestId: ask.id,
                requestType: "permission",
                tool: ask.tool,
                summary: ask.summary,
              }),
            resolved: (ask, allowed, source) =>
              emit(turnInput.threadId, {
                type: "request.resolved",
                turnId,
                requestId: ask.id,
                behavior: allowed ? "allow" : "deny",
                source,
              }),
            openQuestion: (ask, questions) =>
              emit(turnInput.threadId, {
                type: "request.opened",
                turnId,
                requestId: ask.id,
                requestType: "question",
                tool: ask.tool,
                summary: ask.summary,
                questions,
              }),
            resolvedQuestion: (ask, answered, source) =>
              emit(turnInput.threadId, {
                type: "request.resolved",
                turnId,
                requestId: ask.id,
                behavior: answered ? "answer" : "deny",
                source,
              }),
          });
          const turn: Turn = {
            input: turnInput,
            turnId,
            controller,
            tools,
            approvals,
            questions: new Map(),
            assistant: new Map(),
            sessionAnnounced: false,
            sent: false,
            errorReported: false,
            toolCalls: new Map(),
          };
          turns.set(turnInput.threadId, turn);
          try {
            if (turnInput.j1SavedHistoryAnchor && !turnInput.j1ExplicitResume) historyTurns.set(turnId, {
              botId: turnInput.botId, threadId: turnInput.threadId,
              anchor: turnInput.j1SavedHistoryAnchor, signal: controller.signal,
            });
            if (turnInput.j1ExplicitResume) {
              const cursor = turnInput.resumeCursor;
              const saved = nativeResumeCursor(cursor, turnInput.botId, turnInput.threadId);
              if (typeof cursor !== "string" || !saved || saved.messageId !== turnInput.j1SavedHistoryAnchor?.messageId ||
                  !turnInput.j1ExplicitResume() || turnInput.text !== (turnInput.j1RetryNote?.text ?? "") || turnInput.images?.length ||
                  turnInput.transcript?.length || turnInput.recoveryText) {
                throw new Error("The saved J1 continuation does not match this bot message.");
              }
              resumeTurns.set(turnId, {
                botId: turnInput.botId, threadId: turnInput.threadId,
                cursor, signal: controller.signal, current: turnInput.j1ExplicitResume,
                incidentFailure: turnInput.j1RetryFailure, incidentNote: turnInput.j1RetryNote,
              });
            }
            if (turnInput.j1RoomTurn && turnInput.j1RoomMemberRead) roomTurns.set(turnId, {
              botId: turnInput.botId, threadId: turnInput.threadId,
              signal: controller.signal, read: turnInput.j1RoomMemberRead,
            });
            const origin = turnInput.j1SavedHistoryAnchor?.origin;
            const authoredRoot = origin?.root === true && origin.dispatch === "first";
            const privateCoordinator = origin && !authoredRoot;
            const result = await sharedExecutionRequest({
              action: "start",
              ...source(turn),
              ...selected,
              botName: turnInput.j1BotName ?? "Bot",
              title: turnInput.j1BotName ?? "Bot conversation",
              ...(turnInput.j1ProjectId ? { projectId: turnInput.j1ProjectId } : {}),
              cwd: turnInput.cwd ?? process.cwd(),
              text: privateCoordinator ? turnInput.j1SavedHistoryAnchor!.promptText : turnInput.text,
              system: turnInput.system ?? "",
              turnId,
              ...(privateCoordinator ? { nativeOriginStart: true } : {}),
              ...(turnInput.j1RoomTurn ? { nativeRoomTurn: true } : {}),
              ...(turnInput.j1RetryFailure ? { nativeIncidentRetry: true } : {}),
              ...(turnInput.j1RetryNote ? { nativeIncidentNote: true } : {}),
              ...(authoredRoot ? { trackCoordinatorRoot: true } : {}),
              sharedContinuation:
                !privateCoordinator && typeof turnInput.resumeCursor === "string" &&
                turnInput.resumeCursor.startsWith("j1-shared:"),
              restrictedTools: turnInput.toolScope !== undefined,
              ...(turnInput.transcript ? { transcript: turnInput.transcript } : {}),
              ...(turnInput.recoveryText
                ? { recoveryText: turnInput.recoveryText }
                : turnInput.transcript?.length
                  ? {
                      recoveryText: turnInput.transcript
                        .map((m) => `${m.role}: ${m.text}`)
                        .join("\n\n"),
                    }
                  : {}),
              ...(turnInput.effort ? { effort: turnInput.effort } : {}),
              ...(turnInput.variant ? { variant: turnInput.variant } : {}),
              approvalMode: turnInput.approvalModeNow?.() ?? turnInput.approvalMode ?? "ask",
              guestConfined: false,
              images: turnInput.images ?? [],
              tools: tools?.definitions.map(({ function: fn }) => ({
                name: fn.name,
                description: fn.description,
                inputSchema: fn.parameters,
              })) ?? [],
            });
            if (!object(result) || result.turnId !== turnId)
              throw new Error("J1 did not accept the bot turn.");
            if (result.replayed === true) {
              emit(turnInput.threadId, {
                type: "turn.completed", turnId: result.turnId, ok: false,
                stopReason: turnInput.j1SavedHistoryAnchor?.origin
                  ? "This coordinator execution was already admitted." : "Resume was already recorded for this saved run.",
              });
              await cleanup(turnInput.threadId);
            }
            return { turnId: result.turnId };
          } catch (error) {
            await cleanup(turnInput.threadId);
            throw error;
          } finally {
            if (!turnInput.j1SavedHistoryAnchor?.origin) historyTurns.delete(turnId);
            if (!turnInput.j1RetryFailure) resumeTurns.delete(turnId);
          }
        },
        async interruptTurn(threadId) {
          const turn = turns.get(threadId);
          if (turn) {
            turn.controller.abort();
            turn.approvals.close();
            const origin = turn.input.j1SavedHistoryAnchor?.origin;
            const durableStop = origin && (!(origin.root && origin.dispatch === "first") || origin.stopped?.());
            await sharedExecutionRequest({ action: durableStop ? "stop" : "interrupt", ...source(turn) });
          }
        },
        async respondToRequest(threadId, requestId, decision) {
          const turn = turns.get(threadId);
          if (!turn) return "unavailable";
          const local = turn.approvals.answer(requestId, decision.behavior, decision.message);
          if (local !== "unavailable") return local;
          if (decision.behavior === "answer") {
            const ids = turn.questions.get(requestId);
            if (!ids || !decision.message?.trim()) return "unavailable";
            await sharedExecutionRequest({
              action: "answer",
              ...source(turn),
              requestId,
              answers: Object.fromEntries(ids.map((id) => [id, decision.message])),
            });
            return "answered";
          }
          await sharedExecutionRequest({
            action: "respond",
            ...source(turn),
            requestId,
            decision: decision.behavior === "allow" ? "accept" : "decline",
          });
          return decision.behavior === "allow" ? "allowed-once" : "rejected";
        },
        hasSession: (threadId) => turns.has(threadId),
        async stopAll() {
          await Promise.all(
            [...turns].map(async ([threadId, turn]) => {
              turn.controller.abort();
              turn.approvals.close();
              await sharedExecutionRequest({ action: "stop", ...source(turn) }).finally(() =>
                cleanup(threadId),
              );
            }),
          );
        },
        onEvent(listener) {
          events.add(listener);
          return () => events.delete(listener);
        },
      },
      async dispose() {
        removeBridgeListener();
        await Promise.all(
          [...turns].map(async ([threadId, turn]) => {
            turn.controller.abort();
            turn.approvals.close();
            await sharedExecutionRequest({ action: "stop", ...source(turn) }).finally(() =>
              cleanup(threadId),
            );
          }),
        );
        events.clear();
      },
    };
  },
};
