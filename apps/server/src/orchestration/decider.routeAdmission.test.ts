import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  ThreadRouteDeliverCommand,
  ThreadExternalRouteDeliverCommand,
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
const nativeCommand = Schema.decodeUnknownSync(ThreadExternalRouteDeliverCommand)({
  ...command,
  type: "thread.external-route.deliver",
  sourceThreadId: "mausbot:crown:main",
  sourceProjectId: "mausbot:crown",
  originalProviderKey: "native-codex",
});
const nativeSource = {
  endpoint: {
    environmentId: "environment",
    projectId: "mausbot:crown",
    threadId: "mausbot:crown:main",
  },
  url: "/assistants?environmentId=environment&botId=crown&conversation=main",
  runtimeMode: "full-access" as const,
  providerKey: "native-codex",
  permissionsKnown: true,
  archived: false,
};
it("does not expose external-source admission to client commands", () => {
  expect(Schema.is(ClientOrchestrationCommand)(nativeCommand)).toBe(false);
});
it.layer(NodeServices.layer)("foreign source admission", (it) => {
  it.effect("admits real foreign identity without a projected source thread", () =>
    Effect.gen(function* () {
      const readModel = yield* readModelWithThread;
      const result = yield* decideOrchestrationCommand({
        readModel,
        command: nativeCommand,
        routeAdmissionHydrated: true,
        externalRouteSource: nativeSource,
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.find((event) => event.type === "thread.message-sent")?.metadata).toMatchObject({
        sourceThreadId: nativeCommand.sourceThreadId,
        routeId: nativeCommand.routeId,
      });
      expect(readModel.threads).toHaveLength(1);
      expect(readModel.threads.some((thread) => thread.id === nativeCommand.sourceThreadId)).toBe(
        false,
      );
    }),
  );
  it.effect("holds unavailable, revoked, changed and unverified source facts", () =>
    Effect.gen(function* () {
      const readModel = yield* readModelWithThread;
      const variants = [
        undefined,
        { ...nativeSource, permissionsKnown: false },
        { ...nativeSource, archived: true },
        { ...nativeSource, providerKey: "changed-provider" },
        { ...nativeSource, runtimeMode: "auto" as const },
        { ...nativeSource, endpoint: { ...nativeSource.endpoint, projectId: "other" } },
        { ...nativeSource, endpoint: { ...nativeSource.endpoint, threadId: "other" } },
      ];
      for (const source of variants) {
        const error = yield* Effect.flip(
          decideOrchestrationCommand({
            readModel,
            command: nativeCommand,
            routeAdmissionHydrated: true,
            ...(source ? { externalRouteSource: source } : {}),
          }),
        );
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
      }
      const collision = {
        ...readModel,
        threads: [
          ...readModel.threads,
          { ...readModel.threads[0]!, id: nativeCommand.sourceThreadId },
        ],
      };
      expect(
        (yield* Effect.flip(
          decideOrchestrationCommand({
            readModel: collision,
            command: nativeCommand,
            routeAdmissionHydrated: true,
            externalRouteSource: nativeSource,
          }),
        ))._tag,
      ).toBe("OrchestrationCommandInvariantError");
    }),
  );
  it.effect("keeps destination permission, busy and loop gates", () =>
    Effect.gen(function* () {
      const base = yield* readModelWithThread;
      for (const thread of [
        { ...base.threads[0]!, runtimeMode: "auto" as const },
        { ...base.threads[0]!, archivedAt: createdAt },
      ]) {
        expect(
          (yield* Effect.flip(
            decideOrchestrationCommand({
              readModel: { ...base, threads: [thread] },
              command: nativeCommand,
              routeAdmissionHydrated: true,
              externalRouteSource: nativeSource,
            }),
          ))._tag,
        ).toBe("OrchestrationCommandInvariantError");
      }
      expect(
        (yield* Effect.flip(
          decideOrchestrationCommand({
            readModel: base,
            command: { ...nativeCommand, visitedThreadIds: [threadId] },
            routeAdmissionHydrated: true,
            externalRouteSource: nativeSource,
          }),
        ))._tag,
      ).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
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
  it.effect("admits only the expected running turn for live steering", () =>
    Effect.gen(function* () {
      const base = yield* model;
      const activeTurnId = TurnId.make("active-turn");
      const readModel = {
        ...base,
        threads: base.threads.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                session: {
                  threadId,
                  status: "running" as const,
                  providerName: "codex",
                  providerInstanceId: ProviderInstanceId.make("codex"),
                  runtimeMode: "full-access" as const,
                  activeTurnId,
                  lastError: null,
                  updatedAt: createdAt,
                },
              }
            : thread,
        ),
      };
      const result = yield* decideOrchestrationCommand({
        readModel,
        command: { ...command, activeTurnId },
        routeAdmissionHydrated: true,
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.every((event) => event.metadata.routeSteerTurnId === activeTurnId)).toBe(true);
      expect(events.find((event) => event.type === "thread.message-sent")?.payload).toMatchObject({
        turnId: activeTurnId,
      });
      for (const kind of ["approval.requested", "user-input.requested"]) {
        const blocked = {
          ...readModel,
          threads: readModel.threads.map((thread) =>
            thread.id === threadId
              ? {
                  ...thread,
                  activities: [
                    {
                      id: EventId.make("pending"),
                      kind,
                      tone: "info" as const,
                      summary: "Pending",
                      payload: { requestId: "pending" },
                      turnId: activeTurnId,
                      createdAt,
                    },
                  ],
                }
              : thread,
          ),
        };
        const failure = yield* Effect.flip(
          decideOrchestrationCommand({
            readModel: blocked,
            command: { ...command, activeTurnId },
            routeAdmissionHydrated: true,
          }),
        );
        expect(failure._tag).toBe("OrchestrationCommandInvariantError");
      }
      for (const expected of [undefined, TurnId.make("stale-turn")]) {
        const rejected = yield* Effect.flip(
          decideOrchestrationCommand({
            readModel,
            command: { ...command, ...(expected ? { activeTurnId: expected } : {}) },
            routeAdmissionHydrated: true,
          }),
        );
        expect(rejected._tag).toBe("OrchestrationCommandInvariantError");
      }
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
