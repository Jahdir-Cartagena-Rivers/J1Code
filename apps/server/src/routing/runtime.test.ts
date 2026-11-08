// @effect-diagnostics nodeBuiltinImport:off

import {
  EnvironmentId,
  DEFAULT_SERVER_SETTINGS,
  CommandId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import { expect, it } from "vite-plus/test";

import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../config.ts";

import { shouldWakeRouteDrain } from "./engineDrain.ts";

it("wakes for release of an approval, not routine tool activity", () => {
  const activity = (kind: string) =>
    ({ type: "thread.activity-appended", payload: { activity: { kind } } }) as OrchestrationEvent;
  expect(shouldWakeRouteDrain(activity("tool.completed"))).toBe(false);
  expect(shouldWakeRouteDrain(activity("approval.resolved"))).toBe(true);
  expect(shouldWakeRouteDrain(activity("user-input.resolved"))).toBe(true);
  expect(shouldWakeRouteDrain({ type: "thread.session-set" } as OrchestrationEvent)).toBe(true);
});
function makeOrchestrationLayer(
  databasePath?: string,
  repositoryIdentityResolver?: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"],
) {
  const persistence = databasePath
    ? makeSqlitePersistenceLive(databasePath)
    : SqlitePersistenceMemory;
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-orchestration-engine-test-",
  });
  return Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(
      repositoryIdentityResolver
        ? Layer.succeed(
            RepositoryIdentityResolver.RepositoryIdentityResolver,
            repositoryIdentityResolver,
          )
        : RepositoryIdentityResolver.layer,
    ),
    Layer.provideMerge(persistence),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

import { RoutingRuntimeLive } from "./runtime.ts";
import { RoutingBoundaryPorts } from "../mcp/toolkits/routing/boundary.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ExternalRouteEndpoints } from "./ExternalRouteEndpoints.ts";
import type { ExternalRouteDelivery } from "@t3tools/contracts";

effectIt.effect(
  "joins native transport receipts, acknowledgement and ancestry through the real registered runtime",
  () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const registry = yield* ExternalRouteEndpoints;
      const createdAt = "2026-11-08T00:00:00.000Z";
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("merged-p"),
        projectId: ProjectId.make("merged-p"),
        title: "Original project",
        workspaceRoot: process.cwd(),
        defaultModelSelection: null,
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("merged-source"),
        threadId: ThreadId.make("merged-source"),
        projectId: ProjectId.make("merged-p"),
        title: "Original chat",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      const source = { environmentId: "env", projectId: "merged-p", threadId: "merged-source" };
      const destination = {
        environmentId: "env",
        projectId: "mausbot:crown",
        threadId: "mausbot:crown:main",
      };
      let pending: ExternalRouteDelivery | undefined;
      registry.register({
        kind: "mausbot",
        accepts: (id) => id === destination.threadId,
        source: () =>
          Effect.succeed({
            endpoint: destination,
            url: "/assistants",
            runtimeMode: "full-access",
            providerKey: "native-codex",
            permissionsKnown: true,
            archived: false,
            blocked: false,
            activeGeneration: "generation",
            canSteer: true,
          }),
        deliver: (input) =>
          Effect.gen(function* () {
            pending = input;
            expect(yield* registry.receive({ kind: "routeSourceCheck", delivery: input })).toBe(
              true,
            );
            return "admitted" as const;
          }),
        notice: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        const ports = yield* RoutingBoundaryPorts;
        const requestId = "a".repeat(64);
        const result = yield* ports.submit({
          route: {
            requestId,
            taskId: "merged-task",
            source,
            destination,
            content: "Current user instruction",
            mode: "auto",
            initiation: "automatic",
            ambiguous: false,
            visited: [],
            maxHops: 8,
          },
          fingerprint: "intent",
          originalRequest: "Current user instruction",
          sourceUrl: "/env/merged-source",
        });
        expect(result.status).toBe("admitted");
        expect(result.receipts).toEqual([]);
        expect(pending).toBeDefined();
        const delivery = pending!;
        expect(
          yield* registry
            .receive({
              kind: "routeTransport",
              delivery: { ...delivery, fingerprint: "forged" },
              generation: "generation",
              providerTurnId: "native-turn",
            })
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
        expect((yield* ports.get(requestId))?.status).toBe("admitted");
        yield* registry.receive({
          kind: "routeTransport",
          delivery,
          generation: "generation",
          providerTurnId: "native-turn",
        });
        yield* registry.receive({
          kind: "routeTransport",
          delivery,
          generation: "generation",
          providerTurnId: "native-turn",
        });
        expect((yield* ports.get(requestId))?.status).toBe("delivered");
        expect((yield* ports.policy(destination, "next", "merged-task")).visited).toContainEqual(
          source,
        );
        expect(
          yield* registry.call(
            {
              kind: "mausbot",
              environmentId: "env",
              botId: "crown",
              threadId: "main",
              generation: "generation",
            },
            "route_task",
            {
              taskId: "merged-task",
              requestId: "return-to-origin",
              request: "Return this work",
              candidate: source,
            },
          ),
        ).toMatchObject({ status: "blocked", reason: "routing-loop" });
        expect((yield* ports.receipt!(destination, requestId, "accepted")).status).toBe("accepted");
        expect((yield* ports.receipt!(destination, requestId, "completed")).status).toBe(
          "completed",
        );
      }).pipe(Effect.provide(RoutingRuntimeLive));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeOrchestrationLayer(),
          ExternalRouteEndpoints.layer,
          Layer.succeed(ServerEnvironment, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("env")),
            getDescriptor: Effect.die("unused"),
          }),
          Layer.succeed(ServerSettingsService, {
            getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, chatRoutingMode: "auto" }),
          } as unknown as ServerSettingsService["Service"]),
        ),
      ),
    ),
);

effectIt.effect(
  "registered runtime persists suggestions, discovers owners and admits auto routes",
  () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const createdAt = "2026-11-01T00:00:00.000Z";
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("p"),
        projectId: ProjectId.make("p"),
        title: "P",
        workspaceRoot: process.cwd(),
        defaultModelSelection: null,
        createdAt,
      });
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("p2"),
        projectId: ProjectId.make("p2"),
        title: "Destination project",
        workspaceRoot: `${process.cwd()}/route-target`,
        defaultModelSelection: null,
        createdAt,
      });
      for (const id of ["source", "destination"])
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(id),
          threadId: ThreadId.make(id),
          projectId: ProjectId.make(id === "source" ? "p" : "p2"),
          title: id,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        });
      yield* Effect.gen(function* () {
        const ports = yield* RoutingBoundaryPorts;
        const source = { environmentId: "env", projectId: "p", threadId: "source" };
        const destination = { ...source, projectId: "p2", threadId: "destination" };
        yield* ports.claim!(destination, "task", "claim");
        expect(yield* ports.owner(source, "task")).toEqual({ destination, ambiguous: false });
        const suggestion = yield* ports.submit({
          route: {
            requestId: "suggestion",
            taskId: "task",
            source,
            destination,
            content: "review",
            mode: "suggest",
            initiation: "automatic",
            ambiguous: false,
            visited: [],
            maxHops: 8,
          },
          fingerprint: "suggestion",
          originalRequest: "review",
          sourceUrl: "/env/source",
        });
        expect(suggestion.status).toBe("suggested");
        const row = yield* ports.submit({
          route: {
            requestId: "r",
            taskId: "task",
            source,
            destination,
            content: "request",
            mode: "auto",
            initiation: "automatic",
            ambiguous: false,
            visited: [],
            maxHops: 8,
          },
          fingerprint: "intent",
          originalRequest: "request",
          sourceUrl: "/env/source",
        });
        expect(row.status).toBe("admitted");
        expect(row.receipts).toEqual([]);
        expect((yield* ports.list(source)).length).toBe(2);
        expect((yield* ports.policy(destination, "next", "task")).visited).toContainEqual(source);
        expect((yield* ports.policy(destination, "other", "unrelated-task")).visited).toEqual([]);
        expect(yield* ports.receipt!(source, "r", "accepted").pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
        });
        expect(
          yield* ports.receipt!(destination, "r", "completed").pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
        yield* ports.release!(source, "task", "wrong-owner-release");
        expect((yield* ports.owner(source, "task")).destination).toEqual(destination);
        yield* ports.release!(destination, "task", "release");
        yield* ports.release!(destination, "task", "release");
        expect((yield* ports.owner(source, "task")).destination).toBeNull();
        expect((yield* ports.get("r"))?.status).toBe("admitted");
        const coordinator = { ...source, threadId: "coordinator" };
        for (const id of ["coordinator", "competing-coordinator"])
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(id),
            threadId: ThreadId.make(id),
            projectId: ProjectId.make("p"),
            title: id,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
          });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("coordinator-busy"),
          threadId: ThreadId.make("coordinator"),
          createdAt,
          session: {
            threadId: ThreadId.make("coordinator"),
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("busy-turn"),
            lastError: null,
            updatedAt: createdAt,
          },
        });
        const proposed = yield* ports.owner(
          source,
          "new-audio-work",
          undefined,
          "Improve transcription",
        );
        expect(proposed).toEqual({ destination: coordinator, ambiguous: true });
        const proposedRoute = yield* ports.submit({
          route: {
            requestId: "working-proposal",
            taskId: "new-audio-work",
            source,
            destination: proposed.destination,
            content: "Improve transcription",
            mode: "auto",
            initiation: "automatic",
            ambiguous: proposed.ambiguous,
            visited: [],
            maxHops: 8,
          },
          fingerprint: "working-proposal",
          originalRequest: "Improve transcription",
          sourceUrl: "/env/source",
        });
        expect(proposedRoute.status).toBe("suggested");
        expect(proposedRoute.receipts).toEqual([]);
        yield* engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive-proposal"),
          threadId: ThreadId.make("coordinator"),
        });
        expect(
          (yield* ports.owner(source, "new-audio-work", undefined, "Improve transcription"))
            .destination,
        ).toBeNull();
        yield* engine.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make("restore-proposal"),
          threadId: ThreadId.make("coordinator"),
        });

        for (const mode of ["auto", "suggest"] as const)
          yield* ports.submit({
            route: {
              requestId: `integration-${mode}`,
              taskId: "audio-build-integration",
              source,
              destination: null,
              content: "Include completed audio changes in the next build",
              mode,
              initiation: "automatic",
              ambiguous: true,
              visited: [],
              maxHops: 8,
            },
            fingerprint: `integration-${mode}`,
            originalRequest: "Include completed audio changes in the next build",
            sourceUrl: "/env/source",
          });
        expect((yield* ports.get("integration-auto"))?.status).toBe("suggested");
        yield* ports.claim!(coordinator, "project-build-integration", "claim-coordinator");
        expect(yield* ports.owner(source, "audio-build-integration")).toEqual({
          destination: coordinator,
          ambiguous: false,
        });
        expect((yield* ports.get("integration-auto"))?.status).toBe("queued");
        expect((yield* ports.get("integration-suggest"))?.status).toBe("suggested");
        expect((yield* ports.get("integration-auto"))?.receipts).toEqual([]);
        const snapshots = yield* ProjectionSnapshotQuery;
        const sourceDetail = Option.getOrThrow(
          yield* snapshots.getThreadDetailById(ThreadId.make("source")),
        );
        expect(
          Option.getOrThrow(yield* snapshots.getThreadShellById(ThreadId.make("source")))
            .hasPendingApprovals,
        ).toBe(false);
        expect(sourceDetail.activities).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "routing.updated",
              payload: expect.objectContaining({ requestId: "integration-auto", status: "queued" }),
            }),
          ]),
        );
        expect((yield* ports.owner(source, "unrelated-audio-fix")).ambiguous).toBe(true);
        expect((yield* ports.owner(destination, "audio-build-integration")).destination).toBeNull();
        yield* ports.claim!(
          { ...coordinator, threadId: "competing-coordinator" },
          "project-build-integration",
          "claim-competing",
        );
        expect((yield* ports.owner(source, "audio-build-integration")).ambiguous).toBe(true);
        yield* ports.claim!(destination, "audio-build-integration", "claim-exact");
        expect(yield* ports.owner(source, "audio-build-integration")).toEqual({
          destination,
          ambiguous: false,
        });
      }).pipe(Effect.provide(RoutingRuntimeLive));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeOrchestrationLayer(),
          Layer.succeed(ServerEnvironment, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("env")),
            getDescriptor: Effect.die("unused"),
          }),
          Layer.succeed(ServerSettingsService, {
            getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, chatRoutingMode: "auto" }),
          } as unknown as ServerSettingsService["Service"]),
        ),
      ),
    ),
);
