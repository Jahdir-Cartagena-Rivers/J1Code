import * as Effect from "effect/Effect";

import type { DispatchModes } from "../orchestration-v2/DispatchModeLimit.ts";
import {
  type makeDurableRoutingStore,
  type RoutingStoreError,
  type StoredRoute,
} from "./durableRoutingStore.ts";
import { strictRouteDescriptorFingerprint } from "./routeState.ts";
import {
  reconcileV2StrictDelivery,
  type PreparedStrictRouteDelivery,
  type StrictRouteDeliveryResult,
  type WithLockedStrictRouteAdmission,
} from "./v2StrictDelivery.ts";

type StrictRouteStore = Pick<Effect.Success<typeof makeDurableRoutingStore>,
  "get" | "claimStrictSubmission" | "settleStrictSubmission">;

export type WithStrictRouteFence = <A, E, R>(
  requestId: string,
  work: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R>;

/** The owner validates account, lease, action-time approvals, and current endpoint and permission state. */
export type ValidateStrictRouteAdmission<E, R> = (
  row: StoredRoute,
  delivery: PreparedStrictRouteDelivery,
) => Effect.Effect<DispatchModes | null, E, R>;

export function makeV2StrictAdmission<E, R>(input: {
  readonly store: StrictRouteStore;
  readonly withRouteFence: WithStrictRouteFence;
  readonly validate: ValidateStrictRouteAdmission<E, R>;
  readonly expected: StoredRoute;
}): WithLockedStrictRouteAdmission<RoutingStoreError | E, R> {
  const { store, withRouteFence, expected, validate } = input;
  return Effect.fn("routing.admitV2StrictSubmission")(function* (
    delivery: PreparedStrictRouteDelivery,
    submitOnce: (lockedCeiling: DispatchModes) => Effect.Effect<StrictRouteDeliveryResult>,
  ) {
    const id = expected.state.request.requestId;
    return yield* withRouteFence(id, Effect.gen(function* () {
      const current = yield* store.get(id);
      if (current === null || current.state.fingerprint !== expected.state.fingerprint ||
          current.state.attemptId !== expected.state.attemptId) {
        return { status: "rejected", reason: "admission" } as const;
      }
      const existing = current.state.strictSubmission;
      if (existing !== undefined) {
        return existing.descriptorFingerprint === strictRouteDescriptorFingerprint(delivery)
          ? { status: "uncertain", reason: "ambiguous" } as const
          : { status: "rejected", reason: "changed-intent" } as const;
      }
      if (current.revision !== expected.revision || current.state.status !== "sending") {
        return { status: "rejected", reason: "admission" } as const;
      }
      const ceiling = yield* validate(current, delivery);
      if (ceiling === null) return { status: "rejected", reason: "admission" } as const;

      const claimed = yield* store.claimStrictSubmission(
        id, current.revision, current.state.fingerprint, delivery,
      );
      const claim = claimed.state.strictSubmission;
      if (claim === undefined) return yield* Effect.die("Strict route claim was not persisted");
      const result = yield* submitOnce(ceiling);
      yield* store.settleStrictSubmission(id, claimed.revision, claim.descriptorFingerprint, result);
      return result;
    }));
  });
}

export const reconcileClaimedV2StrictDelivery = Effect.fn("routing.reconcileClaimedV2StrictDelivery")(
  function* (input: {
    readonly requestId: string;
    readonly store: StrictRouteStore;
    readonly withRouteFence: WithStrictRouteFence;
  }) {
    const { store, withRouteFence, requestId } = input;
    return yield* withRouteFence(requestId, Effect.gen(function* () {
      const row = yield* store.get(requestId);
      const claim = row?.state.strictSubmission;
      if (row === null || claim === undefined) return null;
      if (!["sending", "admitted", "uncertain"].includes(row.state.status)) {
        return { row, evidence: null };
      }
      const evidence: StrictRouteDeliveryResult = yield* reconcileV2StrictDelivery(claim.delivery);
      const updated = yield* store.settleStrictSubmission(
        requestId, row.revision, claim.descriptorFingerprint, evidence,
      );
      return { row: updated, evidence };
    }));
  },
);
