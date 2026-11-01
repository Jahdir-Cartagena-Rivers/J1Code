import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { makeDurableRoutingStore, StoredRoute } from "./durableRoutingStore.ts";
import type { RouteEndpoint, RouteReceipt, RouteRequest } from "./routeState.ts";

export class DeliveryDispatchError extends Data.TaggedError("DeliveryDispatchError")<{
  readonly message: string;
}> {}

type Store = Effect.Success<typeof makeDurableRoutingStore>;
export type DeliveryRequest = Omit<RouteRequest, "permissionCeiling" | "destinationPermissions">;
export interface DeliveryEndpointState {
  readonly permissions: readonly string[];
  readonly status: "ready" | "busy" | "approval-pending" | "missing";
}
export interface DeliveryReservation {
  /** Rechecks status and capabilities atomically with reserving admission. Must never interrupt a turn.
   * No external send may happen until send is invoked. release must be idempotent. */
  readonly source: DeliveryEndpointState;
  readonly destination: DeliveryEndpointState;
  readonly send: (route: StoredRoute) => Effect.Effect<unknown, DeliveryDispatchError>;
  readonly release: Effect.Effect<void, DeliveryDispatchError>;
}
/** Server-owned adapter only. Never implement these methods using model assertions.
 * reserve holds admission/status/permission stability until release, or send must fail before I/O.
 * A send failure after claim is conservatively uncertain, including definite non-delivery:
 * this state machine has no safe sending -> queued transition. */
export interface DeliveryPort {
  readonly inspect: (
    endpoint: RouteEndpoint,
  ) => Effect.Effect<DeliveryEndpointState, DeliveryDispatchError>;
  readonly reserve: (
    request: RouteRequest,
  ) => Effect.Effect<DeliveryReservation | null, DeliveryDispatchError>;
  readonly verifyReceipt: (
    evidence: unknown,
  ) => Effect.Effect<RouteReceipt | null, DeliveryDispatchError>;
  readonly nextAttemptId: () => string;
}
export interface DeliveryResult {
  readonly route: StoredRoute;
  readonly deferred: string | null;
}

/** Injectable infrastructure, deliberately not started by constructing it.
 * The single environment owner calls recover once, before starting any dispatch workers. */
export function makeDeliveryDispatcher(store: Store, port: DeliveryPort) {
  const register = Effect.fn("DeliveryDispatcher.register")(function* (input: DeliveryRequest) {
    // Existing authoritative permission snapshots remain part of the identity on retries.
    const existing = yield* store.get(input.requestId);
    if (existing) {
      return yield* store.create({
        ...input,
        permissionCeiling: existing.state.request.permissionCeiling,
        destinationPermissions: existing.state.request.destinationPermissions,
      });
    }
    const source = yield* port.inspect(input.source);
    const destination = input.destination ? yield* port.inspect(input.destination) : null;
    return yield* store.create({
      ...input,
      permissionCeiling: source.permissions,
      destinationPermissions: destination?.permissions ?? [],
    });
  });
  const receive = Effect.fn("DeliveryDispatcher.receive")(function* (evidence: unknown) {
    const receipt = yield* port.verifyReceipt(evidence);
    if (!receipt)
      return yield* Effect.fail(
        new DeliveryDispatchError({ message: "Unauthenticated delivery receipt" }),
      );
    const route = yield* store.get(receipt.requestId);
    if (!route)
      return yield* Effect.fail(new DeliveryDispatchError({ message: "Unknown delivery receipt" }));
    return yield* store.transition(receipt.requestId, route.revision, { type: "receipt", receipt });
  });
  const dispatch = Effect.fn("DeliveryDispatcher.dispatch")(function* (requestId: string) {
    const route = yield* store.get(requestId);
    if (!route) return yield* Effect.fail(new DeliveryDispatchError({ message: "Unknown route" }));
    const result = (deferred: string | null): DeliveryResult => ({ route, deferred });
    if (route.state.status !== "queued") return result(null);
    const request = route.state.request;
    if (!request.destination || request.source.environmentId !== request.destination.environmentId)
      return result("same-environment-required");
    return yield* Effect.acquireUseRelease(
      port.reserve(request),
      Effect.fnUntraced(function* (reservation) {
        if (!reservation) return result("admission-unavailable");
        if (reservation.source.status !== "ready")
          return result(`source-${reservation.source.status}`);
        if (reservation.destination.status !== "ready")
          return result(`destination-${reservation.destination.status}`);
        if (
          reservation.destination.permissions.some(
            (p) =>
              !reservation.source.permissions.includes(p) || !request.permissionCeiling.includes(p),
          )
        )
          return result("permission-escalation");
        const claimed = yield* store.transition(requestId, route.revision, {
          type: "begin-send",
          attemptId: port.nextAttemptId(),
        });
        // Claim is durable before invoking the port. Failure or missing/invalid receipt never retries.
        return yield* Effect.gen(function* () {
          const evidence = yield* reservation.send(claimed);
          const receipt = yield* port.verifyReceipt(evidence);
          if (!receipt)
            return yield* Effect.fail(
              new DeliveryDispatchError({ message: "Missing authenticated receipt" }),
            );
          const saved = yield* store.transition(requestId, claimed.revision, {
            type: "receipt",
            receipt,
          });
          return { route: saved, deferred: null } satisfies DeliveryResult;
        }).pipe(
          Effect.catchCause(() =>
            Effect.gen(function* () {
              const current = yield* store.get(requestId);
              if (!current)
                return yield* Effect.fail(
                  new DeliveryDispatchError({ message: "Claimed route disappeared" }),
                );
              if (current.state.status !== "sending") return { route: current, deferred: null };
              const uncertain = yield* store.transition(requestId, current.revision, {
                type: "send-interrupted",
              });
              return { route: uncertain, deferred: null };
            }),
          ),
        );
      }),
      (reservation) => (reservation ? reservation.release.pipe(Effect.orDie) : Effect.void),
    );
  });
  return { register, dispatch, receive, recover: store.recoverInterruptedSends };
}
