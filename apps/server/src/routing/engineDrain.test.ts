// @effect-diagnostics nodeBuiltinImport:off

import {
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
import { ProviderService } from "../provider/Services/ProviderService.ts";
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

effectIt.effect("persists admission without claiming provider delivery and never retries it", () =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const projectId = ProjectId.make("p");
    const createdAt = "2026-01-01T00:00:00.000Z";
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("p"),
      projectId,
      title: "P",
      workspaceRoot: process.cwd(),
      defaultModelSelection: null,
      createdAt,
    });
    for (const id of ["s", "d"])
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(id),
        threadId: ThreadId.make(id),
        projectId,
        title: id,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
    const store = yield* makeDurableRoutingStore;
    yield* store.create({
      requestId: "r",
      source: { environmentId: "e", projectId: "p", threadId: "s" },
      destination: { environmentId: "e", projectId: "p", threadId: "d" },
      content: "task",
      permissionCeiling: ["runtime:full-access", "provider:codex"],
      destinationPermissions: ["runtime:full-access", "provider:codex"],
      visited: [],
      maxHops: 3,
      ambiguous: false,
      mode: "auto",
      initiation: "automatic",
    });
    const drain = yield* makeEngineRouteDrain;
    yield* drain.drain();
    expect((yield* store.get("r"))?.state.status).toBe("admitted");
    expect((yield* store.get("r"))?.state.receipts).toEqual([]);
    const sequence = yield* engine.latestSequence;
    yield* drain.drain();
    expect(yield* engine.latestSequence).toBe(sequence);
    const events = yield* engine.readEvents(0, 100).pipe(Stream.runCollect);
    expect(events.filter((e) => e.type === "thread.turn-start-requested")).toHaveLength(1);
  }).pipe(Effect.provide(makeOrchestrationLayer())),
);

effectIt.effect("keeps a route queued while the destination runs and wakes on its idle event", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const projectId = ProjectId.make("busy-project");
      const createdAt = "2026-01-01T00:00:00.000Z";
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("busy-project"),
        projectId,
        title: "P",
        workspaceRoot: process.cwd(),
        defaultModelSelection: null,
        createdAt,
      });
      for (const id of ["source-busy", "destination-busy"]) {
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create-${id}`),
          threadId: ThreadId.make(id),
          projectId,
          title: id,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        });
      }
      const threadId = ThreadId.make("destination-busy");
      const setSession = (status: "running" | "ready") =>
        engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`session-${status}`),
          threadId,
          createdAt,
          session: {
            threadId,
            status,
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "full-access",
            activeTurnId: status === "running" ? TurnId.make("active") : null,
            lastError: null,
            updatedAt: createdAt,
          },
        });
      yield* setSession("running");
      const store = yield* makeDurableRoutingStore;
      yield* store.create({
        requestId: "busy-route",
        source: { environmentId: "e", projectId, threadId: "source-busy" },
        destination: { environmentId: "e", projectId, threadId },
        content: "Follow up",
        permissionCeiling: ["runtime:full-access", "provider:codex"],
        destinationPermissions: ["runtime:full-access", "provider:codex"],
        visited: [],
        maxHops: 3,
        ambiguous: false,
        mode: "auto",
        initiation: "automatic",
      });
      const drain = yield* makeEngineRouteDrain;
      const observed = yield* engine.subscribeDomainEvents;
      yield* drain.start;
      expect((yield* store.get("busy-route"))?.state.status).toBe("queued");
      const nextTurn = yield* observed.pipe(
        Stream.filter(
          (event) =>
            event.type === "thread.turn-start-requested" && event.payload.threadId === threadId,
        ),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* setSession("ready");
      yield* Fiber.join(nextTurn);
      const events = yield* engine.readEvents(0, 100).pipe(Stream.runCollect);
      expect(events.filter((event) => event.type === "thread.turn-start-requested")).toHaveLength(
        1,
      );
    }),
  ).pipe(Effect.provide(makeOrchestrationLayer())),
);

effectIt.effect("delivers into a capable running destination without waiting for idle", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const projectId = ProjectId.make("busy-project");
      const createdAt = "2026-01-01T00:00:00.000Z";
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("busy-project"),
        projectId,
        title: "P",
        workspaceRoot: process.cwd(),
        defaultModelSelection: null,
        createdAt,
      });
      for (const id of ["source-busy", "destination-busy"]) {
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create-${id}`),
          threadId: ThreadId.make(id),
          projectId,
          title: id,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        });
      }
      const threadId = ThreadId.make("destination-busy");
      const setSession = (status: "running" | "ready") =>
        engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`session-${status}`),
          threadId,
          createdAt,
          session: {
            threadId,
            status,
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "full-access",
            activeTurnId: status === "running" ? TurnId.make("active") : null,
            lastError: null,
            updatedAt: createdAt,
          },
        });
      yield* setSession("running");
      const store = yield* makeDurableRoutingStore;
      yield* store.create({
        requestId: "busy-route",
        source: { environmentId: "e", projectId, threadId: "source-busy" },
        destination: { environmentId: "e", projectId, threadId },
        content: "Follow up",
        permissionCeiling: ["runtime:full-access", "provider:codex"],
        destinationPermissions: ["runtime:full-access", "provider:codex"],
        visited: [],
        maxHops: 3,
        ambiguous: false,
        mode: "auto",
        initiation: "automatic",
      });
      const drain = yield* makeEngineRouteDrain;
      yield* drain.start;
      expect((yield* store.get("busy-route"))?.state.status).toBe("admitted");
      const sequence = yield* engine.latestSequence;
      yield* drain.drain();
      expect(yield* engine.latestSequence).toBe(sequence);
      const events = yield* engine.readEvents(0, 100).pipe(Stream.runCollect);
      const sent = events.filter((event) => event.type === "thread.turn-start-requested");
      expect(sent).toHaveLength(1);
      expect(sent[0]?.metadata.routeSteerTurnId).toBe("active");
    }),
  ).pipe(
    Effect.provide(
      Layer.merge(
        makeOrchestrationLayer(),
        Layer.mock(ProviderService)({
          getCapabilities: () =>
            Effect.succeed({ sessionModelSwitch: "in-session", activeTurnSteering: true }),
        }),
      ),
    ),
  ),
);
