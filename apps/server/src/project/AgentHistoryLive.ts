import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as DateTime from "effect/DateTime";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { importRecentAgentThreads } from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

/** One server-owned reader serves desktop, web and mobile through ordinary persisted message events. */
export const makeLiveHistoryRefresh = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const retryAfter = new Map<string, number>();
  const tick = Effect.gen(function* () {
    if (!(yield* settings.getSettings).liveAgentHistory) return;
    const shell = yield* snapshots.getShellSnapshot();
    const eligibleThreadIds = new Set(
      shell.threads
        .filter(
          (thread) =>
            thread.id.startsWith("import:") &&
            thread.archivedAt === null &&
            thread.latestTurn === null &&
            thread.session === null &&
            thread.latestUserMessageAt === null &&
            !thread.hasPendingApprovals &&
            !thread.hasPendingUserInput &&
            !thread.hasActionableProposedPlan,
        )
        .map((thread) => thread.id),
    );
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    for (const project of shell.projects) {
      if ((retryAfter.get(project.id) ?? 0) > now) continue;
      const result = yield* importRecentAgentThreads(
        {
          projectId: project.id,
          expectedWorkspaceRoot: project.workspaceRoot,
        },
        true,
        eligibleThreadIds,
      ).pipe(Effect.timeout("15 seconds"), Effect.result);
      if (result._tag === "Failure" || result.success.skippedCount > 0) {
        retryAfter.set(project.id, now + 30_000);
      } else {
        retryAfter.delete(project.id);
      }
    }
  }).pipe(Effect.catch((cause) => Effect.logWarning("Live history refresh failed", { cause })));
  return { refresh: tick };
});

export const AgentHistoryLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const { refresh } = yield* makeLiveHistoryRefresh;
    yield* refresh.pipe(Effect.repeat(Schedule.spaced("2 seconds")), Effect.forkScoped);
  }),
).pipe(Layer.provide(AgentSessionScanner.layer));
