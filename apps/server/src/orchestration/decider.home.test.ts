import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const homeProjectId = ProjectId.make("j1-home");

const createHome = (threadId: string) => ({
  type: "thread.create" as const,
  commandId: CommandId.make(`command-${threadId}`),
  threadId: ThreadId.make(threadId),
  projectId: homeProjectId,
  title: "Home",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "full-access" as const,
  branch: null,
  worktreePath: null,
  createdAt: now,
});

const homeReadModel = Effect.gen(function* () {
  const initial = createEmptyReadModel(now);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: EventId.make("event-home-project"),
    aggregateKind: "project",
    aggregateId: homeProjectId,
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make("command-home-project"),
    causationEventId: null,
    correlationId: CommandId.make("command-home-project"),
    metadata: {},
    payload: {
      projectId: homeProjectId,
      title: "Home",
      workspaceRoot: "/tmp/home-workspace",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  const event = yield* decideOrchestrationCommand({
    readModel: withProject,
    command: createHome("home-original"),
  });
  const events = Array.isArray(event) ? event : [event];
  let model = withProject;
  for (const [index, next] of events.entries()) {
    model = yield* projectEvent(model, { ...next, sequence: index + 2 });
  }
  return model;
});

it.layer(NodeServices.layer)("Home singleton", (it) => {
  it.effect("rejects another Home conversation, including when the original is archived", () =>
    Effect.gen(function* () {
      const model = yield* homeReadModel;
      const archived = {
        ...model,
        threads: model.threads.map((thread) => ({ ...thread, archivedAt: now })),
      };
      const error = yield* Effect.flip(
        decideOrchestrationCommand({ readModel: archived, command: createHome("home-second") }),
      );
      expect(error).toMatchObject({ detail: "Home already has a conversation." });
    }),
  );

  it.effect("permits a replacement only after the original was deleted", () =>
    Effect.gen(function* () {
      const model = yield* homeReadModel;
      const deleted = {
        ...model,
        threads: model.threads.map((thread) => ({ ...thread, deletedAt: now })),
      };
      const event = yield* decideOrchestrationCommand({
        readModel: deleted,
        command: createHome("home-replacement"),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events.map((item) => item.type)).toContain("thread.created");
    }),
  );
});
