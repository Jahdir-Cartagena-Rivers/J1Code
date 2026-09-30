import * as NodeCrypto from "node:crypto";
import { MessageId, type OrchestrationThread, type ThreadId } from "@t3tools/contracts";
import type { AgentSessionThreadMessage } from "./AgentSessionScanner.ts";

/** Keep saved history immutable, using source identities and a unique legacy tail to find new text. */
export function reconcileAgentHistory(
  threadId: ThreadId,
  saved: OrchestrationThread["messages"],
  source: ReadonlyArray<AgentSessionThreadMessage>,
) {
  const incoming = source.map((message, index) => ({
    messageId: MessageId.make(
      message.sourceMessageId
        ? `${threadId}:source:${NodeCrypto.createHash("sha256").update(message.sourceMessageId).digest("hex")}`
        : `${threadId}:${String(index).padStart(6, "0")}`,
    ),
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
  }));
  if (saved.length === 0) return incoming;
  const sourceIds = new Set(incoming.map((message) => message.messageId));
  const matches = (message: (typeof saved)[number], candidate: (typeof incoming)[number]) =>
    message.role === candidate.role &&
    message.text === candidate.text &&
    (!message.id.includes(":source:") ||
      !sourceIds.has(message.id) ||
      message.id === candidate.messageId);
  const appendAfter = (position: number) => {
    const savedIds = new Set(saved.map((message) => message.id));
    return [
      ...saved.map((message) => ({
        messageId: message.id,
        role: message.role as "user" | "assistant",
        text: message.text,
        createdAt: message.createdAt,
      })),
      ...incoming.slice(position).filter((message) => !savedIds.has(message.messageId)),
    ];
  };
  if (
    incoming.length >= saved.length &&
    saved.every(
      (message, index) =>
        matches(message, incoming[index]!) && message.createdAt === incoming[index]!.createdAt,
    )
  ) {
    return appendAfter(saved.length);
  }

  // The first release kept the first prompt plus a rolling 199-message tail.
  // Claude compaction can reserialize timestamps. Require every saved message
  // in order and a unique contiguous tail; never infer an anchor from one
  // repeated prompt or silently replace any saved text or dates.
  const tail = saved.slice(-Math.min(3, saved.length));
  const anchors: Array<number> = [];
  for (let index = 0; index <= incoming.length - tail.length; index++) {
    if (tail.every((message, offset) => matches(message, incoming[index + offset]!))) {
      anchors.push(index);
    }
  }
  if (anchors.length !== 1) return null;
  const anchor = anchors[0]!;
  let position = 0;
  for (const message of saved.slice(0, -tail.length)) {
    while (position < anchor && !matches(message, incoming[position]!)) position++;
    if (position >= anchor) return null;
    position++;
  }
  return appendAfter(anchor + tail.length);
}
