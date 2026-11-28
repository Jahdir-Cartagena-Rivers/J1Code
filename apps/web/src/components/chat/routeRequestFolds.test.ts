import { expect, it } from "vite-plus/test";
import { MessageId, RunId, ThreadId } from "@j1code/contracts";
import type { ChatMessage } from "../../types";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";
import {
  deriveThreadFeedPresentation,
  type ThreadFeedEntry,
  type ThreadFeedMessage,
} from "../../../../mobile/src/lib/threadActivity";
import { routeRequestAnchors } from "@j1code/shared/routeRequestAnchors";

const runId = RunId.make("turn-1");
const messages: ReadonlyArray<ChatMessage & ThreadFeedMessage> = ["intro", "handoff", "final"].map(
  (id, index) => ({
    id: MessageId.make(id),
    role: "assistant" as const,
    text: id,
    runId,
    createdAt: `2026-01-01T00:00:0${index + 1}Z`,
    updatedAt: `2026-01-01T00:00:0${index + 1}Z`,
    streaming: false,
    attachments: [],
    visibility: "local",
    sourceThreadId: ThreadId.make("thread-1"),
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
      expandedRunIds: expanded ? new Set([runId]) : new Set(),
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
    if (!expanded) expect(fold?.kind === "turn-fold" && fold.hiddenMessageIds).toContain("handoff");
    else expect(rows.some((row) => row.kind === "message" && row.message.id === anchor)).toBe(true);
    expect(rows.findIndex((row) => row.kind === "turn-fold")).toBeLessThan(
      rows.findIndex((row) => row.kind === "message" && row.message.id === "final"),
    );
  }
});

it("keeps one historical card through native mobile fold expansion and collapse", () => {
  const feed: ThreadFeedEntry[] = messages.map((message) => ({
    type: "message",
    runId,
    id: message.id,
    createdAt: message.createdAt,
    message,
  }));
  for (const expanded of [false, true, false]) {
    const rows = deriveThreadFeedPresentation(feed, null, expanded ? new Set([runId]) : new Set());
    const visible = rows.flatMap((row) =>
      row.type === "message"
        ? [row.message.id]
        : row.type === "run-fold" && !row.expanded
          ? (row.hiddenMessageIds ?? [])
          : [],
    );
    expect(visible.filter((id) => id === anchor)).toHaveLength(1);
    const fold = rows.find((row) => row.type === "run-fold");
    if (!expanded) expect(fold?.type === "run-fold" && fold.hiddenMessageIds).toContain("handoff");
    else expect(rows.some((row) => row.type === "message" && row.message.id === anchor)).toBe(true);
  }
});
