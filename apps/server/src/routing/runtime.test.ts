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
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { expect, it } from "vite-plus/test";
import * as Fiber from "effect/Fiber";

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
import { ServerConfig } from "../config.ts";

import { makeEngineRouteDrain, shouldWakeRouteDrain } from "./engineDrain.ts";
import { makeDurableRoutingStore } from "./durableRoutingStore.ts";

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
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          } as unknown as ServerSettingsService["Service"]),
        ),
      ),
    ),
);
