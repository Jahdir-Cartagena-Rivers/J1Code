import { Effect } from "effect";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import type { OrchestrationV2StoredEvent } from "@j1code/contracts";

import type { CommandReceiptStoreV2 } from "../orchestration-v2/CommandReceiptStore.ts";
import type { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { EffectOutboxV2 } from "../orchestration-v2/EffectOutbox.ts";
import { makeDurableRoutingStore } from "./durableRoutingStore.ts";
import type { makeRouteSourceNotifier } from "./sourceActivity.ts";
import { reconcileClaimedV2StrictDelivery, type WithStrictRouteFence } from "./v2StrictAdmission.ts";

export function strictRouteWakeCommand(event: OrchestrationV2StoredEvent) {
  return event.event.type === "message.updated" && event.event.payload.strictSteer !== undefined
    ? event.commandId
    : null;
}

/** Owned by the single environment drain. Events only wake a persisted outbox evidence read. */
export const makeRouteTransportConsumer = Effect.fn("routing.makeRouteTransportConsumer")(
  function* (input: {
    readonly withRouteFence: WithStrictRouteFence;
    readonly notify: Effect.Success<typeof makeRouteSourceNotifier>;
    readonly scope: Scope.Scope;
    readonly wake: Effect.Effect<void>;
  }) {
    const store = yield* makeDurableRoutingStore;
    const sql = yield* SqlClient.SqlClient;
    const outbox = yield* EffectOutboxV2;
    const evidenceServices = yield* Effect.context<CommandReceiptStoreV2 | EventSinkV2 | EffectOutboxV2>();
    const watching = new Set<string>();

    const reconcile = Effect.fn("RouteTransportConsumer.reconcile")(function* (requestId: string) {
      let previousRevision: number | undefined;
      const result = yield* reconcileClaimedV2StrictDelivery({
        requestId,
        store,
        withRouteFence: (id, work) => input.withRouteFence(id, Effect.gen(function* () {
          previousRevision = (yield* store.get(id).pipe(Effect.orDie))?.revision;
          return yield* work;
        })),
      }).pipe(Effect.provide(evidenceServices));
      if (result === null) return;
      if (previousRevision !== undefined && result.row.revision !== previousRevision) {
        yield* input.notify(result.row);
      }
      return result.evidence;
    });

    const observe = Effect.fn("RouteTransportConsumer.observe")(function* (requestId: string) {
      const evidence = yield* reconcile(requestId);
      if (evidence?.status === "admitted" && !watching.has(evidence.effectId)) {
        const { effectId } = evidence;
        watching.add(effectId);
        yield* outbox.awaitSettled(effectId).pipe(
          Effect.andThen(reconcile(requestId)),
          Effect.andThen(input.wake),
          Effect.catchCause((cause) => Effect.logWarning("Strict route settlement needs reconciliation", { cause })),
          Effect.ensuring(Effect.sync(() => { watching.delete(effectId); })),
          Effect.forkIn(input.scope),
        );
      }
    });

    const consume = Effect.fn("RouteTransportConsumer.consume")(function* (event: OrchestrationV2StoredEvent) {
      const commandId = strictRouteWakeCommand(event);
      if (commandId === null) return;
      const matches = yield* sql<{ request_id: string }>`
        SELECT request_id FROM durable_routes
        WHERE json_extract(state_json, '$.strictSubmission.delivery.command.commandId') = ${commandId}
        LIMIT 2
      `;
      if (matches.length === 1 && matches[0] !== undefined) yield* observe(matches[0].request_id);
    });

    const recover = Effect.fn("RouteTransportConsumer.recover")(function* () {
      const bounds = yield* sql<{ last_id: string | null }>`
        SELECT MAX(request_id) AS last_id FROM durable_routes
        WHERE status IN ('sending', 'admitted', 'uncertain')
          AND json_type(state_json, '$.strictSubmission') = 'object'
      `;
      const lastId = bounds[0]?.last_id;
      if (lastId == null) return;
      let after = "";
      while (true) {
        const rows = yield* sql<{ request_id: string }>`
          SELECT request_id FROM durable_routes
          WHERE status IN ('sending', 'admitted', 'uncertain')
            AND json_type(state_json, '$.strictSubmission') = 'object'
            AND request_id > ${after} AND request_id <= ${lastId}
          ORDER BY request_id LIMIT 128
        `;
        const last = rows.at(-1);
        if (last === undefined) return;
        for (const row of rows) yield* observe(row.request_id).pipe(
          Effect.catchCause((cause) => Effect.logWarning("Could not recover a strict route", { cause })),
        );
        after = last.request_id;
      }
    });
    return { observe, consume, recover };
  },
);
