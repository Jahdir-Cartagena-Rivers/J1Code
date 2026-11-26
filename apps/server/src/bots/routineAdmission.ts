import * as NodeCrypto from "node:crypto";
import { CommandId, MessageId, ThreadId, type BotProfile, type BotRoutine } from "@j1code/contracts";
import { standaloneBotWorkspace } from "@j1code/shared/bot-workspace";
import { resolveProjectSettings } from "@j1code/shared/projectSettings";
import { Effect, Option, Path } from "effect";

import { ServerConfig } from "../config.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ServerSettingsService } from "../serverSettings.ts";

/** Admit one persisted occurrence as a project bot conversation. */
export const makeRoutineAdmission = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2;
  const projects = yield* ProjectStoreV2;
  const projectService = yield* ProjectService;
  const settingsService = yield* ServerSettingsService;
  const config = yield* ServerConfig;
  const path = yield* Path.Path;
  return Effect.fn("bots.routineAdmission")(function* (bot: BotProfile, routine: BotRoutine, occurrence: number) {
    const settings = yield* settingsService.getSettings;
    const profile = Object.hasOwn(settings.bots, bot.id) ? settings.bots[bot.id] : undefined;
    if (!profile || profile.id !== bot.id || profile.archived || profile.projectId !== bot.projectId) {
      return yield* Effect.fail("Bot profile is unavailable.");
    }

    const digest = NodeCrypto.createHash("sha256")
      .update(`${bot.id.length}:${bot.id}${routine.id.length}:${routine.id}:${occurrence}`)
      .digest("hex");
    const threadId = ThreadId.make(`bot-routine:${digest}`);
    const workspace =
      profile.projectId === null
        ? standaloneBotWorkspace(path.join(config.baseDir, "bot-workspaces"), profile.id)
        : null;
    const projectId = profile.projectId ?? workspace!.projectId;
    let project = Option.getOrUndefined(yield* projects.getShell(projectId));
    if (!project && workspace) {
      yield* projectService.create({
        commandId: CommandId.make(`bot-workspace:${projectId}`),
        projectId,
        title: profile.name,
        workspaceRoot: workspace.workspaceRoot,
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: null,
      });
      project = Option.getOrUndefined(yield* projects.getShell(projectId));
    }
    if (!project || project.archivedAt != null) return yield* Effect.fail("Bot project is unavailable.");
    if (
      workspace &&
      path.resolve(project.workspaceRoot) !== path.resolve(workspace.workspaceRoot)
    ) {
      return yield* Effect.fail("Bot workspace does not match its expected location.");
    }

    const modes = {
      runtimeMode: resolveProjectSettings(settings, projectId, project).settings.defaultRuntimeMode,
      interactionMode: "default" as const,
    };
    let thread = yield* orchestrator.getThreadShell(threadId);
    if (thread === null) {
      yield* orchestrator.dispatch({
        type: "thread.bot.create",
        commandId: CommandId.make(`bot-routine-thread:${digest}`),
        threadId,
        projectId,
        botId: profile.id,
        title: routine.name,
        modelSelection: profile.modelSelection,
        ...modes,
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "server",
      });
      thread = yield* orchestrator.getThreadShell(threadId);
    }
    if (!thread || thread.projectId !== projectId || thread.bot?.id !== profile.id ||
        thread.archivedAt != null || thread.deletedAt != null) {
      return yield* Effect.fail("Bot routine conversation is unavailable.");
    }

    return yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`bot-routine-turn:${digest}`),
      threadId,
      messageId: MessageId.make(`bot-routine-message:${digest}`),
      text: routine.prompt,
      attachments: [],
      modelSelection: profile.modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "server",
    }).pipe(Effect.provideService(DispatchModeLimit, modes), Effect.asVoid);
  });
});
