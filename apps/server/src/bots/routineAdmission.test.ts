// @effect-diagnostics-next-line nodeBuiltinImport:off - Compute the persisted legacy occurrence ID independently.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BotId,
  BotProfile,
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@j1code/contracts";
import { it } from "@effect/vitest";
import * as IdAllocator from "@j1code/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@j1code/provider-core/server/ProviderAdapter";
import { standaloneBotWorkspace } from "@j1code/shared/bot-workspace";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { resolveBotTurnContext } from "../orchestration-v2/botTurnContext.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { layerFromAdapters } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { LegacyV1ThreadImporter } from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import { layerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { ProjectEnrichmentService } from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { makeBotCallTurnLookup } from "./callTurnLookup.ts";
import { makeRoutineAdmission } from "./routineAdmission.ts";
import { makeRoutineRuns } from "./routineRuns.ts";
import { makeRoutineScheduler } from "./routineScheduler.ts";

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
const [routine] = bot.routines ?? [];
if (routine === undefined) throw new Error("Missing routine fixture");
const occurrence = Date.parse("2026-01-01T00:00:00Z");
const standaloneId = ProjectId.make("j1-bot:garden");
const occurrenceThreadId = ThreadId.make(
  `bot-routine:${NodeCrypto.createHash("sha256")
    .update(`6:garden5:water:${occurrence}`)
    .digest("hex")}`,
);

const adapter = {
  instanceId: bot.modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Admission test cannot launch a provider process."),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const database = Sqlite.layerMemory;
const testLayer = ProjectService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      IdAllocator.layer,
      WorkspacePaths.layer,
      Layer.mock(LegacyV1ThreadImporter)({}),
      Layer.mock(ProjectEnrichmentService)({
        invalidate: () => Effect.void,
        getAvailable: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: true,
          }),
      }),
    ),
  ),
  Layer.provideMerge(
    layerWithRegistry({ name: "routine-admission" }, layerFromAdapters([adapter]), {
      databaseLayer: database,
      runEffectWorker: false,
    }),
  ),
  Layer.provideMerge(database),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("admits one persisted V2 bot occurrence and replays its original run", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projects = yield* ProjectStoreV2;
    const settings = yield* ServerSettingsService;
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* settings.insertBotProfileIfAbsent(bot);
    yield* settings.updateSettings({
      defaultRuntimeMode: "full-access",
      projectSettingsOverrides: { [standaloneId]: { defaultRuntimeMode: "approval-required" } },
    });

    const admit = yield* makeRoutineAdmission;
    const scheduler = yield* makeRoutineScheduler({
      profiles: Effect.succeed([bot]),
      admit: (profile, routine, occurrence) =>
        admit(profile, routine, occurrence).pipe(Effect.mapError(String)),
    });
    yield* scheduler.sweep(occurrence);
    yield* scheduler.sweep(occurrence);
    const runs = yield* makeRoutineRuns;
    expect((yield* runs.listForBot(bot.id)).map((run) => run.status)).toEqual(["admitted"]);
    yield* admit(bot, routine, occurrence);

    const project = Option.getOrThrow(yield* projects.getShell(standaloneId));
    const workspace = standaloneBotWorkspace(path.join(config.baseDir, "bot-workspaces"), bot.id);
    expect(project.workspaceRoot).toBe(path.resolve(workspace.workspaceRoot));
    expect((yield* fs.stat(project.workspaceRoot)).type).toBe("Directory");
    const projection = yield* orchestrator.getThreadProjection(occurrenceThreadId);
    expect(projection.thread).toMatchObject({
      projectId: standaloneId,
      runtimeMode: "approval-required",
      creationSource: "server",
      bot: { id: bot.id, name: bot.name, instructions: "Be concise" },
    });
    expect(projection.messages).toHaveLength(1);
    const message = projection.messages[0]!;
    expect(message).toMatchObject({ role: "user", text: "Check plants" });
    expect(message.id).toBe(occurrenceThreadId.replace(/^bot-routine:/u, "bot-routine-message:"));
    expect(projection.runs).toHaveLength(1);
    expect(projection.runs[0]).toMatchObject({
      userMessageId: message.id,
      modelSelection: bot.modelSelection,
    });
    const context = resolveBotTurnContext(projection.thread, message.id, undefined);
    expect(context).toMatchObject({
      type: "profile",
      prompt: expect.stringContaining("Be concise"),
    });
    const lookup = yield* makeBotCallTurnLookup;
    expect(yield* lookup(occurrenceThreadId, message.id, bot.id)).toMatchObject({
      turnId: projection.runs[0]!.id,
      state: "running",
      text: null,
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses a missing linked project and a standalone project claimed at another path", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const orchestrator = yield* OrchestratorV2;
    const projectService = yield* ProjectService.ProjectService;
    const config = yield* ServerConfig;
    yield* settings.insertBotProfileIfAbsent(bot);
    const linked = { ...bot, id: BotId.make("linked"), projectId: ProjectId.make("missing") };
    yield* settings.insertBotProfileIfAbsent(linked);
    const admit = yield* makeRoutineAdmission;
    expect(yield* Effect.flip(admit(linked, routine, occurrence))).toBe(
      "Bot project is unavailable.",
    );

    yield* projectService.create({
      commandId: CommandId.make("foreign-workspace"),
      projectId: standaloneId,
      title: "Foreign workspace",
      workspaceRoot: config.baseDir,
    });
    expect(yield* Effect.flip(admit(bot, routine, occurrence))).toBe(
      "Bot workspace does not match its expected location.",
    );
    expect(yield* orchestrator.getThreadShell(occurrenceThreadId)).toBeNull();
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "refuses to send a routine into an existing conversation above its project permission ceiling",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const projectService = yield* ProjectService.ProjectService;
      const settings = yield* ServerSettingsService;
      const config = yield* ServerConfig;
      const path = yield* Path.Path;
      yield* settings.insertBotProfileIfAbsent(bot);
      yield* settings.updateSettings({ defaultRuntimeMode: "approval-required" });
      const workspace = standaloneBotWorkspace(path.join(config.baseDir, "bot-workspaces"), bot.id);
      yield* projectService.create({
        commandId: CommandId.make("seed-project"),
        projectId: workspace.projectId,
        title: bot.name,
        workspaceRoot: workspace.workspaceRoot,
        createWorkspaceRootIfMissing: true,
      });
      yield* orchestrator.dispatch({
        type: "thread.bot.create",
        commandId: CommandId.make("seed-privileged-thread"),
        threadId: occurrenceThreadId,
        projectId: workspace.projectId,
        botId: bot.id,
        title: routine.name,
        modelSelection: bot.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "server",
      });
      const admit = yield* makeRoutineAdmission;
      const refusal = yield* Effect.flip(admit(bot, routine, occurrence));
      expect(refusal).toMatchObject({
        _tag: "OrchestratorThreadAboveModeLimitError",
        mode: "runtime",
      });
      const projection = yield* orchestrator.getThreadProjection(occurrenceThreadId);
      expect(projection.thread.runtimeMode).toBe("full-access");
      expect(projection.runs).toEqual([]);
      expect(projection.messages).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
);
