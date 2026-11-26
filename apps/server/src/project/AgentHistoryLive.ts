import type { ProjectId, ThreadId } from "@j1code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProviderSessionRuntimeRepository } from "../persistence/ProviderSessionRuntime.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AgentSessionImporter } from "./AgentSessionImporter.ts";
import { decodeImportedTranscriptPayload } from "./AgentSessionScanner.ts";
import { ProjectService } from "./ProjectService.ts";

/** One server-owned reader serves desktop, web and mobile through ordinary persisted message events. */
export const makeLiveHistoryRefresh = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const projections = yield* ProjectionStoreV2;
  const runtimes = yield* ProviderSessionRuntimeRepository;
  const projects = yield* ProjectService;
  const importer = yield* AgentSessionImporter;
  const retryAfter = new Map<ProjectId, number>();
  const refresh = Effect.fn("AgentHistoryLive.refresh")(function* () {
    if (!(yield* settings.getSettings).liveAgentHistory) return;
    const eligibleByProject = new Map<ProjectId, Set<ThreadId>>();
    for (const runtime of yield* runtimes.list()) {
      if (runtime.status !== "stopped" || !runtime.threadId.startsWith("import:")) continue;
      const payload = Option.getOrUndefined(decodeImportedTranscriptPayload(runtime.runtimePayload));
      const sources = payload?.importedTranscripts?.filter((source) =>
        source.mtimeMs !== -1 &&
        source.provider === runtime.providerName &&
        source.providerInstanceId === runtime.providerInstanceId &&
        runtime.threadId === `import:${source.providerInstanceId}:${source.providerSessionId}`
      );
      if (!sources?.length) continue;

      const records = yield* projections
        .getThreadRecords(runtime.threadId, [
          "messages",
          "providerThreads",
          "runs",
          "runtimeRequests",
          "plans",
        ])
        .pipe(Effect.option);
      if (Option.isNone(records)) continue;
      const { thread, messages, providerThreads, runs, runtimeRequests, plans } = records.value;
      if (
        thread.historyOrigin !== "v1_import" ||
        thread.bot !== undefined ||
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        thread.providerInstanceId !== runtime.providerInstanceId ||
        runs.length !== 0 ||
        runtimeRequests.length !== 0 ||
        plans.some((plan) => plan.kind === "proposed_plan" && plan.status === "active") ||
        messages.length === 0 ||
        messages.some((message) =>
          message.creationSource !== "server" ||
          message.runId !== null ||
          !message.id.startsWith(`${thread.id}:`)
        )
      ) continue;
      const owner = providerThreads.find(({ id }) => id === thread.activeProviderThreadId);
      if (
        owner === undefined ||
        owner.appThreadId !== runtime.threadId ||
        owner.driver !== runtime.providerName ||
        owner.providerInstanceId !== runtime.providerInstanceId ||
        owner.nativeThreadRef?.strength !== "strong" ||
        owner.nativeThreadRef.driver !== owner.driver ||
        !sources.some((source) =>
          owner.nativeThreadRef?.nativeId ===
            (source.provider === "pi" ? source.filePath : source.providerSessionId)
        ) ||
        owner.status !== "idle" ||
        owner.providerSessionId !== null ||
        (owner.pendingBackgroundTasks?.length ?? 0) !== 0
      ) continue;

      const eligible = eligibleByProject.get(thread.projectId) ?? new Set<ThreadId>();
      eligible.add(thread.id);
      eligibleByProject.set(thread.projectId, eligible);
    }

    for (const [projectId, eligible] of eligibleByProject) {
      if ((retryAfter.get(projectId) ?? 0) > DateTime.toEpochMillis(yield* DateTime.now)) continue;
      const projectRead = yield* projects.getById(projectId).pipe(Effect.result);
      if (projectRead._tag === "Failure") {
        retryAfter.set(projectId, DateTime.toEpochMillis(yield* DateTime.now) + 30_000);
        continue;
      }
      const project = projectRead.success;
      if (
        Option.isNone(project) ||
        project.value.archivedAt != null ||
        project.value.deletedAt != null
      ) {
        continue;
      }
      if (!(yield* settings.getSettings).liveAgentHistory) return;
      const result = yield* importer.importRecentAgentThreads(
        {
          projectId,
          expectedWorkspaceRoot: project.value.workspaceRoot,
        },
        true,
        eligible,
      ).pipe(Effect.timeout("15 seconds"), Effect.result);
      if (result._tag === "Failure" || result.success.skippedCount > 0) {
        retryAfter.set(projectId, DateTime.toEpochMillis(yield* DateTime.now) + 30_000);
      } else {
        retryAfter.delete(projectId);
      }
    }
  }, Effect.catch((cause) => Effect.logWarning("Live history refresh failed", { cause })));
  return { refresh: refresh() };
});

export const AgentHistoryLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const { refresh } = yield* makeLiveHistoryRefresh;
    yield* refresh.pipe(Effect.repeat(Schedule.spaced("2 seconds")), Effect.forkScoped);
  }),
);
