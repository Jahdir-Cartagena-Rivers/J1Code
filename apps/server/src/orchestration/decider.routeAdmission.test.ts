import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadRouteDeliverCommand,
  ClientOrchestrationCommand,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
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

const command = Schema.decodeUnknownSync(ThreadRouteDeliverCommand)({
  type: "thread.route.deliver",
  commandId: "route-command",
  routeId: "route-1",
  sourceThreadId: "source",
  threadId,
  messageId: "route-message",
  originalRuntimeMode: "full-access",
  originalProviderInstanceId: "codex",
  text: "Forwarded request",
  provenance: "source message 1",
  visitedThreadIds: [],
  createdAt,
});
const model = Effect.map(readModelWithThread, (state) => ({
  ...state,
  threads: [...state.threads, { ...state.threads[0]!, id: ThreadId.make("source") }],
}));
it("validates trusted payload and excludes it from client dispatch", () => {
  expect(Schema.is(ClientOrchestrationCommand)(command)).toBe(false);
  for (const field of [
    "sourceThreadId",
    "originalRuntimeMode",
    "originalProviderInstanceId",
    "routeId",
    "provenance",
    "messageId",
  ]) {
    const invalid = { ...command } as Record<string, unknown>;
    delete invalid[field];
    expect(Schema.is(ThreadRouteDeliverCommand)(invalid)).toBe(false);
  }
});
it.layer(NodeServices.layer)("atomic route admission", (it) => {
  it.effect("fails closed until engine hydration is integrated", () =>
    Effect.gen(function* () {
      const readModel = yield* model;
      const error = yield* Effect.flip(decideOrchestrationCommand({ readModel, command }));
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
  it.effect("admits idle same-mode delivery using destination context and stable events", () =>
    Effect.gen(function* () {
      const readModel = yield* model;
      const result = yield* decideOrchestrationCommand({
        routeAdmissionHydrated: true,
        readModel,
        command,
      });
      const repeated = yield* decideOrchestrationCommand({
        routeAdmissionHydrated: true,
        readModel,
        command,
      });
      expect(result).toEqual(repeated);
      const events = Array.isArray(result) ? result : [result];
      expect(events.find((e) => e.type === "thread.message-sent")?.payload).toMatchObject({
        text: command.text,
      });
      expect(events.find((e) => e.type === "thread.turn-start-requested")?.payload).toMatchObject({
        runtimeMode: "full-access",
        modelSelection: { instanceId: "codex", model: "gpt-5" },
      });
      const crossProvider = yield* decideOrchestrationCommand({
        routeAdmissionHydrated: true,
        command,
        readModel: {
          ...readModel,
          threads: readModel.threads.map((thread) =>
            thread.id === command.threadId
              ? {
                  ...thread,
                  modelSelection: {
                    ...thread.modelSelection,
                    instanceId: ProviderInstanceId.make("claudeAgent"),
                  },
                }
              : thread,
          ),
        },
      });
      const crossEvents = Array.isArray(crossProvider) ? crossProvider : [crossProvider];
      expect(
        crossEvents.find((event) => event.type === "thread.turn-start-requested")?.payload,
      ).toMatchObject({
        runtimeMode: "full-access",
        modelSelection: { instanceId: "claudeAgent" },
      });
    }),
  );
  it.effect(
    "holds changed permissions, providers, missing/archived chats, loops, and pending requests",
    () =>
      Effect.gen(function* () {
        const readModel = yield* model;
        const destination = readModel.threads[0]!;
        const source = readModel.threads[1]!;
        const variants = [
          { ...readModel, threads: [destination] },
          { ...readModel, threads: [source] },
          ...[0, 1].flatMap((index) => [
            {
              ...readModel,
              threads: readModel.threads.map((t, i) =>
                i === index ? { ...t, runtimeMode: "approval-required" as const } : t,
              ),
            },
            {
              ...readModel,
              threads: readModel.threads.map((t, i) =>
                i === index ? { ...t, archivedAt: createdAt } : t,
              ),
            },
            ...(index === 1
              ? [
                  {
                    ...readModel,
                    threads: readModel.threads.map((t, i) =>
                      i === index
                        ? {
                            ...t,
                            modelSelection: {
                              ...t.modelSelection,
                              instanceId: ProviderInstanceId.make("other"),
                            },
                          }
                        : t,
                    ),
                  },
                ]
              : []),
          ]),
          ...["starting", "running"].map((status) => ({
            ...readModel,
            threads: [
              {
                ...destination,
                session: {
                  threadId,
                  status: status as "running" | "starting",
                  providerName: "codex",
                  providerInstanceId: ProviderInstanceId.make("codex"),
                  runtimeMode: "full-access" as const,
                  activeTurnId: null,
                  lastError: null,
                  updatedAt: createdAt,
                },
              },
              source,
            ],
          })),
          ...["approval.requested", "user-input.requested"].map((kind) => ({
            ...readModel,
            threads: [
              {
                ...destination,
                activities: [
                  {
                    id: EventId.make("activity"),
                    kind,
                    tone: "info" as const,
                    summary: "pending",
                    payload: { requestId: "r" },
                    turnId: null,
                    createdAt,
                  },
                ],
              },
              source,
            ],
          })),
        ];
        for (const state of variants) {
          const error = yield* Effect.flip(
            decideOrchestrationCommand({ routeAdmissionHydrated: true, readModel: state, command }),
          );
          expect(error._tag).toBe("OrchestrationCommandInvariantError");
        }
        for (const changed of [
          { ...command, sourceThreadId: threadId },
          { ...command, visitedThreadIds: [threadId] },
        ]) {
          yield* Effect.flip(
            decideOrchestrationCommand({
              routeAdmissionHydrated: true,
              readModel,
              command: changed,
            }),
          );
        }
      }),
  );
});
