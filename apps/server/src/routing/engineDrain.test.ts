import { assert, it } from "@effect/vitest";
import {
  EnvironmentId, EventId, ProjectId, ProviderInstanceId, RunId, ThreadId,
  type OrchestrationV2AppThread, type OrchestrationV2DomainEvent,
} from "@j1code/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DateTime, Effect, Layer, Ref, Stream } from "effect";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Outbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeDurableRoutingStore } from "./durableRoutingStore.ts";
import { ExternalRouteEndpoints } from "./ExternalRouteEndpoints.ts";
import { layerV2RoutingOwner, nativeRouteTarget, routeOwnerMayDrain, shouldWakeRouteDrain, V2RoutingOwner } from "./engineDrain.ts";
import { registerRoute, type RouteRequest } from "./routeState.ts";
import { V2RouteAdmission } from "./v2RouteAdmission.ts";

const env = EnvironmentId.make("env");
const projectId = ProjectId.make("project");
const sourceId = ThreadId.make("local-source");
const idleId = ThreadId.make("local-idle");
const nativeId = ThreadId.make("mausbot:native");
const provider = ProviderInstanceId.make("codex");
const endpoint = (threadId: ThreadId) => ({ environmentId: env, projectId, threadId });
const request: RouteRequest = {
  requestId: "route", source: endpoint(sourceId), destination: endpoint(idleId),
  content: "Use the right destination", permissionCeiling: ["runtime:full-access"],
  destinationPermissions: ["runtime:full-access"], visited: [], maxHops: 2,
  ambiguous: false, mode: "auto", initiation: "automatic",
};

it("distinguishes idle, pending and exact running V2 destinations", () => {
  const runId = RunId.make("active");
  assert.equal(nativeRouteTarget({ activeRunId: null, pendingRuntimeRequest: null }).status, "held-idle");
  assert.equal(nativeRouteTarget({ activeRunId: runId, pendingRuntimeRequest: null, activityRunStatus: "starting" }).status, "held-unavailable");
  assert.deepEqual(nativeRouteTarget({ activeRunId: runId, pendingRuntimeRequest: null, activityRunStatus: "running" }), { status: "active", runId });
  assert.isFalse(shouldWakeRouteDrain({ type: "turn-item.updated" } as OrchestrationV2DomainEvent));
  assert.isFalse(shouldWakeRouteDrain({ type: "runtime-request.updated", payload: { status: "pending" } } as OrchestrationV2DomainEvent));
  assert.isTrue(shouldWakeRouteDrain({ type: "runtime-request.updated", payload: { status: "resolved" } } as OrchestrationV2DomainEvent));
});

it("rechecks automatic mode, preserves manual work, and bars ancestry loops", () => {
  assert.isTrue(routeOwnerMayDrain(registerRoute(request), "auto"));
  assert.isFalse(routeOwnerMayDrain(registerRoute(request), "off"));
  assert.isTrue(routeOwnerMayDrain(registerRoute({ ...request, initiation: "manual" }), "off"));
  assert.isFalse(routeOwnerMayDrain(registerRoute({ ...request, visited: [endpoint(idleId)] }), "auto"));
});

const layer = layerV2RoutingOwner.pipe(
  Layer.provideMerge(Layer.mergeAll(
    Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(env) }),
    Layer.mock(ProviderRegistry)({ streamChanges: Stream.empty }),
    Layer.mock(OrchestratorV2)({ dispatch: () => Effect.die("idle must not dispatch") }),
    Layer.mock(RuntimePolicyV2)({}), Layer.mock(ProviderSessionManagerV2)({}),
    Layer.mock(V2RouteAdmission)({
      validate: () => Effect.die("no supported local native target"),
      prepareIdle: () => Effect.succeed(null),
    }),
    ServerSettings.layerTest({ chatRoutingMode: "auto" }), ExternalRouteEndpoints.layer,
  )),
  Layer.provideMerge(EventSink.layer),
  Layer.provideMerge(Layer.mergeAll(Projection.layer, EventStore.layer, Receipts.layer, Outbox.layer)),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(NodeServices.layer),
);

it.effect("recovers once, holds idle local routes, and sends to the real external endpoint once", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const sink = yield* EventSink.EventSinkV2;
    const owner = yield* V2RoutingOwner;
    const bridge = yield* ExternalRouteEndpoints;
    const store = yield* makeDurableRoutingStore;
    const deliveries = yield* Ref.make(0);
    const makeThread = (id: ThreadId): OrchestrationV2AppThread => ({
      id, projectId, title: "Route", createdBy: "user", creationSource: "web", providerInstanceId: provider,
      modelSelection: { instanceId: provider, model: "test" }, runtimeMode: "full-access",
      interactionMode: "default", branch: null, worktreePath: null, activeProviderThreadId: null,
      lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null, createdAt: now, updatedAt: now, archivedAt: null, deletedAt: null,
      settledOverride: null, settledAt: null, snoozedUntil: null, snoozedAt: null, lastVisitedAt: null,
    });
    yield* sink.write({ events: [sourceId, idleId].map((id) => ({
      type: "thread.created" as const, id: EventId.make(`event:${id}`),
      threadId: id, occurredAt: now, payload: makeThread(id),
    })) });
    const unregister = bridge.register({
      kind: "maus-fixture", accepts: (id) => id === nativeId,
      source: () => Effect.succeed({
        endpoint: endpoint(nativeId), url: "https://example.test", archived: false,
        permissionsKnown: true, runtimeMode: "full-access", providerKey: "native-key",
        activeGeneration: "real-generation", canSteer: true,
      }),
      deliver: (delivery) => Effect.gen(function* () {
        assert.equal(delivery.expectedGeneration, "real-generation");
        assert.equal((yield* store.get(delivery.requestId))?.state.status, "sending");
        yield* Ref.update(deliveries, (n) => n + 1);
        return "delivered" as const;
      }).pipe(Effect.mapError(() => "Fixture route state unavailable")),
    });
    yield* Effect.addFinalizer(() => Effect.sync(unregister));
    yield* store.create(request);
    yield* store.create({ ...request, requestId: "external", destination: endpoint(nativeId) });
    const interrupted = yield* store.create({ ...request, requestId: "interrupted" });
    yield* store.transition("interrupted", interrupted.revision, { type: "begin-send", attemptId: "saved" });

    yield* owner.drain();
    assert.equal(yield* Ref.get(deliveries), 0);
    yield* Effect.all([owner.start, owner.start], { concurrency: "unbounded" });
    assert.equal(yield* Ref.get(deliveries), 1);
    assert.equal((yield* store.get(request.requestId))?.state.status, "queued");
    assert.equal((yield* store.get("interrupted"))?.state.status, "uncertain");
    assert.equal((yield* store.get("external"))?.state.status, "delivered");
    const projection = yield* Projection.ProjectionStoreV2;
    assert.isNull(yield* projection.getThreadShell(nativeId));
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
