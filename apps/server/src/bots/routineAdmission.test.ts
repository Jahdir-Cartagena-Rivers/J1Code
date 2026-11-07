import * as NodeServices from "@effect/platform-node/NodeServices";
import { BotProfile, CommandId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { expect } from "vite-plus/test";
import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { makeRoutineAdmission } from "./routineAdmission.ts";
import { makeRoutineScheduler } from "./routineScheduler.ts";
import { makeRoutineRuns } from "./routineRuns.ts";
import { makeBotCallTurnLookup } from "./callTurnLookup.ts";

const decode = Schema.decodeUnknownSync(BotProfile);
const bot = decode({
  id: "garden",
  name: "Garden",
  description: "",
  instructions: "Be concise",
  projectId: null,
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  pinned: false,
  archived: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  routines: [
    {
      id: "water",
      name: "Water check",
      prompt: "Check plants",
      enabled: true,
      schedule: { type: "once", at: "2026-01-01T00:00:00Z" },
    },
  ],
});
const testLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
  WorkspacePaths.layer,
  ServerSettings.layerTest(),
).pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j1-routine-admission-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("creates a standalone workspace and starts one bot turn through the real engine", () =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const admit = yield* makeRoutineAdmission;
    const scheduler = yield* makeRoutineScheduler({
      profiles: Effect.succeed([bot]),
      admit: (profile, routine, occurrence) =>
        admit(profile, routine, occurrence).pipe(Effect.mapError(String)),
    });
    const occurrence = Date.parse("2026-01-01T00:00:00Z");
    yield* scheduler.sweep(occurrence);
    yield* scheduler.sweep(occurrence);
    const runs = yield* makeRoutineRuns;
    expect((yield* runs.listForBot(bot.id)).map((run) => run.status)).toEqual(["admitted"]);
    const events = yield* engine.readEvents(0, 100).pipe(Stream.runCollect);
    expect(events.filter((event) => event.type === "project.created")).toHaveLength(1);
    const thread = events.find((event) => event.type === "thread.created");
    expect(thread?.payload).toMatchObject({
      projectId: "j1-bot:garden",
      bot: { id: "garden", instructions: "Be concise" },
    });
    const message = events.find((event) => event.type === "thread.message-sent");
    expect(message?.payload).toMatchObject({ role: "user", text: "Check plants" });
    expect(events.filter((event) => event.type === "thread.turn-start-requested")).toHaveLength(1);
    if (thread?.type !== "thread.created" || message?.type !== "thread.message-sent")
      return yield* Effect.die("Missing routine events");
    const threadId = ThreadId.make(thread.payload.threadId);
    const userId = message.payload.messageId;
    const turnId = TurnId.make("voice-test-turn");
    const now = "2026-01-01T00:00:00.000Z";
    const lookup = yield* makeBotCallTurnLookup;
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("voice-test-running"),
      threadId,
      createdAt: now,
      session: {
        threadId,
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: turnId,
        lastError: null,
        updatedAt: now,
      },
    });
    expect((yield* lookup(threadId, userId))?.text).toBeNull();
    yield* engine.dispatch({
      type: "thread.message.assistant.delta",
      commandId: CommandId.make("voice-test-delta"),
      threadId,
      messageId: MessageId.make("voice-test-assistant"),
      turnId,
      delta: "The plants are healthy.",
      createdAt: now,
    });
    yield* engine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: CommandId.make("voice-test-complete"),
      threadId,
      messageId: MessageId.make("voice-test-assistant"),
      turnId,
      createdAt: now,
    });
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("voice-test-ready"),
      threadId,
      createdAt: now,
      session: {
        threadId,
        status: "ready",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
    });
    expect(yield* lookup(threadId, userId)).toMatchObject({
      turnId,
      state: "completed",
      text: "The plants are healthy.",
    });
  }).pipe(Effect.provide(testLayer)),
);
