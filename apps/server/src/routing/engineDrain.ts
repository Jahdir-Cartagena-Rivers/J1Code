import {
  ThreadId, type ChatRoutingMode, type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@j1code/contracts";
import * as KeyedLock from "@j1code/shared/KeyedLock";
import { Context, Effect, Layer, Option, Scope, Semaphore, Stream } from "effect";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { CommandReceiptStoreV2 } from "../orchestration-v2/CommandReceiptStore.ts";
import { EffectOutboxV2 } from "../orchestration-v2/EffectOutbox.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { strictSteerFingerprint } from "../orchestration-v2/ProviderTurnControlService.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeDurableRoutingStore, type StoredRoute } from "./durableRoutingStore.ts";
import { ExternalRouteEndpoints } from "./ExternalRouteEndpoints.ts";
import type { RouteEndpoint, RouteState } from "./routeState.ts";
import { makeRouteSourceNotifier } from "./sourceActivity.ts";
import { makeRouteTransportConsumer } from "./transportConsumer.ts";
import { makeV2StrictAdmission } from "./v2StrictAdmission.ts";
import { prepareV2StrictDelivery, submitV2StrictDelivery } from "./v2StrictDelivery.ts";
import { V2RouteAdmission } from "./v2RouteAdmission.ts";
import { idleRouteDraft, readIdleDeliveryEvidence } from "./v2IdleDelivery.ts";

export function shouldWakeRouteDrain(event: OrchestrationV2DomainEvent): boolean {
  switch (event.type) {
    case "runtime-request.updated":
      return event.payload.status !== "pending";
    case "run.updated":
    case "provider-turn.updated":
    case "provider-thread.updated":
    case "thread.runtime-mode-updated":
    case "thread.interaction-mode-updated":
    case "thread.provider-switched":
    case "thread.model-selection-updated":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
      return true;
    default:
      return false;
  }
}

export function nativeRouteTarget(
  shell: Pick<OrchestrationV2ThreadShell, "activeRunId" | "activityRunStatus" | "pendingRuntimeRequest">,
) {
  if (shell.pendingRuntimeRequest !== null) return { status: "held-unavailable" } as const;
  if (shell.activeRunId === null) return { status: "held-idle" } as const;
  return shell.activityRunStatus === "running"
    ? { status: "active", runId: shell.activeRunId } as const
    : { status: "held-unavailable" } as const;
}

const sameEndpoint = (a: RouteEndpoint, b: RouteEndpoint) =>
  a.environmentId === b.environmentId && a.projectId === b.projectId && a.threadId === b.threadId;

export function routeOwnerMayDrain(state: RouteState, mode: ChatRoutingMode): boolean {
  const { request, resolution } = state;
  const destination = request.destination;
  if (state.status !== "queued" || state.strictSubmission !== undefined ||
      state.idleSubmission !== undefined || destination === null ||
      request.ambiguous || !Number.isSafeInteger(request.maxHops) ||
      request.maxHops <= request.visited.length) return false;
  if (resolution !== null) {
    if (!resolution.userId.trim() || !sameEndpoint(resolution.source, request.source) ||
        !sameEndpoint(resolution.source, state.originalRequest.source) ||
        !sameEndpoint(resolution.destination, destination) ||
        strictSteerFingerprint(resolution.destinationPermissions) !==
          strictSteerFingerprint(request.destinationPermissions))
      return false;
  } else if (request.initiation !== "manual" && (request.mode !== "auto" || mode !== "auto")) {
    return false;
  }
  const path = [...request.visited, request.source, destination];
  return !path.some((endpoint, index) => path.slice(0, index).some((other) => sameEndpoint(endpoint, other)));
}

export class V2RoutingOwner extends Context.Service<V2RoutingOwner, {
  readonly drain: () => Effect.Effect<void>;
  readonly start: Effect.Effect<void>;
}>()("@j1code/server/routing/engineDrain/V2RoutingOwner") {}

const make = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const sink = yield* EventSinkV2;
  const outbox = yield* EffectOutboxV2;
  const projection = yield* ProjectionStoreV2;
  const providers = yield* ProviderRegistry;
  const settings = yield* ServerSettingsService;
  const admission = yield* V2RouteAdmission;
  const environment = yield* ServerEnvironment;
  const envId = yield* environment.getEnvironmentId;
  const external = yield* Effect.serviceOption(ExternalRouteEndpoints);
  const store = yield* makeDurableRoutingStore;
  const notify = yield* makeRouteSourceNotifier;
  const services = yield* Effect.context<
    OrchestratorV2 | ProviderSessionManagerV2 | RuntimePolicyV2 |
    CommandReceiptStoreV2 | EffectOutboxV2 | EventSinkV2
  >();
  const idleServices = yield* Effect.context<
    OrchestratorV2 | EventSinkV2 | CommandReceiptStoreV2 | EffectOutboxV2 | ProjectionStoreV2
  >();
  const withRouteFence = (yield* KeyedLock.make<string>()).withLock;
  const mutex = yield* Semaphore.make(1);
  const startup = yield* Semaphore.make(1);
  let ready = false;

  const transport = yield* makeRouteTransportConsumer({
    withRouteFence, notify, scope, wake: Effect.suspend(() => drain()),
  });

  const shellFor = Effect.fn("V2RoutingOwner.shellFor")(function* (endpoint: RouteEndpoint) {
    const shell = yield* projection.getThreadShell(ThreadId.make(endpoint.threadId));
    return shell?.id === endpoint.threadId && shell.projectId === endpoint.projectId &&
      shell.archivedAt === null && shell.deletedAt === null ? shell : null;
  });

  const recoverExternal = Effect.fn("V2RoutingOwner.recoverExternal")(function* (id: string) {
    if (Option.isNone(external)) return;
    const row = yield* store.get(id);
    const destination = row?.state.request.destination;
    const attemptId = row?.state.attemptId;
    if (!row || row.state.strictSubmission !== undefined || !destination || !attemptId ||
        destination.environmentId !== envId || !destination.threadId.startsWith("mausbot:") ||
        !["admitted", "uncertain"].includes(row.state.status)) return;
    const proof = yield* external.value.proof({
      requestId: id, fingerprint: row.state.fingerprint, attemptId, destination,
    }).pipe(Effect.orElseSucceed(() => null));
    if (!proof?.generation || !proof.providerTurnId) return;
    const updated = yield* withRouteFence(id, Effect.gen(function* () {
      const current = yield* store.get(id);
      if (current?.state.attemptId !== attemptId || current.state.strictSubmission !== undefined ||
          !["admitted", "uncertain"].includes(current.state.status)) return null;
      return yield* store.transition(id, current.revision, {
        type: "receipt",
        receipt: {
          receiptId: `native:${id}:${attemptId}:delivered`, requestId: id,
          fingerprint: row.state.fingerprint, attemptId, destination, kind: "delivered",
        },
      });
    }));
    if (updated !== null) yield* notify(updated);
  });

  const deliverExternal = Effect.fn("V2RoutingOwner.deliverExternal")(function* (row: StoredRoute) {
    if (Option.isNone(external)) return;
    const bridge = external.value;
    const { request } = row.state;
    const destination = request.destination;
    if (destination === null || !destination.threadId.startsWith("mausbot:") ||
        (yield* projection.getThreadShell(ThreadId.make(destination.threadId))) !== null) return;
    const sourceShell = yield* shellFor(request.source);
    const externalSource = request.source.threadId.startsWith("mausbot:");
    if ((!externalSource && sourceShell === null) || (externalSource &&
      (yield* projection.getThreadShell(ThreadId.make(request.source.threadId))) !== null)) return;
    const source = externalSource
      ? yield* bridge.source(request.source.threadId).pipe(Effect.orElseSucceed(() => null))
      : null;
    const target = yield* bridge.source(destination.threadId).pipe(Effect.orElseSucceed(() => null));
    if (
      target === null || !sameEndpoint(target.endpoint, destination) ||
      target.archived || target.blocked || !target.permissionsKnown || target.runtimeMode !== "full-access" ||
      (target.activeGeneration != null && !target.canSteer) ||
      (externalSource
        ? (!source || !sameEndpoint(source.endpoint, request.source) || source.archived ||
          !source.permissionsKnown || source.runtimeMode !== "full-access")
        : sourceShell?.runtimeMode !== "full-access" || sourceShell.pendingRuntimeRequest !== null) ||
      !request.permissionCeiling.includes("runtime:full-access") ||
      !request.destinationPermissions.includes("runtime:full-access")
    ) return;
    const id = request.requestId;
    const attemptId = `route:${id}:${row.revision}`;
    const claimed = yield* withRouteFence(id, store.transition(id, row.revision, { type: "begin-send", attemptId }));
    const outcome = yield* bridge.deliver({
      requestId: id, fingerprint: claimed.state.fingerprint, attemptId,
      source: request.source, destination, content: request.content,
      permissionCeiling: request.permissionCeiling, visited: request.visited,
      expectedGeneration: target.activeGeneration ?? null,
    }).pipe(Effect.orElseSucceed(() => "uncertain" as const));

    const updated = yield* withRouteFence(id, Effect.gen(function* () {
      const current = yield* store.get(id);
      if (current?.state.attemptId !== attemptId || current.state.status !== "sending" ||
          current.state.strictSubmission !== undefined) return null;
      return yield* store.transition(id, current.revision, outcome === "delivered" ? {
        type: "receipt",
        receipt: {
          receiptId: `native:${id}:${attemptId}:delivered`, requestId: id,
          fingerprint: current.state.fingerprint, attemptId, destination, kind: "delivered",
        },
      } : { type: outcome === "rejected" ? "admission-rejected" :
        outcome === "admitted" ? "admitted" : "send-interrupted" });
    }));
    if (updated !== null) yield* notify(updated);
  });

  const idleWatching = new Set<string>();
  const reconcileIdle = Effect.fn("V2RoutingOwner.reconcileIdle")(function* (id: string) {
    const result = yield* withRouteFence(id, Effect.gen(function* () {
      const row = yield* store.get(id);
      const claim = row?.state.idleSubmission;
      if (!row || !claim || !["sending", "admitted", "uncertain"].includes(row.state.status)) return null;
      const result = yield* readIdleDeliveryEvidence(claim.command).pipe(Effect.provide(idleServices));
      const next = yield* store.settleIdleSubmission(id, row.revision, claim.commandFingerprint, result.evidence);
      return { ...result, notify: next.revision === row.revision ? null : next };
    }));
    if (result?.notify) yield* notify(result.notify);
    return result;
  });

  const observeIdle = Effect.fn("V2RoutingOwner.observeIdle")(function* (id: string) {
    const result = yield* reconcileIdle(id);
    if (result?.evidence !== "admitted" || !("effectId" in result) || !result.effectId ||
        idleWatching.has(result.effectId)) return;
    const { effectId } = result;
    idleWatching.add(effectId);
    yield* outbox.awaitSettled(effectId).pipe(
      Effect.andThen(reconcileIdle(id)),
      Effect.andThen(Effect.suspend(() => drain())),
      Effect.catchCause((cause) => Effect.logWarning("Idle route settlement deferred", { cause })),
      Effect.ensuring(Effect.sync(() => { idleWatching.delete(effectId); })),
      Effect.forkIn(scope),
    );
  });

  const recoverIdle = Effect.fn("V2RoutingOwner.recoverIdle")(function* () {
    const last = yield* store.lastUnconfirmedIdle();
    if (last === null) return;
    let after = "";
    while (true) {
      const ids = yield* store.unconfirmedIdle(after, last);
      const next = ids.at(-1);
      if (next === undefined) return;
      for (const id of ids) yield* observeIdle(id).pipe(Effect.catchCause((cause) =>
        Effect.logWarning("Idle route recovery deferred", { requestId: id, cause }),
      ));
      after = next;
    }
  });

  const deliverIdle = Effect.fn("V2RoutingOwner.deliverIdle")(function* (
    row: StoredRoute, shell: OrchestrationV2ThreadShell,
  ) {
    const id = row.state.request.requestId;
    const draft = idleRouteDraft(row, `route:${id}:${row.revision}`, shell);
    const authority = yield* admission.prepareIdle(row, draft);
    if (authority === null) return;
    const command = { ...draft, ...authority };
    yield* withRouteFence(id, store.claimIdleSubmission(id, row.revision, row.state.fingerprint, command));
    // The claim commits before the thread writer. Taking the routing fence into the writer would
    // invert lock order. The writer revalidates the saved descriptor and never queues it.
    yield* Effect.service(OrchestratorV2).pipe(
      Effect.flatMap((orchestrator) => orchestrator.dispatch(command)),
      Effect.provide(idleServices),
      Effect.result,
    );
    yield* observeIdle(id);
  });

  const observeIdleEvent = Effect.fn("V2RoutingOwner.observeIdleEvent")(function* (event: OrchestrationV2DomainEvent) {
    const runId = event.type === "run.updated" ? event.payload.id :
      event.type === "provider-turn.updated" || event.type === "run-attempt.updated" ? event.runId : null;
    if (runId?.startsWith("run:route-idle:")) {
      const id = yield* store.idleRequestForRun(runId);
      if (id !== null) yield* observeIdle(id);
    }
  });

  const attempt = Effect.fn("V2RoutingOwner.attempt")(function* (id: string) {
    const row = yield* store.get(id);
    const mode = (yield* settings.getSettings).chatRoutingMode;
    if (!row || !routeOwnerMayDrain(row.state, mode)) return;
    const { request } = row.state;
    const destination = request.destination;
    if (destination === null || destination.environmentId !== envId ||
        request.source.environmentId !== envId) return;
    if (destination.threadId.startsWith("mausbot:")) return yield* deliverExternal(row);
    const shell = yield* shellFor(destination);
    if (shell === null ||
        !request.permissionCeiling.includes(`runtime:${shell.runtimeMode}`) ||
        !request.destinationPermissions.includes(`runtime:${shell.runtimeMode}`)) return;
    const availability = nativeRouteTarget(shell);
    if (availability.status === "held-idle") return yield* deliverIdle(row, shell);
    if (availability.status !== "active") return;

    const attemptId = `route:${id}:${row.revision}`;
    const staged = yield* prepareV2StrictDelivery({
      requestId: id, attemptId,
      source: { environmentId: envId, threadId: ThreadId.make(request.source.threadId) },
      destination: {
        environmentId: envId, projectId: shell.projectId, threadId: shell.id,
        providerInstanceId: shell.providerInstanceId, runId: availability.runId,
        runtimeMode: shell.runtimeMode, interactionMode: shell.interactionMode,
      },
      ceiling: { runtimeMode: shell.runtimeMode, interactionMode: shell.interactionMode },
      text: request.content, attachments: [],
    }).pipe(Effect.provide(services));
    if (staged.status !== "prepared") return;

    const claimed = yield* withRouteFence(id, store.transition(id, row.revision, { type: "begin-send", attemptId }));
    const result = yield* submitV2StrictDelivery(staged.delivery, makeV2StrictAdmission({
      store, withRouteFence, expected: claimed, validate: admission.validate,
    })).pipe(Effect.provide(services), Effect.result);
    const latest = yield* withRouteFence(id, Effect.gen(function* () {
      const current = yield* store.get(id);
      if (current?.state.attemptId !== attemptId) return null;
      if (current.state.status !== "sending" || current.state.strictSubmission !== undefined) return null;
      return yield* store.transition(id, current.revision, {
        type: result._tag === "Success" && result.success.status === "rejected"
          ? "admission-rejected" : "send-interrupted",
      });
    }));
    if (latest !== null) yield* notify(latest);
    yield* transport.observe(id);
  });

  const sweep = Effect.fn("V2RoutingOwner.sweep")(function* () {
    if (!ready) return;
    if (Option.isSome(external)) for (const id of yield* store.unconfirmedNative()) {
      yield* recoverExternal(id).pipe(Effect.catchCause((cause) =>
        Effect.logWarning("External route recovery deferred", { requestId: id, cause }),
      ));
    }
    for (const id of yield* store.queued()) {
      yield* attempt(id).pipe(Effect.catchCause((cause) =>
        Effect.logWarning("Route admission deferred", { requestId: id, cause }),
      ));
    }
  });

  const drain = (): Effect.Effect<void> => mutex.withPermits(1)(sweep()).pipe(Effect.catchCause((cause) =>
    Effect.logWarning("Route drain deferred", { cause }),
  ));
  const start = startup.withPermits(1)(Effect.gen(function* () {
    if (ready) return;
    const head = yield* sink.latestSequence();
    const externalEvents = Option.isSome(external) ? yield* external.value.subscribe.pipe(Effect.provideService(
      // Keep the external subscription on the same lifetime as the routing owner.
      Scope.Scope, scope,
    )) : undefined;
    yield* store.recoverInterruptedSends();
    yield* transport.recover();
    yield* recoverIdle();
    ready = true;
    yield* sink.stream({ afterSequence: head }).pipe(
      Stream.runForEach((event) => transport.consume(event).pipe(
        Effect.andThen(observeIdleEvent(event.event)),
        Effect.andThen(shouldWakeRouteDrain(event.event) ? Effect.suspend(drain) : Effect.void),
        Effect.catchCause((cause) => Effect.logWarning("Routing event deferred", { cause })),
      )),
      Effect.catchCause((cause) => Effect.logError("Routing event subscription stopped", { cause })),
      Effect.forkIn(scope),
    );
    for (const changes of [
      Stream.map(providers.streamChanges, () => undefined),
      Stream.map(settings.streamChanges, () => undefined),
      ...(externalEvents === undefined ? [] : [externalEvents]),
    ]) yield* changes.pipe(Stream.runForEach(drain), Effect.forkIn(scope));
    yield* drain();
  }).pipe(Effect.catchCause((cause) => Effect.logError("Route owner startup held", { cause }))));
  return V2RoutingOwner.of({ drain, start });
});

export const layerV2RoutingOwner = Layer.effect(V2RoutingOwner, make);

// Runtime and RPC callers share the same scoped owner.
export const makeEngineRouteDrain = Effect.service(V2RoutingOwner);
