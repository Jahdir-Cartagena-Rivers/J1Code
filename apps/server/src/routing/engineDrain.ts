import { CommandId, MessageId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { DateTime, Effect, Option, Semaphore, Stream } from "effect";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { makeDurableRoutingStore } from "./durableRoutingStore.ts";
import { ExternalRouteEndpoints } from "./ExternalRouteEndpoints.ts";
import { routeEndpointUrl } from "@t3tools/shared/routeEndpointUrl";
import { makeRouteSourceNotifier } from "./sourceActivity.ts";

/** Only events that can release or change admission eligibility wake the queue. */
export function shouldWakeRouteDrain(event: OrchestrationEvent): boolean {
  if (event.type === "thread.activity-appended") {
    return (
      event.payload.activity.kind === "approval.resolved" ||
      event.payload.activity.kind === "user-input.resolved"
    );
  }
  return (
    event.type === "thread.session-set" ||
    event.type === "thread.runtime-mode-set" ||
    event.type === "thread.meta-updated" ||
    event.type === "thread.unarchived" ||
    event.type === "thread.deleted" ||
    event.type === "project.deleted"
  );
}

/** One scoped owner per environment. Never starts a provider itself. The serialized engine
 * owns final permission/busy/approval admission; snapshots here are only a preflight. */
export const makeEngineRouteDrain = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const providers = yield* Effect.serviceOption(ProviderService);
  const external = yield* Effect.serviceOption(ExternalRouteEndpoints);
  const store = yield* makeDurableRoutingStore;
  const notify = yield* makeRouteSourceNotifier;
  const mutex = yield* Semaphore.make(1);
  const sweep = Effect.fn("EngineRouteDrain.drain")(function* () {
    if (Option.isSome(external))
      for (const id of yield* store.unconfirmedNative()) {
        const row = yield* store.get(id);
        const destination = row?.state.request.destination;
        if (!row || !destination || !row.state.attemptId) continue;
        const proof = yield* external.value
          .proof({
            requestId: id,
            fingerprint: row.state.fingerprint,
            attemptId: row.state.attemptId,
            destination,
          })
          .pipe(Effect.orElseSucceed(() => null));
        if (!proof?.generation || !proof.providerTurnId) continue;
        const latest = yield* store.get(id);
        if (
          !latest ||
          latest.state.attemptId !== row.state.attemptId ||
          !["admitted", "uncertain"].includes(latest.state.status)
        )
          continue;
        const saved = yield* store
          .transition(id, latest.revision, {
            type: "receipt",
            receipt: {
              receiptId: `native:${id}:${row.state.attemptId}:delivered`,
              requestId: id,
              fingerprint: row.state.fingerprint,
              attemptId: row.state.attemptId,
              destination,
              kind: "delivered",
            },
          })
          .pipe(Effect.result);
        if (saved._tag === "Success") yield* notify(saved.success);
        // The live transport callback may have won this CAS; never resend the instruction.
      }
    for (const id of yield* store.queued()) {
      const row = yield* store.get(id);
      if (!row || row.state.status !== "queued") continue;
      const request = row.state.request;
      if (
        !request.destination ||
        request.source.environmentId !== request.destination.environmentId
      )
        continue;
      const source = yield* snapshots.getThreadShellById(ThreadId.make(request.source.threadId));
      const destination = yield* snapshots.getThreadShellById(
        ThreadId.make(request.destination.threadId),
      );
      const native =
        request.source.threadId.startsWith("mausbot:") && Option.isSome(external)
          ? yield* external.value
              .source(request.source.threadId)
              .pipe(Effect.orElseSucceed(() => null))
          : null;
      if (request.destination.threadId.startsWith("mausbot:") && Option.isSome(external)) {
        if (
          Option.isSome(destination) ||
          (request.source.threadId.startsWith("mausbot:") && Option.isSome(source))
        )
          continue;
        const target = yield* external.value
          .source(request.destination.threadId)
          .pipe(Effect.orElseSucceed(() => null));
        const sourceMode = Option.isSome(source) ? source.value.runtimeMode : native?.runtimeMode;
        if (
          !target ||
          target.archived ||
          target.blocked ||
          !target.permissionsKnown ||
          target.runtimeMode !== "full-access" ||
          target.endpoint.environmentId !== request.destination.environmentId ||
          target.endpoint.projectId !== request.destination.projectId ||
          sourceMode !== "full-access" ||
          !request.permissionCeiling.includes("runtime:full-access") ||
          (Option.isSome(source)
            ? source.value.projectId !== request.source.projectId
            : !native ||
              native.archived ||
              !native.permissionsKnown ||
              native.endpoint.projectId !== request.source.projectId) ||
          (target.activeGeneration && !target.canSteer)
        )
          continue;
        const claimed = yield* store.transition(id, row.revision, {
          type: "begin-send",
          attemptId: `route:${id}:${row.revision}`,
        });
        const outcome = yield* external.value
          .deliver({
            requestId: id,
            fingerprint: claimed.state.fingerprint,
            attemptId: claimed.state.attemptId!,
            source: request.source,
            destination: request.destination,
            content: request.content,
            permissionCeiling: request.permissionCeiling,
            visited: request.visited,
            expectedGeneration: target.activeGeneration ?? null,
          })
          .pipe(Effect.orElseSucceed(() => "uncertain" as const));
        const latest = yield* store.get(id);
        if (
          latest?.state.attemptId === claimed.state.attemptId &&
          latest.state.status === "sending"
        ) {
          if (outcome === "delivered")
            yield* store.transition(id, latest.revision, {
              type: "receipt",
              receipt: {
                receiptId: `native:${id}:${claimed.state.attemptId}:delivered`,
                requestId: id,
                fingerprint: claimed.state.fingerprint,
                attemptId: claimed.state.attemptId!,
                destination: request.destination,
                kind: "delivered",
              },
            });
          else
            yield* store.transition(id, latest.revision, {
              type:
                outcome === "rejected"
                  ? "admission-rejected"
                  : outcome === "admitted"
                    ? "admitted"
                    : "send-interrupted",
            });
        }
        continue;
      }
      if (Option.isNone(destination) || (Option.isNone(source) && !native)) continue;
      const s = Option.getOrNull(source);
      const d = destination.value;
      if (
        native &&
        (native.archived ||
          !native.permissionsKnown ||
          native.endpoint.environmentId !== request.source.environmentId ||
          native.endpoint.projectId !== request.source.projectId)
      )
        continue;
      const sourceMode = s?.runtimeMode ?? native!.runtimeMode;
      if (
        (s?.projectId ?? native!.endpoint.projectId) !== request.source.projectId ||
        d.projectId !== request.destination.projectId ||
        d.hasPendingApprovals ||
        d.hasPendingUserInput ||
        d.session?.status === "starting" ||
        sourceMode !== d.runtimeMode ||
        !request.permissionCeiling.includes(`runtime:${sourceMode}`)
      )
        continue;
      const activeTurnId = d.session?.activeTurnId;
      if (d.session?.status === "running" || activeTurnId != null) {
        if (!activeTurnId || Option.isNone(providers)) continue;
        const capabilities = yield* providers.value
          .getCapabilities(d.modelSelection.instanceId)
          .pipe(Effect.option);
        if (Option.isNone(capabilities) || capabilities.value.activeTurnSteering !== true) continue;
      }
      // CAS loser does no I/O. Revision gives each definitively rejected attempt a new command ID.
      const claimed = yield* store.transition(id, row.revision, {
        type: "begin-send",
        attemptId: `route:${id}:${row.revision}`,
      });
      const result = yield* engine
        .dispatch({
          ...(s
            ? {
                type: "thread.route.deliver" as const,
                originalProviderInstanceId: s.modelSelection.instanceId,
              }
            : {
                type: "thread.external-route.deliver" as const,
                sourceProjectId: native!.endpoint.projectId,
                originalProviderKey: native!.providerKey,
              }),
          commandId: CommandId.make(claimed.state.attemptId!),
          routeId: id,
          ...(activeTurnId ? { activeTurnId } : {}),
          sourceThreadId: ThreadId.make(request.source.threadId),
          threadId: d.id,
          messageId: MessageId.make(`route:${id}`),
          originalRuntimeMode: sourceMode,
          text: request.content,
          provenance: routeEndpointUrl(request.source),
          visitedThreadIds: request.visited.map((endpoint) => ThreadId.make(endpoint.threadId)),
          createdAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(Effect.result);
      // Only a definite engine rejection proves no admission. All other errors require reconciliation.
      const type =
        result._tag === "Success"
          ? "admitted"
          : result.failure._tag === "OrchestrationCommandInvariantError" ||
              result.failure._tag === "OrchestrationCommandPreviouslyRejectedError"
            ? "admission-rejected"
            : "send-interrupted";
      // A transport receipt can advance this attempt before dispatch returns.
      const current = yield* store.get(id);
      if (
        current?.state.attemptId === claimed.state.attemptId &&
        current.state.status === "sending"
      ) {
        const updated = yield* store.transition(id, current.revision, { type }).pipe(Effect.result);
        if (updated._tag === "Failure") {
          const latest = yield* store.get(id);
          if (
            latest?.state.attemptId !== claimed.state.attemptId ||
            latest.state.status === "sending"
          )
            return yield* Effect.fail(updated.failure);
        }
      }
    }
  });
  const drain = () => mutex.withPermits(1)(sweep());
  const start = Effect.gen(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* store.recoverInterruptedSends();
    yield* drain();
    yield* events.pipe(
      Stream.filter(shouldWakeRouteDrain),
      Stream.runForEach(() =>
        drain().pipe(Effect.catchCause((cause) => Effect.logError("Route drain failed", cause))),
      ),
      Effect.forkScoped,
    );
  });
  return { drain, start };
});
