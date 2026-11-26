import type {
  BotCallTurn,
  BotId,
  MessageId,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@j1code/contracts";
import * as Effect from "effect/Effect";

import { ProjectionStoreV2, type ProjectionStoreV2Error } from "../orchestration-v2/ProjectionStore.ts";

function callState(status: OrchestrationV2Run["status"]): string {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
    case "rolled_back":
      return "interrupted";
    case "completed":
      return "completed";
    default:
      return "running";
  }
}

/** Read the message, run and response from a single persisted projection snapshot. */
export const makeBotCallTurnLookup = Effect.gen(function* () {
  const store = yield* ProjectionStoreV2;
  return Effect.fn("bots.callTurnLookup")(function* (
    threadId: ThreadId,
    userMessageId: MessageId,
    expectedBotId?: BotId,
  ): Effect.fn.Return<(typeof BotCallTurn)["Type"] | null, ProjectionStoreV2Error> {
    const records = yield* store
      .getThreadRecords(threadId, ["messages", "runs", "turnItems", "providerTurns", "nodes"], {
        turnItemTypes: ["assistant_message"],
      })
      .pipe(Effect.catchTag("ProjectionStoreThreadNotFoundError", () => Effect.succeed(null)));
    if (
      records === null ||
      records.thread.id !== threadId ||
      records.thread.deletedAt !== null ||
      records.thread.bot === undefined ||
      (expectedBotId !== undefined && records.thread.bot.id !== expectedBotId)
    ) {
      return null;
    }

    const submitted = records.messages.find(
      (message) => message.id === userMessageId && message.threadId === threadId && message.role === "user",
    );
    const matches = records.runs.filter(
      (run) => run.threadId === threadId && run.userMessageId === userMessageId,
    );
    const run = matches[0];
    if (submitted === undefined || run === undefined || matches.length !== 1 || submitted.runId !== run.id) {
      return null;
    }

    const result = {
      turnId: run.id,
      state: callState(run.status),
      assistantMessageId: null,
      text: null,
    };
    if (run.status !== "completed" || run.activeAttemptId === null || run.rootNodeId === null) {
      return result;
    }

    // One attempt can span multiple provider turns. Only its latest root turn
    // can own the final answer, and tied ordinals are ambiguous.
    const turns = records.providerTurns
      .filter((turn) =>
        turn.runAttemptId === run.activeAttemptId &&
        turn.nodeId === run.rootNodeId &&
        turn.providerThreadId === run.providerThreadId,
      )
      .sort((left, right) => right.ordinal - left.ordinal);
    const turn = turns[0];
    if (turn === undefined || turn.status !== "completed" || turns[1]?.ordinal === turn.ordinal) {
      return result;
    }

    // Adapter messages have their own execution nodes. Their immediate parent
    // identifies the root response and excludes nested subagent answers.
    const rootAnswerNodes = new Set(
      records.nodes.filter((node) =>
        node.kind === "assistant_message" &&
        node.status === "completed" &&
        node.threadId === threadId &&
        node.runId === run.id &&
        node.rootNodeId === run.rootNodeId &&
        node.parentNodeId === run.rootNodeId &&
        node.providerTurnId === turn.id &&
        node.providerThreadId === turn.providerThreadId,
      ).map((node) => node.id),
    );
    const answers = records.turnItems.filter(
      (item): item is Extract<OrchestrationV2TurnItem, { type: "assistant_message" }> =>
        item.type === "assistant_message" &&
        item.threadId === threadId &&
        item.runId === run.id &&
        item.nodeId !== null &&
        rootAnswerNodes.has(item.nodeId) &&
        item.providerTurnId === turn.id &&
        item.providerThreadId === turn.providerThreadId &&
        (item.phase === undefined || item.phase === "final_answer"),
    );
    const explicit = answers.filter((item) => item.phase === "final_answer");
    const candidates = explicit.length === 0 ? answers : explicit;
    const answer = candidates[0];
    if (candidates.length !== 1 || answer === undefined || answer.streaming || answer.status !== "completed") {
      return result;
    }
    const message = records.messages.find(
      (entry) =>
        entry.id === answer.messageId &&
        entry.role === "assistant" &&
        entry.threadId === threadId &&
        entry.runId === run.id &&
        entry.nodeId === answer.nodeId,
    );
    if (message === undefined || message.streaming || message.text.trim() === "") return result;
    return { ...result, assistantMessageId: message.id, text: message.text };
  });
});
