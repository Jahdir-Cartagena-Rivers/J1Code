import { CommandId, MessageId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { DateTime, Effect, Option, Semaphore, Stream } from "effect";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeDurableRoutingStore } from "./durableRoutingStore.ts";

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
  const store = yield* makeDurableRoutingStore;
  const mutex = yield* Semaphore.make(1);
  const sweep = Effect.fn("EngineRouteDrain.drain")(function* () {
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
      if (Option.isNone(source) || Option.isNone(destination)) continue;
      const s = source.value;
      const d = destination.value;
      if (
        s.projectId !== request.source.projectId ||
        d.projectId !== request.destination.projectId ||
        d.hasPendingApprovals ||
        d.hasPendingUserInput ||
        d.session?.status === "running" ||
        d.session?.status === "starting" ||
        d.session?.activeTurnId != null ||
        s.runtimeMode !== d.runtimeMode ||
        !request.permissionCeiling.includes(`runtime:${s.runtimeMode}`)
      )
        continue;
      // CAS loser does no I/O. Revision gives each definitively rejected attempt a new command ID.
      const claimed = yield* store.transition(id, row.revision, {
        type: "begin-send",
        attemptId: `route:${id}:${row.revision}`,
      });
      const result = yield* engine
        .dispatch({
          type: "thread.route.deliver",
          commandId: CommandId.make(claimed.state.attemptId!),
          routeId: id,
          sourceThreadId: s.id,
          threadId: d.id,
          messageId: MessageId.make(`route:${id}`),
          originalRuntimeMode: s.runtimeMode,
          originalProviderInstanceId: s.modelSelection.instanceId,
          text: request.content,
          provenance: `/${encodeURIComponent(request.source.environmentId)}/${encodeURIComponent(s.id)}`,
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
