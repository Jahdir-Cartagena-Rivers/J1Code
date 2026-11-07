import * as NodeCrypto from "node:crypto";
import {
  BotId,
  CommandId,
  MessageId,
  ThreadId,
  type BotProfile,
  type BotRoutine,
} from "@t3tools/contracts";
import { standaloneBotWorkspace } from "@t3tools/shared/bot-workspace";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { DateTime, Effect, Option, Path } from "effect";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";

/** Admit one persisted occurrence through the normal provider reactor. */
export const makeRoutineAdmission = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettingsService;
  const config = yield* ServerConfig;
  const paths = yield* WorkspacePaths;
  const path = yield* Path.Path;
  return (bot: BotProfile, routine: BotRoutine, occurrence: number) =>
    Effect.gen(function* () {
      const digest = NodeCrypto.createHash("sha256")
        .update(`${bot.id.length}:${bot.id}${routine.id.length}:${routine.id}:${occurrence}`)
        .digest("hex");
      const threadId = ThreadId.make(`bot-routine:${digest}`);
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const workspace =
        bot.projectId === null
          ? standaloneBotWorkspace(path.join(config.baseDir, "bot-workspaces"), BotId.make(bot.id))
          : null;
      const projectId = bot.projectId ?? workspace!.projectId;
      let project = yield* snapshots.getProjectShellById(projectId);
      if (Option.isNone(project) && workspace) {
        const workspaceRoot = yield* paths.normalizeWorkspaceRoot(workspace.workspaceRoot, {
          createIfMissing: true,
        });
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make(`bot-workspace:${workspace.projectId}`),
          projectId,
          title: bot.name,
          workspaceRoot,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: null,
          createdAt,
        });
        project = yield* snapshots.getProjectShellById(projectId);
      }
      if (Option.isNone(project)) return yield* Effect.fail("Bot project is unavailable.");
      if (
        workspace &&
        path.resolve(project.value.workspaceRoot) !== path.resolve(workspace.workspaceRoot)
      )
        return yield* Effect.fail("Bot workspace does not match its expected location.");
      const settings = yield* settingsService.getSettings;
      const runtimeMode = resolveProjectSettings(settings, projectId, project.value).settings
        .defaultRuntimeMode;
      const thread = yield* snapshots.getThreadShellById(threadId);
      if (Option.isNone(thread))
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`bot-routine-thread:${digest}`),
          threadId,
          projectId,
          title: routine.name,
          bot: { id: bot.id, name: bot.name, instructions: bot.instructions },
          modelSelection: bot.modelSelection,
          runtimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        });
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`bot-routine-turn:${digest}`),
        threadId,
        message: {
          messageId: MessageId.make(`bot-routine-message:${digest}`),
          role: "user",
          text: routine.prompt,
          attachments: [],
        },
        modelSelection: bot.modelSelection,
        runtimeMode,
        interactionMode: "default",
        createdAt,
      });
    });
});
