import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/060_DurableRoutes.ts";
import { makeDurableRoutingStore } from "./durableRoutingStore.ts";
import {
  makeDeliveryDispatcher,
  DeliveryDispatchError,
  type DeliveryEndpointState,
  type DeliveryPort,
  type DeliveryRequest,
} from "./deliveryDispatcher.ts";
import type { RouteReceipt } from "./routeState.ts";

const request: DeliveryRequest = {
  requestId: "r",
  source: { environmentId: "e", projectId: "p", threadId: "s" },
  destination: { environmentId: "e", projectId: "p", threadId: "d" },
  content: "hello",
  visited: [],
  maxHops: 3,
  ambiguous: false,
  mode: "auto",
  initiation: "automatic",
};
const fixture = Effect.fnUntraced(function* () {
  yield* migration;
  const store = yield* makeDurableRoutingStore;
  let source: DeliveryEndpointState = { status: "ready", permissions: ["read"] };
  let destination: DeliveryEndpointState = source;
  let sends = 0;
  let releases = 0;
  let outcome: "receipt" | "throw" | "missing" = "receipt";
  let last: RouteReceipt | null = null;
  const port: DeliveryPort = {
    inspect: (endpoint) => Effect.sync(() => (endpoint.threadId === "s" ? source : destination)),
    reserve: () =>
      Effect.succeed({
        source,
        destination,
        release: Effect.sync(() => {
          releases++;
        }),
        send: (route) =>
          Effect.gen(function* () {
            // Assert the real SQLite claim has landed before external I/O.
            expect((yield* store.get("r").pipe(Effect.orDie))?.state.status).toBe("sending");
            sends++;
            if (outcome === "throw")
              return yield* Effect.fail(
                new DeliveryDispatchError({ message: "transport disconnected" }),
              );
            if (outcome === "missing") return null;
            last = {
              receiptId: "receipt",
              requestId: "r",
              fingerprint: route.state.fingerprint,
              attemptId: route.state.attemptId!,
              destination: request.destination!,
              kind: "delivered",
            };
            return last;
          }),
      }),
    verifyReceipt: (evidence) => Effect.succeed(evidence === last ? last : null),
    nextAttemptId: () => "attempt",
  };
  return {
    store,
    port,
    dispatcher: makeDeliveryDispatcher(store, port),
    setSource: (value: DeliveryEndpointState) => {
      source = value;
    },
    setDestination: (value: DeliveryEndpointState) => {
      destination = value;
    },
    setOutcome: (value: typeof outcome) => {
      outcome = value;
    },
    sends: () => sends,
    releases: () => releases,
    receipt: () => last,
  };
});
const database = NodeSqliteClient.layer({ filename: ":memory:" });

describe("delivery dispatcher", () => {
  it.effect("ignores supplied capability arrays and preserves definite reservation deferral", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setDestination({ status: "ready", permissions: ["write"] });
      const untrusted = { ...request, permissionCeiling: ["write"], destinationPermissions: [] };
      expect((yield* f.dispatcher.register(untrusted)).state.status).toBe("blocked");
      const next = { ...request, requestId: "deferred" };
      f.setDestination({ status: "ready", permissions: ["read"] });
      yield* f.dispatcher.register(next);
      const deferred = makeDeliveryDispatcher(f.store, {
        ...f.port,
        reserve: () => Effect.succeed(null),
      });
      expect((yield* deferred.dispatch("deferred")).deferred).toBe("admission-unavailable");
      expect((yield* f.store.get("deferred"))?.state.attemptId).toBeNull();
      expect((yield* f.store.get("deferred"))?.state.status).toBe("queued");
      expect(f.sends()).toBe(0);
    }).pipe(Effect.provide(database)),
  );
  it.effect("persists, races CAS claims, deduplicates and rejects changed content", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.dispatcher.register(request);
      const results = yield* Effect.all(
        [f.dispatcher.dispatch("r"), f.dispatcher.dispatch("r")].map(Effect.exit),
        { concurrency: "unbounded" },
      );
      expect(results).toHaveLength(2);
      expect(f.sends()).toBe(1);
      expect((yield* f.dispatcher.register(request)).state.status).toBe("delivered");
      expect(
        (yield* Effect.exit(f.dispatcher.register({ ...request, content: "changed" })))._tag,
      ).toBe("Failure");
      yield* f.dispatcher.dispatch("r");
      expect(f.sends()).toBe(1);
    }).pipe(Effect.provide(database)),
  );

  it.effect(
    "defers busy, approval, missing and broadened permissions before any send, then resumes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.dispatcher.register(request);
        for (const status of ["busy", "approval-pending", "missing"] as const) {
          f.setDestination({ status, permissions: ["read"] });
          const result = yield* f.dispatcher.dispatch("r");
          expect(result.route.state.status).toBe("queued");
          expect(result.deferred).toBe(`destination-${status}`);
        }
        f.setDestination({ status: "ready", permissions: ["write"] });
        expect((yield* f.dispatcher.dispatch("r")).deferred).toBe("permission-escalation");
        f.setDestination({ status: "ready", permissions: ["read"] });
        f.setSource({ status: "ready", permissions: [] });
        expect((yield* f.dispatcher.dispatch("r")).deferred).toBe("permission-escalation");
        expect(f.sends()).toBe(0);
        f.setSource({ status: "ready", permissions: ["read"] });
        expect((yield* f.dispatcher.dispatch("r")).route.state.status).toBe("delivered");
        expect(f.releases()).toBe(6);
      }).pipe(Effect.provide(database)),
  );

  it.effect(
    "does not equate delivered with recipient acceptance or completion; authenticates receipts",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.dispatcher.register(request);
        expect((yield* f.dispatcher.dispatch("r")).route.state.status).toBe("delivered");
        expect(
          (yield* Effect.exit(f.dispatcher.receive({ ...f.receipt(), kind: "completed" })))._tag,
        ).toBe("Failure");
        const delivered = f.receipt()!;
        const port: DeliveryPort = {
          ...f.port,
          verifyReceipt: (evidence) =>
            Effect.succeed(
              evidence === "accepted" || evidence === "completed"
                ? { ...delivered, receiptId: evidence, kind: evidence }
                : null,
            ),
        };
        const dispatcher = makeDeliveryDispatcher(f.store, port);
        expect((yield* dispatcher.receive("accepted")).state.status).toBe("accepted");
        expect((yield* dispatcher.receive("completed")).state.status).toBe("completed");
      }).pipe(Effect.provide(database)),
  );

  for (const outcome of ["throw", "missing"] as const) {
    it.effect(`makes ${outcome} uncertain and never resends across dispatcher restart`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.dispatcher.register(request);
        f.setOutcome(outcome);
        expect((yield* f.dispatcher.dispatch("r")).route.state.status).toBe("uncertain");
        const restarted = makeDeliveryDispatcher(f.store, f.port);
        yield* restarted.recover();
        yield* restarted.register(request);
        yield* restarted.dispatch("r");
        expect(f.sends()).toBe(1);
      }).pipe(Effect.provide(database)),
    );
  }

  it.effect(
    "recovers a crash after durable claim without sending; guards environment, loops and ambiguous auto",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const row = yield* f.dispatcher.register(request);
        yield* f.store.transition("r", row.revision, { type: "begin-send", attemptId: "crashed" });
        const restarted = makeDeliveryDispatcher(f.store, f.port);
        expect(yield* restarted.recover()).toBe(1);
        expect((yield* restarted.dispatch("r")).route.state.status).toBe("uncertain");
        yield* restarted.register({
          ...request,
          requestId: "remote",
          destination: { ...request.destination!, environmentId: "elsewhere" },
        });
        expect((yield* restarted.dispatch("remote")).deferred).toBe("same-environment-required");
        expect(
          (yield* restarted.register({
            ...request,
            requestId: "loop",
            destination: request.source,
          })).state.status,
        ).toBe("blocked");
        expect(
          (yield* restarted.register({ ...request, requestId: "ambiguous", ambiguous: true })).state
            .status,
        ).toBe("suggested");
        yield* restarted.dispatch("ambiguous");
        expect(f.sends()).toBe(0);
      }).pipe(Effect.provide(database)),
  );
});
