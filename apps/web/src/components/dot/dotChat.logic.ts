import type { DotChatMessage, DotChatSendInput } from "@t3tools/contracts";

/** Merges a snapshot or older page into history by id; the incoming copy of a message wins. */
export function mergeDotMessages(
  current: readonly DotChatMessage[],
  incoming: readonly DotChatMessage[],
): DotChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    const previous = byId.get(message.id);
    // A send's initial queued response can arrive after a live delivered/answered snapshot.
    if (
      previous?.status === "answered" ||
      (message.status === "queued" && previous && previous.status !== "queued")
    )
      continue;
    byId.set(message.id, message);
  }
  return [...byId.values()].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Resending the same text to the same Dot reuses the failed request id so the server dedupes it. */
export function nextDotSend(
  pending: DotChatSendInput | null,
  connectionId: string,
  text: string,
  makeId: () => string,
): DotChatSendInput {
  return pending?.connectionId === connectionId && pending.text === text
    ? pending
    : { connectionId, text, requestId: makeId() };
}
