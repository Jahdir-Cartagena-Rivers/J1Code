import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const createdAt = "2026-08-24T10:00:00.000Z";
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-bootstrap");
const messageId = MessageId.make("message-bootstrap");

const readModelWithThread = Effect.gen(function* () {
  const withProject = yield* projectEvent(createEmptyReadModel(createdAt), {
    sequence: 1,
    eventId: EventId.make("event-project-created"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: createdAt,
    commandId: CommandId.make("command-project-created"),
    causationEventId: null,
    correlationId: CommandId.make("command-project-created"),
    metadata: {},
    payload: {
      projectId,
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
    },
  });
  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: EventId.make("event-thread-created"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.created",
    occurredAt: createdAt,
    commandId: CommandId.make("command-thread-created"),
    causationEventId: null,
    correlationId: CommandId.make("command-thread-created"),
    metadata: {},
    payload: {
      threadId,
      projectId,
      title: "Bootstrap thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
      updatedAt: createdAt,
    },
  });
});

const turnStartCommand = {
  type: "thread.turn.start" as const,
  commandId: CommandId.make("command-turn-start"),
  threadId,
  message: { messageId, role: "user" as const, text: "Build it", attachments: [] },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  createdAt,
};

it.layer(NodeServices.layer)("explicit Auto admission", (it) => {
  it.effect("preserves the manual provider-native auto neighboring path", () =>
    Effect.gen(function* () {
      const readModel = yield* readModelWithThread;
      const result = yield* decideOrchestrationCommand({
        readModel,
        command: {
          ...turnStartCommand,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "auto" },
        },
      });
      const events = Array.isArray(result) ? result : [result];
      const start = events.find((event) => event.type === "thread.turn-start-requested");
      expect(start?.payload).toMatchObject({ modelSelection: { model: "auto" } });
      expect(start?.payload).not.toHaveProperty("autoRouting");
    }),
  );
  it.effect(
    "rejects explicit Auto before producing dispatchable events, even with a manual model",
    () =>
      Effect.gen(function* () {
        const readModel = yield* readModelWithThread;
        for (const requestEscalation of [false, true]) {
          const error = yield* Effect.flip(
            decideOrchestrationCommand({
              readModel,
              command: {
                ...turnStartCommand,
                modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
                autoRouting: { taskId: "stable-task-1", requestEscalation },
              },
            }),
          );
          expect(error._tag).toBe("OrchestrationCommandInvariantError");
          if (error._tag !== "OrchestrationCommandInvariantError")
            throw new Error("Unexpected error");
          expect(error.detail).toContain("provider admission is not wired");
        }
        expect(readModel.threads[0]?.messages).toEqual([]);
      }),
  );
});
