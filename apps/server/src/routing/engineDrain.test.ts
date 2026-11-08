// @effect-diagnostics nodeBuiltinImport:off

import {
  CommandId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  ServerProvider,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { expect, it } from "vite-plus/test";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { ExternalRouteEndpoints } from "./ExternalRouteEndpoints.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

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

effectIt.effect(
  "revalidates a real external source inside serialized admission without creating a source projection",
  () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const adapters = yield* ExternalRouteEndpoints;
      const snapshots = yield* ProjectionSnapshotQuery;
      const projectId = ProjectId.make("external-target-project");
      const threadId = ThreadId.make("external-target");
      const createdAt = "2026-01-01T00:00:00.000Z";
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("external-project"),
        projectId,
        title: "Target",
        workspaceRoot: process.cwd(),
        defaultModelSelection: null,
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("external-thread"),
        threadId,
        projectId,
        title: "Target",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      const source = {
        environmentId: "e",
        projectId: "mausbot:crown",
        threadId: "mausbot:crown:main",
      };
      let calls = 0;
      let revokeAtAdmission = true;
      adapters.register({
        kind: "mausbot",
        accepts: (id) => id === source.threadId,
        source: () =>
          Effect.sync(() => ({
            endpoint: source,
            url: "/assistants?environmentId=e&botId=crown&conversation=main",
            runtimeMode: "full-access" as const,
            providerKey: "native-codex",
            permissionsKnown: !(revokeAtAdmission && ++calls === 2),
            archived: false,
          })),
      });
      const store = yield* makeDurableRoutingStore;
      yield* store.create({
        requestId: "external-request",
        source,
        destination: { environmentId: "e", projectId, threadId },
        content: "Forwarded original request",
        permissionCeiling: ["runtime:full-access"],
        destinationPermissions: ["runtime:full-access"],
        visited: [],
        maxHops: 3,
        ambiguous: false,
        mode: "auto",
        initiation: "automatic",
      });
      const drain = yield* makeEngineRouteDrain;
      yield* drain.drain();
      expect(calls).toBe(2);
      expect((yield* store.get("external-request"))?.state.status).toBe("queued");
      expect(
        (yield* engine.readEvents(0, 100).pipe(Stream.runCollect)).filter(
          (event) => event.type === "thread.turn-start-requested",
        ),
      ).toHaveLength(0);
      revokeAtAdmission = false;
      yield* drain.drain();
      const saved = (yield* store.get("external-request"))!;
      expect(saved.state.status).toBe("admitted");
      expect(saved.state.receipts).toEqual([]);
      expect(
        Option.isNone(yield* snapshots.getThreadShellById(ThreadId.make(source.threadId))),
      ).toBe(true);
      const events = yield* engine.readEvents(0, 100).pipe(Stream.runCollect);
      expect(events.filter((event) => event.type === "thread.turn-start-requested")).toHaveLength(
        1,
      );
      expect(events.find((event) => event.type === "thread.message-sent")?.metadata).toMatchObject({
        sourceThreadId: source.threadId,
        provenance: "/assistants?environmentId=e&botId=crown&conversation=main",
      });
    }).pipe(
      Effect.provide(
        makeOrchestrationLayer().pipe(
          Layer.provideMerge(ExternalRouteEndpoints.layer),
          Layer.provide(
            makeProviderRegistryLayer([
              Schema.decodeUnknownSync(ServerProvider)({
                instanceId: "codex",
                driver: "codex",
                enabled: true,
                installed: true,
                version: null,
                status: "ready",
                auth: { status: "authenticated" },
                checkedAt: "2026-01-01T00:00:00Z",
                models: [{ slug: "default", name: "Default", isCustom: false, capabilities: null }],
              }),
            ]),
          ),
        ),
      ),
    ),
);

effectIt.effect(
  "delivers to the original native endpoint with active capability gates and durable uncertainty",
  () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const registry = yield* ExternalRouteEndpoints;
      const snapshots = yield* ProjectionSnapshotQuery;
      const projectId = ProjectId.make("native-source-project");
      const threadId = ThreadId.make("native-source-j1");
      const createdAt = "2026-01-01T00:00:00.000Z";
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("native-source-project"),
        projectId,
        title: "Existing project",
        workspaceRoot: process.cwd(),
        defaultModelSelection: null,
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("native-source-thread"),
        projectId,
        threadId,
        title: "Original J1",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      const destination = {
        environmentId: "e",
        projectId: "mausbot:crown",
        threadId: "mausbot:crown:main",
      };
      let blocked = true,
        canSteer = false,
        sends = 0;
      let outcome: "admitted" | "uncertain" = "admitted";
      let proofAvailable = false;
      registry.register({
        kind: "mausbot",
        accepts: (id) => id === destination.threadId,
        proof: () =>
          Effect.succeed(
            proofAvailable
              ? { generation: "real-generation", providerTurnId: "real-provider-turn" }
              : null,
          ),
        source: () =>
          Effect.succeed({
            endpoint: destination,
            url: "/assistants",
            providerKey: "native-provider",
            runtimeMode: "full-access",
            archived: false,
            permissionsKnown: true,
            activeGeneration: "real-generation",
            blocked,
            canSteer,
          }),
        deliver: (input) =>
          Effect.sync(() => {
            expect(input.expectedGeneration).toBe("real-generation");
            sends++;
            return outcome;
          }),
      });
      const store = yield* makeDurableRoutingStore;
      const create = (requestId: string) =>
        store.create({
          requestId,
          source: { environmentId: "e", projectId, threadId },
          destination,
          content: "Update active work",
          permissionCeiling: ["runtime:full-access"],
          destinationPermissions: ["runtime:full-access"],
          visited: [],
          maxHops: 3,
          ambiguous: false,
          mode: "auto",
          initiation: "automatic",
        });
      const first = "a".repeat(64),
        second = "b".repeat(64);
      yield* create(first);
      const drain = yield* makeEngineRouteDrain;
      yield* drain.drain();
      expect(sends).toBe(0);
      blocked = false;
      yield* drain.drain();
      expect(sends).toBe(0);
      canSteer = true;
      yield* drain.drain();
      expect((yield* store.get(first))?.state.status).toBe("admitted");
      expect((yield* store.get(first))?.state.receipts).toEqual([]);
      yield* drain.drain();
      expect(sends).toBe(1);
      outcome = "uncertain";
      yield* create(second);
      yield* drain.drain();
      expect((yield* store.get(second))?.state.status).toBe("uncertain");
      yield* drain.drain();
      expect(sends).toBe(2);
      proofAvailable = true;
      yield* drain.drain();
      expect((yield* store.get(first))?.state.status).toBe("delivered");
      expect((yield* store.get(second))?.state.status).toBe("delivered");
      expect(sends).toBe(2);
      expect(
        Option.isNone(yield* snapshots.getThreadShellById(ThreadId.make(destination.threadId))),
      ).toBe(true);
      expect(
        (yield* engine.readEvents(0, 100).pipe(Stream.runCollect)).filter(
          (event) => event.type === "thread.turn-start-requested",
        ),
      ).toHaveLength(0);
    }).pipe(
      Effect.provide(
        makeOrchestrationLayer().pipe(Layer.provideMerge(ExternalRouteEndpoints.layer)),
      ),
    ),
);

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
