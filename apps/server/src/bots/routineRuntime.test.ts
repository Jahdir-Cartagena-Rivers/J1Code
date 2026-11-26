import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BotProfile,
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@j1code/contracts";
import { it } from "@effect/vitest";
import * as IdAllocator from "@j1code/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@j1code/provider-core/server/ProviderAdapter";
import { Deferred, Effect, FileSystem, Layer, Path, Schema } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { EffectOutboxV2 } from "../orchestration-v2/EffectOutbox.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { layerFromAdapters } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { LegacyV1ThreadImporter } from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import { layerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { ProjectEnrichmentService } from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { ServerActivation } from "../serverActivation.ts";
import { BotRoutineRuntimeLive } from "./routineRuntime.ts";
import { makeRoutineRuns } from "./routineRuns.ts";

const at = "2026-01-01T00:00:00Z";
const occurrence = Date.parse(at);
const projectId = ProjectId.make("routine-runtime-project");
const bot = Schema.decodeUnknownSync(BotProfile)({
  id: "garden",
  name: "Garden",
  description: "",
  instructions: "Be concise",
  projectId,
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  pinned: false,
  archived: false,
  createdAt: at,
  updatedAt: at,
  routines: ["normal", "claimed", "blocked"].map((id) => ({
    id,
    name: id,
    prompt: "Check plants",
    enabled: true,
    schedule: { type: "once", at },
  })),
});

const occurrenceKey = (routineId: string) => NodeCrypto.createHash("sha256")
  .update(`6:garden${routineId.length}:${routineId}:${occurrence}`).digest("hex");
const threadId = (routineId: string) => ThreadId.make(`bot-routine:${occurrenceKey(routineId)}`);
const turnCommand = (routineId: string) => CommandId.make(`bot-routine-turn:${occurrenceKey(routineId)}`);

const adapter = {
  instanceId: bot.modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Admission test cannot launch a provider process."),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const makeTestLayer = (dbPath: string) => {
  const database = Sqlite.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));
  return ProjectService.layer.pipe(
    Layer.provide(Layer.mergeAll(
      IdAllocator.layer,
      WorkspacePaths.layer,
      Layer.mock(LegacyV1ThreadImporter)({}),
      Layer.mock(ProjectEnrichmentService)({
        invalidate: () => Effect.void,
        getAvailable: () => Effect.succeed({
          repositoryIdentity: null, faviconPath: null, repositoryIdentityResolved: true,
        }),
      }),
    )),
    Layer.provideMerge(layerWithRegistry(
      { name: "routine-runtime" },
      layerFromAdapters([adapter]),
      { databaseLayer: database, runEffectWorker: false },
    )),
    Layer.provideMerge(database),
  );
};

it.effect("recovers claims after readiness and admits only the unclaimed occurrence across restart", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "routine-runtime-" });
    const dbPath = path.join(root, "state.sqlite");
    yield* TestClock.setTime(occurrence);

    // A fresh layer opens the same database in each scope, with the effect worker disabled.
    yield* Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const settings = yield* ServerSettingsService;
      const orchestrator = yield* OrchestratorV2;
      yield* settings.insertBotProfileIfAbsent(bot);
      yield* projects.create({
        projectId, commandId: CommandId.make("seed-routine-project"), title: bot.name,
        workspaceRoot: root,
      });
      yield* orchestrator.dispatch({
        type: "thread.bot.create", commandId: CommandId.make("seed-privileged-thread"),
        projectId, threadId: threadId("blocked"), botId: bot.id, title: "Blocked",
        modelSelection: bot.modelSelection, runtimeMode: "full-access", interactionMode: "default",
        branch: null, worktreePath: null, createdBy: "user", creationSource: "server",
      });
      const runs = yield* makeRoutineRuns;
      expect(yield* runs.claim(bot.id, "claimed", occurrence, at)).toBe(true);
    }).pipe(Effect.provide(makeTestLayer(dbPath)));

    const startRuntime = Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      yield* settings.insertBotProfileIfAbsent(bot);
      yield* settings.updateSettings({ defaultRuntimeMode: "approval-required" });

      const activation = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      yield* Layer.build(BotRoutineRuntimeLive).pipe(
        Effect.provideService(ServerActivation, Deferred.await(activation)),
        Effect.provideService(ServerSettingsService, { ...settings, ready: Deferred.await(ready) }),
      );
      const runs = yield* makeRoutineRuns;
      yield* Deferred.succeed(activation, undefined);
      yield* TestClock.adjust("30 seconds");
      const beforeReady = yield* runs.listForBot(bot.id);

      yield* Deferred.succeed(ready, undefined);
      yield* TestClock.adjust("30 seconds");
      const afterReady = yield* runs.listForBot(bot.id);
      const orchestrator = yield* OrchestratorV2;
      const outbox = yield* EffectOutboxV2;
      const normal = yield* orchestrator.getThreadProjection(threadId("normal"));
      expect(normal.messages.map(({ text }) => text)).toEqual(["Check plants"]);
      expect(normal.runs).toHaveLength(1);
      expect(normal.thread.runtimeMode).toBe("approval-required");
      expect(yield* orchestrator.getThreadShell(threadId("claimed"))).toBeNull();
      const blocked = yield* orchestrator.getThreadProjection(threadId("blocked"));
      expect(blocked.runs).toEqual([]);
      expect(blocked.messages).toEqual([]);
      expect(yield* outbox.listByCommandId(turnCommand("claimed"))).toEqual([]);
      expect(yield* outbox.listByCommandId(turnCommand("blocked"))).toEqual([]);
      const effects = yield* outbox.listByCommandId(turnCommand("normal"));
      const starts = effects.filter(({ request }) => request.type === "provider-turn.start");
      expect(starts).toHaveLength(1);
      return { beforeReady, afterReady, effects, run: normal.runs[0] };
    });

    const first = yield* startRuntime.pipe(
      Effect.scoped, Effect.provide(makeTestLayer(dbPath)),
    );
    expect(first.beforeReady).toMatchObject([{ routine_id: "claimed", status: "claimed" }]);
    expect(Object.fromEntries(first.afterReady.map(({ routine_id, status }) => [routine_id, status])))
      .toEqual({ normal: "admitted", claimed: "uncertain", blocked: "uncertain" });

    const restarted = yield* startRuntime.pipe(
      Effect.scoped, Effect.provide(makeTestLayer(dbPath)),
    );
    expect(restarted.beforeReady).toEqual(first.afterReady);
    expect(restarted.afterReady).toEqual(first.afterReady);
    expect(restarted.effects).toEqual(first.effects);
    expect(restarted.run).toEqual(first.run);
  }).pipe(Effect.provide(NodeServices.layer)),
);
