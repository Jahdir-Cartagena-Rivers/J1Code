import { type OrchestrationEvent } from "@t3tools/contracts";
import { Effect, Option, Schema, Semaphore, Stream } from "effect";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeDurableRoutingStore } from "./durableRoutingStore.ts";

const Transport = Schema.Struct({
  routeId: Schema.String,
  sourceThreadId: Schema.String,
  receivingThreadId: Schema.String,
  commandId: Schema.String,
  messageId: Schema.String,
  outcome: Schema.Literals(["sent", "outcome-unknown"]),
});

class RouteTransportContention extends Schema.TaggedError<RouteTransportContention>()(
  "RouteTransportContention",
  { message: Schema.String },
) {}

const decodeTransport = Schema.decodeUnknownOption(Transport);

/** Subscribe before replay to close the startup gap.
 * Only persisted infrastructure activities are evidence; prose and tool outputs are ignored. */
export const makeRouteTransportConsumer = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const store = yield* makeDurableRoutingStore;
  const mutex = yield* Semaphore.make(1);
  const consume = Effect.fn("RouteTransportConsumer.consume")(function* (
    candidate: OrchestrationEvent,
  ) {
    if (
      candidate.type !== "thread.activity-appended" ||
      candidate.payload.activity.kind !== "route.transport"
    )
      return;
    // Re-read the authoritative event, never apply the caller's supplied activity body.
    const persisted = yield* engine.readEvents(candidate.sequence - 1, 1).pipe(Stream.runHead);
    if (Option.isNone(persisted)) return;
    const event = persisted.value;
    if (
      event.sequence !== candidate.sequence ||
      event.eventId !== candidate.eventId ||
      event.type !== "thread.activity-appended" ||
      event.payload.activity.kind !== "route.transport" ||
      event.metadata.origin !== undefined
    )
      return;
    const decoded = decodeTransport(event.payload.activity.payload);
    if (Option.isNone(decoded)) return;
    const evidence = decoded.value;
    const identity = [
      evidence.routeId,
      evidence.commandId,
      evidence.messageId,
      evidence.receivingThreadId,
      evidence.outcome,
    ]
      .map(encodeURIComponent)
      .join(":");
    const receiptId = `route-transport:${identity}`;
    if (
      event.commandId !== receiptId ||
      event.payload.activity.id !== receiptId ||
      event.payload.threadId !== evidence.receivingThreadId ||
      event.aggregateId !== evidence.receivingThreadId
    )
      return;
    // Admission and receipt consumers may race. Re-read after a failed CAS; never dispatch again.
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = yield* store.get(evidence.routeId);
      if (!row) return;
      const { state } = row;
      if (
        state.attemptId !== evidence.commandId ||
        state.request.source.threadId !== evidence.sourceThreadId ||
        state.request.destination?.threadId !== evidence.receivingThreadId ||
        evidence.messageId !== `route:${evidence.routeId}` ||
        !["sending", "admitted", "uncertain"].includes(state.status)
      )
        return;
      if (evidence.outcome === "outcome-unknown" && state.status === "uncertain") return;
      const result = yield* store
        .transition(
          evidence.routeId,
          row.revision,
          evidence.outcome === "sent"
            ? {
                type: "receipt",
                receipt: {
                  receiptId,
                  requestId: evidence.routeId,
                  fingerprint: state.fingerprint,
                  attemptId: evidence.commandId,
                  destination: state.request.destination!,
                  kind: "delivered",
                },
              }
            : { type: "send-interrupted" },
        )
        .pipe(Effect.result);
      if (result._tag === "Success") return;
      const current = yield* store.get(evidence.routeId);
      if (current?.revision === row.revision) return yield* Effect.fail(result.failure);
    }
    return yield* new RouteTransportContention({
      message: "Route transport CAS contention; replay required",
    });
  });
  const accept = (event: OrchestrationEvent) => mutex.withPermits(1)(consume(event));
  const reconcile = Effect.gen(function* () {
    let cursor = 0;
    while (true) {
      const page = yield* engine.readEvents(cursor, 256).pipe(Stream.runCollect);
      if (page.length === 0) break;
      for (const event of page) yield* accept(event);
      cursor = page[page.length - 1]!.sequence;
    }
  });
  const start = Effect.gen(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* reconcile;
    yield* events.pipe(
      Stream.runForEach((event) =>
        accept(event).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Route transport consumption failed; replay required", cause),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  });
  return { consume: accept, reconcile, start };
});
