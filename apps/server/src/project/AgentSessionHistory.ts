import { hashTelemetryId as hashUtf8Sha256 } from "@j1code/shared/telemetryId";
import {
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderThread,
  type ThreadId,
} from "@j1code/contracts";
import type { OrchestrationThread } from "@j1code/contracts/legacy-orchestration";
import type { AgentSessionThreadMessage } from "./AgentSessionScanner.ts";

export function ownsSourceImportedNativeHistory(
  thread: Pick<
    OrchestrationV2AppThread,
    "id" | "historyOrigin" | "bot" | "activeProviderThreadId" | "providerInstanceId"
  >,
  provider:
    | Pick<
        OrchestrationV2ProviderThread,
        "id" | "appThreadId" | "ownerNodeId" | "providerInstanceId" | "driver" | "nativeThreadRef"
      >
    | undefined,
): boolean {
  const nativeThread = provider?.nativeThreadRef;
  return thread.historyOrigin === "v1_import" &&
    thread.bot === undefined &&
    provider !== undefined &&
    provider.appThreadId === thread.id &&
    provider.id === thread.activeProviderThreadId &&
    provider.ownerNodeId === null &&
    provider.providerInstanceId === thread.providerInstanceId &&
    nativeThread?.strength === "strong" &&
    nativeThread.driver === provider.driver &&
    nativeThread.nativeId !== null &&
    nativeThread.nativeId.length > 0 &&
    matchesSourceSession(thread.id, provider, nativeThread.nativeId);
}

function matchesSourceSession(
  threadId: ThreadId,
  provider: Pick<OrchestrationV2ProviderThread, "providerInstanceId" | "driver">,
  nativeId: string,
): boolean {
  const prefix = `import:${provider.providerInstanceId}:`;
  // Pi uses the transcript path as its native ID and the session UUID in the thread ID.
  return provider.driver === "pi"
    ? threadId.startsWith(prefix) && threadId.length > prefix.length
    : threadId === prefix + nativeId;
}

export function agentHistorySourceMessageId(threadId: ThreadId, sourceMessageId: string): MessageId {
  return MessageId.make(`${threadId}:source:${hashUtf8Sha256(sourceMessageId)}`);
}

/** Keep saved history immutable, using source identities and a unique legacy tail to find new text. */
export function reconcileAgentHistory(
  threadId: ThreadId,
  saved: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "id" | "role" | "text"> &
      Pick<AgentSessionThreadMessage, "createdAt">
  >,
  source: ReadonlyArray<AgentSessionThreadMessage>,
) {
  const savedMessages = saved.filter(
    (message): message is (typeof saved)[number] & { readonly role: "user" | "assistant" } =>
      message.role === "user" || message.role === "assistant",
  );
  if (savedMessages.length !== saved.length) return null;

  const incoming = source.map((message, index) => ({
    messageId: message.sourceMessageId
      ? agentHistorySourceMessageId(threadId, message.sourceMessageId)
      : MessageId.make(`${threadId}:${String(index).padStart(6, "0")}`),
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
  }));
  if (savedMessages.length === 0) return incoming;
  const sourceIds = new Set(incoming.map((message) => message.messageId));
  const matches = (message: (typeof savedMessages)[number], candidate: (typeof incoming)[number]) =>
    message.role === candidate.role &&
    message.text === candidate.text &&
    (!message.id.includes(":source:") ||
      !sourceIds.has(message.id) ||
      message.id === candidate.messageId);
  const appendAfter = (position: number) => {
    const savedIds = new Set(savedMessages.map((message) => message.id));
    return [
      ...savedMessages.map((message) => ({
        messageId: message.id,
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
      })),
      ...incoming.slice(position).filter((message) => !savedIds.has(message.messageId)),
    ];
  };
  if (
    incoming.length >= savedMessages.length &&
    savedMessages.every(
      (message, index) =>
        matches(message, incoming[index]!) && message.createdAt === incoming[index]!.createdAt,
    )
  ) {
    return appendAfter(savedMessages.length);
  }

  // The first release kept the first prompt plus a rolling 199-message tail.
  // Claude compaction can reserialize timestamps. Require every saved message
  // in order and a unique contiguous tail; never infer an anchor from one
  // repeated prompt or silently replace any saved text or dates.
  const tail = savedMessages.slice(-Math.min(3, savedMessages.length));
  const anchors: Array<number> = [];
  for (let index = 0; index <= incoming.length - tail.length; index++) {
    if (tail.every((message, offset) => matches(message, incoming[index + offset]!))) {
      anchors.push(index);
    }
  }
  if (anchors.length !== 1) return null;
  const anchor = anchors[0]!;
  let position = 0;
  for (const message of savedMessages.slice(0, -tail.length)) {
    while (position < anchor && !matches(message, incoming[position]!)) position++;
    if (position >= anchor) return null;
    position++;
  }
  return appendAfter(anchor + tail.length);
}
