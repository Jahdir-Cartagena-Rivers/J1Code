import {
  BotId, CommandId, MessageId, ThreadId,
  type OrchestrationV2Command, type OrchestrationV2ThreadProjection,
} from "@j1code/contracts";
import * as Context from "effect/Context";

type Respond = Extract<OrchestrationV2Command, { type: "runtime-request.respond" }>;
export type CompatibilityTurn = {
  readonly botId: string;
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
};
type ApprovalOwner = CompatibilityTurn & {
  /** Private authorization for the runtime generation issuing the reply. */
  readonly current: () => boolean;
};

export const CompatibilityApprovalOwner = Context.Reference<ApprovalOwner | undefined>(
  "@j1code/server/mausbot/CompatibilityApproval/CompatibilityApprovalOwner",
  { defaultValue: () => undefined },
);

export const compatibilityThreadId = (turn: CompatibilityTurn) =>
  ThreadId.make(`j1-mausbot:${turn.botId}:${turn.nativeThreadId}`);

/** Fresh compatibility submissions must commit this ID as their user message. */
export const compatibilityMessageId = (turn: CompatibilityTurn) =>
  MessageId.make(`message:mausbot:compat:${turn.botId}:${turn.nativeThreadId}:${turn.nativeTurnId}`);

export const COMPATIBILITY_START_PREFIX = "mausbot:compat:start:";
export const compatibilityStartCommandId = (turn: CompatibilityTurn) =>
  CommandId.make(COMPATIBILITY_START_PREFIX + compatibilityMessageId(turn));

export function compatibilityApprovalCommand(
  owner: ApprovalOwner,
  requestId: Respond["requestId"],
  decision: NonNullable<Respond["decision"]>,
): Respond {
  return {
    type: "runtime-request.respond",
    commandId: CommandId.make(`mausbot:compat:approval:${compatibilityMessageId(owner)}:${requestId}`),
    threadId: compatibilityThreadId(owner),
    requestId,
    decision,
  };
}

export function matchesCompatibilityApprovalCommand(owner: ApprovalOwner, command: Respond): boolean {
  if (![owner.botId, owner.nativeThreadId, owner.nativeTurnId].every((id) =>
    /^[\w-]{1,120}$/.test(id)) || command.decision === undefined || command.answers !== undefined ||
      command.feedback !== undefined || !owner.current()) {
    return false;
  }
  const expected = compatibilityApprovalCommand(owner, command.requestId, command.decision);
  return command.commandId === expected.commandId && command.threadId === expected.threadId;
}

export function ownsCompatibilityApproval(
  owner: ApprovalOwner,
  command: Respond,
  projection: Pick<OrchestrationV2ThreadProjection,
    "thread" | "runs" | "messages" | "attempts" | "providerThreads" |
    "providerTurns" | "runtimeRequests" | "turnItems">,
): boolean {
  if (!matchesCompatibilityApprovalCommand(owner, command)) return false;
  const thread = projection.thread;
  if (thread.id !== compatibilityThreadId(owner) || thread.bot?.id !== BotId.make(`mausbot:${owner.botId}`) ||
      thread.archivedAt != null || thread.deletedAt != null || !owner.current()) return false;

  const running = projection.runs.filter((row) => row.status === "running");
  if (running.length !== 1) return false;
  const run = running[0];
  if (run === undefined || run.threadId !== thread.id || run.status !== "running" ||
      run.userMessageId !== compatibilityMessageId(owner) ||
      !projection.messages.some((row) => row.id === run.userMessageId &&
        row.threadId === thread.id && row.runId === run.id && row.role === "user")) return false;

  const attempt = projection.attempts.find((row) => row.id === run.activeAttemptId);
  if (attempt === undefined || attempt.runId !== run.id || attempt.status !== "running" ||
      attempt.providerThreadId !== run.providerThreadId || attempt.rootNodeId !== run.rootNodeId ||
      attempt.providerInstanceId !== run.providerInstanceId) return false;
  const providerThread = projection.providerThreads.find((row) => row.id === attempt.providerThreadId);
  // The runtime can persist the provider event before populating the attempt's forward link.
  // The exact request and the provider turn's persisted attempt link are still authoritative.
  const request = projection.runtimeRequests.find((row) => row.id === command.requestId);
  const providerTurn = projection.providerTurns.find((row) => row.id === request?.providerTurnId);
  if (providerThread === undefined || providerThread.appThreadId !== thread.id || thread.activeProviderThreadId !== providerThread.id ||
      providerThread.providerInstanceId !== attempt.providerInstanceId ||
      providerThread.providerSessionId === null || providerThread.nativeThreadRef?.strength !== "strong" ||
      !attempt.nativeThreadId || providerThread.nativeThreadRef.nativeId !== attempt.nativeThreadId ||
      providerTurn?.status !== "running" || providerTurn.runAttemptId !== attempt.id ||
      (attempt.providerTurnId !== null && attempt.providerTurnId !== providerTurn.id) ||
      providerTurn.providerThreadId !== providerThread.id || providerTurn.nodeId !== attempt.rootNodeId ||
      providerTurn.nativeTurnRef?.strength !== "strong" || !providerTurn.nativeTurnRef.nativeId) return false;

  return request?.status === "pending" && request.providerTurnId === providerTurn.id &&
    request.nativeRequestRef?.strength === "strong" && Boolean(request.nativeRequestRef.nativeId) &&
    request.responseCapability.type === "live" &&
    request.responseCapability.providerSessionId === providerThread.providerSessionId &&
    projection.turnItems.some((item) => item.type === "approval_request" && item.runId === run.id &&
      item.requestId === request.id && item.requestKind === request.kind && item.nodeId === request.nodeId &&
      item.providerTurnId === providerTurn.id && (item.status === "pending" || item.status === "running")) &&
    owner.current();
}
