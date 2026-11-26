import { assert, it } from "@effect/vitest";
import {
  BotId, EventId, MessageId, NodeId, ProjectId, ProviderInstanceId, ProviderThreadId,
  ProviderTurnId, RunAttemptId, RunId, ThreadId, TurnItemId,
  type OrchestrationV2AppThread, type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent, type OrchestrationV2ProviderTurn, type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@j1code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { makeBotCallTurnLookup } from "./callTurnLookup.ts";

it.effect("only reads the final assistant answer owned by the submitted message's V2 run", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const lookup = yield* makeBotCallTurnLookup;
    const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
    const threadId = ThreadId.make("thread");
    const other = ThreadId.make("nonbot");
    const runId = RunId.make("run");
    const nodeId = NodeId.make("root");
    const answerNodeId = NodeId.make("assistant-node");
    const attemptId = RunAttemptId.make("attempt");
    const providerThreadId = ProviderThreadId.make("provider-thread");
    const providerTurnId = ProviderTurnId.make("provider-turn");
    const userId = MessageId.make("submitted");
    const answerId = MessageId.make("answer");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
    const thread: OrchestrationV2AppThread = {
      id: threadId, projectId: ProjectId.make("project"), title: "Bot call", createdBy: "user",
      creationSource: "web", providerInstanceId, modelSelection, runtimeMode: "approval-required",
      interactionMode: "default", branch: null, worktreePath: null, activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null, createdAt: now, updatedAt: now, archivedAt: null, settledAt: null,
      settledOverride: null, lastVisitedAt: null, deletedAt: null,
    };
    let sequence = 0;
    const apply = (event: OrchestrationV2DomainEvent) => store.apply(event);
    const base = () => ({ id: EventId.make(`event:${++sequence}`), threadId, occurredAt: now });
    yield* apply({ ...base(), type: "thread.created", payload: {
      ...thread, bot: { id: BotId.make("bot"), name: "Bot", instructions: "" },
    } });
    yield* apply({ ...base(), threadId: other, type: "thread.created", payload: {
      ...thread, id: other, lineage: { ...thread.lineage, rootThreadId: other },
    } });
    const run: OrchestrationV2Run = {
      id: runId, threadId, ordinal: 1, providerInstanceId, modelSelection, providerThreadId,
      rootNodeId: nodeId, activeAttemptId: attemptId, userMessageId: userId, status: "running",
      requestedAt: now, startedAt: now, completedAt: null, checkpointId: null, contextHandoffId: null,
    };
    const updateRun = (payload: OrchestrationV2Run) =>
      apply({ ...base(), type: "run.updated", runId: payload.id, payload });
    yield* apply({ ...base(), type: "run.created", runId, payload: run });
    const message: OrchestrationV2ConversationMessage = {
      id: userId, threadId, nodeId, runId, role: "user", text: "Hello", attachments: [],
      streaming: false, createdAt: now, updatedAt: now, createdBy: "user", creationSource: "web",
    };
    const updateMessage = (payload: OrchestrationV2ConversationMessage) =>
      apply({ ...base(), type: "message.updated", runId, nodeId, payload });
    yield* updateMessage(message);
    const answer = { ...message, nodeId: answerNodeId, id: answerId, role: "assistant" as const, text: "Reply" };
    yield* updateMessage({ ...answer, streaming: true });
    const turn: OrchestrationV2ProviderTurn = {
      id: providerTurnId, providerThreadId, nodeId, runAttemptId: attemptId, nativeTurnRef: null,
      ordinal: 1, status: "completed", startedAt: now, completedAt: now,
    };
    yield* apply({ ...base(), type: "provider-turn.updated", runId, nodeId, payload: turn });
    yield* apply({
      ...base(), type: "node.updated", runId, nodeId: answerNodeId, payload: {
        id: answerNodeId, threadId, runId, parentNodeId: nodeId, rootNodeId: nodeId,
        kind: "assistant_message", status: "completed", countsForRun: false,
        providerThreadId, providerTurnId, nativeItemRef: null, runtimeRequestId: null,
        checkpointScopeId: null, startedAt: now, completedAt: now,
      },
    });
    const item: Extract<OrchestrationV2TurnItem, { type: "assistant_message" }> = {
      type: "assistant_message", phase: "final_answer", id: TurnItemId.make("final"), threadId,
      runId, nodeId: answerNodeId, providerThreadId, providerTurnId, nativeItemRef: null, parentItemId: null,
      ordinal: 1, status: "completed", title: null, startedAt: now, completedAt: now,
      updatedAt: now, messageId: answerId, text: "Reply", streaming: false,
    };
    const updateItem = (payload: typeof item) =>
      apply({ ...base(), type: "turn-item.updated", runId, nodeId, payload });
    yield* updateItem(item);

    assert.isNull((yield* lookup(threadId, userId))?.text);
    assert.isNull(yield* lookup(other, userId));
    assert.isNull(yield* lookup(ThreadId.make("missing"), userId));
    assert.isNull(yield* lookup(threadId, answerId));
    yield* updateRun({ ...run, status: "completed", completedAt: now });
    assert.isNull((yield* lookup(threadId, userId))?.text);
    yield* updateMessage({ ...answer, nodeId: NodeId.make("different-node") });
    assert.isNull((yield* lookup(threadId, userId))?.text);
    yield* updateMessage(answer);
    assert.isNull(yield* lookup(threadId, userId, BotId.make("foreign-bot")));
    assert.deepEqual(
      yield* lookup(threadId, userId, BotId.make("bot")),
      yield* lookup(threadId, userId),
    );
    assert.deepEqual(yield* lookup(threadId, userId), {
      turnId: runId, state: "completed", assistantMessageId: answerId, text: "Reply",
    });

    yield* updateItem({ ...item, id: TurnItemId.make("second-final"), ordinal: 2 });
    assert.isNull((yield* lookup(threadId, userId))?.text);
    yield* updateRun({ ...run, status: "failed", completedAt: now });
    assert.equal((yield* lookup(threadId, userId))?.state, "error");
    yield* updateRun({ ...run, status: "cancelled", completedAt: now });
    assert.equal((yield* lookup(threadId, userId))?.state, "interrupted");
    const duplicate = RunId.make("duplicate");
    yield* apply({ ...base(), type: "run.created", runId: duplicate, payload: {
      ...run, id: duplicate, ordinal: 2,
    } });
    assert.isNull(yield* lookup(threadId, userId));
  }).pipe(Effect.provide(ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);
