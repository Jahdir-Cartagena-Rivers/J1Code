import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const threadId = ThreadId.make("import:claudeAgent:history-refresh");
type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;
const createdAt = "2026-09-30T10:00:00.000Z";
const messages = ["First question", "First answer", "Second question", "Second answer"].map(
  (text, index) => ({
    messageId: MessageId.make(`${threadId}:${String(index).padStart(6, "0")}`),
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text,
    createdAt: `2026-09-30T10:0${index}:00.000Z`,
  }),
);
const command = (history = messages) => ({
  type: "thread.history.import" as const,
  commandId: CommandId.make("refresh-history"),
  threadId,
  messages: history,
});
const apply = Effect.fn("applyRefreshEvents")(function* (
  model: OrchestrationReadModel,
  events: PlannedOrchestrationEvent | ReadonlyArray<PlannedOrchestrationEvent>,
) {
  for (const event of Array.isArray(events) ? events : [events]) {
    model = yield* projectEvent(model, { ...event, sequence: model.snapshotSequence + 1 });
  }
  return model;
});
const seed = Effect.fn("seedImportedHistory")(function* () {
  const model = yield* projectEvent(createEmptyReadModel(createdAt), {
    sequence: 1,
    eventId: EventId.make("thread-created"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.created",
    occurredAt: createdAt,
    commandId: CommandId.make("create"),
    causationEventId: null,
    correlationId: CommandId.make("create"),
    metadata: { historyImport: true },
    payload: {
      threadId,
      projectId: ProjectId.make("project"),
      title: "External Claude",
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "default" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
      updatedAt: createdAt,
    },
  });
  return yield* apply(
    model,
    yield* decideOrchestrationCommand({ readModel: model, command: command(messages.slice(0, 2)) }),
  );
});

it.layer(NodeServices.layer)("history refresh", (it) => {
  it.effect("appends new messages once through existing events and preserves settlement", () =>
    Effect.gen(function* () {
      const before = yield* seed();
      const events = yield* decideOrchestrationCommand({ readModel: before, command: command() });
      expect(events).toMatchObject([
        {
          type: "thread.message-sent",
          metadata: { historyImport: true },
          payload: { text: "Second question", turnId: null },
        },
        {
          type: "thread.message-sent",
          metadata: { historyImport: true },
          payload: { text: "Second answer", turnId: null },
        },
      ]);
      const after = yield* apply(before, events);
      expect(after.threads[0]?.messages.map((message) => message.text)).toEqual(
        messages.map((message) => message.text),
      );
      expect(after.threads[0]?.settledAt).toBe(before.threads[0]?.settledAt);
      expect(yield* decideOrchestrationCommand({ readModel: after, command: command() })).toEqual(
        [],
      );
    }),
  );

  for (const [label, history] of [
    [
      "changed prefix",
      messages.map((message, index) => (index === 0 ? { ...message, text: "Different" } : message)),
    ],
    ["truncated transcript", messages.slice(0, 1)],
    [
      "invalid appended identity",
      messages.map((message, index) =>
        index === 3 ? { ...message, messageId: MessageId.make("other") } : message,
      ),
    ],
  ] as const) {
    it.effect(`rejects ${label} without changing saved history`, () =>
      Effect.gen(function* () {
        const before = yield* seed();
        const result = yield* Effect.flip(
          decideOrchestrationCommand({ readModel: before, command: command([...history]) }),
        );
        expect(result._tag).toBe("OrchestrationCommandInvariantError");
        expect(before.threads[0]?.messages).toHaveLength(2);
      }),
    );
  }

  it.effect("rejects a native follow-up that arrived after scanning", () =>
    Effect.gen(function* () {
      const before = yield* seed();
      const external = before.threads[0]!;
      const raced = {
        ...before,
        threads: [
          {
            ...external,
            messages: [
              ...external.messages,
              {
                ...external.messages[0]!,
                id: MessageId.make("native-followup"),
                text: "Continue here",
              },
            ],
          },
        ],
      };
      const result = yield* Effect.flip(
        decideOrchestrationCommand({ readModel: raced, command: command() }),
      );
      expect(result._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
