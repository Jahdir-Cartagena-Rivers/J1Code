import { expect, it } from "vite-plus/test";
import { MessageId, TurnId, type OrchestrationThread } from "@j1code/contracts";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";
import {
  deriveThreadFeedPresentation,
  type ThreadFeedEntry,
} from "../../../../mobile/src/lib/threadActivity";
import { routeRequestAnchors } from "@j1code/shared/routeRequestAnchors";

const turnId = TurnId.make("turn-1");
const messages: OrchestrationThread["messages"] = ["intro", "handoff", "final"].map(
  (id, index) => ({
    id: MessageId.make(id),
    role: "assistant" as const,
    text: id,
    turnId,
    createdAt: `2026-01-01T00:00:0${index + 1}Z`,
    updatedAt: `2026-01-01T00:00:0${index + 1}Z`,
    streaming: false,
  }),
);
const anchorMessages = [
  { id: "user", role: "user", createdAt: "2026-01-01T00:00:00Z" },
  ...messages,
];
const anchors = routeRequestAnchors([{ requestId: "request" }], anchorMessages, [
  {
    kind: "routing.updated",
    createdAt: "2026-01-01T00:00:02Z",
    payload: { requestId: "request" },
  },
]);
const anchor = anchors.get("request");

it("keeps one historical card at the web fold and restores its message on expansion", () => {
  const input = {
    timelineEntries: messages.map((message) => ({
      id: message.id,
      kind: "message" as const,
      createdAt: message.createdAt,
      message,
    })),
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
  };
  for (const expanded of [false, true, false]) {
    const rows = deriveMessagesTimelineRows({
      ...input,
      expandedTurnIds: expanded ? new Set([turnId]) : new Set(),
    });
    const visible = rows.flatMap((row) =>
      row.kind === "message"
        ? [row.message.id]
        : row.kind === "turn-fold" && !row.expanded
          ? (row.hiddenMessageIds ?? [])
          : [],
    );
    expect(anchor).toBe("handoff");
    expect(visible.filter((id) => id === anchor)).toHaveLength(1);
    const fold = rows.find((row) => row.kind === "turn-fold");
    expect(fold?.kind === "turn-fold" && fold.hiddenMessageIds).toContain("handoff");
    expect(rows.findIndex((row) => row.kind === "turn-fold")).toBeLessThan(
      rows.findIndex((row) => row.kind === "message" && row.message.id === "final"),
    );
  }
});

it("keeps one historical card through native mobile fold expansion and collapse", () => {
  const feed: ThreadFeedEntry[] = messages.map((message) => ({
    type: "message",
    id: message.id,
    createdAt: message.createdAt,
    message,
  }));
  for (const expanded of [false, true, false]) {
    const rows = deriveThreadFeedPresentation(feed, null, expanded ? new Set([turnId]) : new Set());
    const visible = rows.flatMap((row) =>
      row.type === "message"
        ? [row.message.id]
        : row.type === "turn-fold" && !row.expanded
          ? (row.hiddenMessageIds ?? [])
          : [],
    );
    expect(visible.filter((id) => id === anchor)).toHaveLength(1);
    const fold = rows.find((row) => row.type === "turn-fold");
    expect(fold?.type === "turn-fold" && fold.hiddenMessageIds).toContain("handoff");
  }
});
