interface MessageAnchor {
  readonly id: string;
  readonly role: string;
  readonly createdAt: string;
  readonly text?: string;
}
interface ActivityAnchor {
  readonly kind: string;
  readonly createdAt: string;
  readonly payload?: unknown;
}
/** First notice fixes the historical position; later receipts never move a card. */
export function routeRequestAnchors(
  requests: readonly { readonly requestId: string; readonly summary?: string }[],
  messages: readonly MessageAnchor[],
  activities: readonly ActivityAnchor[],
): ReadonlyMap<string, string> {
  const users = messages
    .filter((message) => message.role === "user")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const first = new Map<string, string>();
  for (const activity of activities) {
    if (
      activity.kind !== "routing.updated" ||
      !activity.payload ||
      typeof activity.payload !== "object" ||
      !("requestId" in activity.payload) ||
      typeof activity.payload.requestId !== "string"
    )
      continue;
    const id = activity.payload.requestId;
    if (!first.has(id) || activity.createdAt < first.get(id)!) first.set(id, activity.createdAt);
  }
  const anchors = new Map<string, string>();
  for (const request of requests) {
    const time = first.get(request.requestId);
    // Older servers did not emit notices. Match their request text when possible;
    // otherwise keep legacy records at the first historical user message.
    const summary = request.summary?.trim();
    const exact =
      summary && summary.length >= 20
        ? users.find((message) => message.text?.trim().startsWith(summary))
        : undefined;
    const message =
      exact ?? (time ? users.findLast((message) => message.createdAt <= time) : users[0]);
    if (message) anchors.set(request.requestId, message.id);
  }
  return anchors;
}
