import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  registerRoute,
  resolveRoute,
  type RouteEndpoint,
  type RouteResolutionAuthority,
  type RouteState,
  transitionRoute,
  type RouteRequest,
  type RouteEvent,
} from "./routeState.ts";

const Endpoint = Schema.Struct({
  environmentId: Schema.String,
  projectId: Schema.String,
  threadId: Schema.String,
});
const Request = Schema.Struct({
  requestId: Schema.String,
  taskId: Schema.optionalKey(Schema.String),
  sourceUrl: Schema.optionalKey(Schema.String),
  source: Endpoint,
  destination: Schema.NullOr(Endpoint),
  content: Schema.String,
  permissionCeiling: Schema.Array(Schema.String),
  destinationPermissions: Schema.Array(Schema.String),
  visited: Schema.Array(Endpoint),
  maxHops: Schema.Int,
  ambiguous: Schema.Boolean,
  mode: Schema.Literals(["off", "suggest", "auto"]),
  initiation: Schema.Literals(["automatic", "manual"]),
});
const Receipt = Schema.Struct({
  receiptId: Schema.String,
  requestId: Schema.String,
  fingerprint: Schema.String,
  attemptId: Schema.String,
  destination: Endpoint,
  kind: Schema.Literals(["delivered", "accepted", "completed", "failed"]),
});
const State = Schema.Struct({
  request: Request,
  originalRequest: Request,
  resolution: Schema.NullOr(
    Schema.Struct({
      userId: Schema.String,
      source: Endpoint,
      destination: Endpoint,
      destinationPermissions: Schema.Array(Schema.String),
    }),
  ),
  fingerprint: Schema.String,
  status: Schema.Literals([
    "blocked",
    "suggested",
    "queued",
    "sending",
    "admitted",
    "delivered",
    "accepted",
    "completed",
    "failed",
    "uncertain",
  ]),
  reason: Schema.NullOr(Schema.String),
  attemptId: Schema.NullOr(Schema.String),
  receipts: Schema.Array(Receipt),
});
const Event = Schema.Union([
  Schema.Struct({ type: Schema.Literal("confirm") }),
  Schema.Struct({ type: Schema.Literal("begin-send"), attemptId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("send-interrupted") }),
  Schema.Struct({ type: Schema.Literal("admitted") }),
  Schema.Struct({ type: Schema.Literal("admission-rejected") }),
  Schema.Struct({ type: Schema.Literal("receipt"), receipt: Receipt }),
]);
const decodeState = Schema.decodeEffect(Schema.fromJsonString(State));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(State));
const decodeRequest = Schema.decodeEffect(Request);
const decodeEvent = Schema.decodeUnknownSync(Event);
const decodeEndpoint = Schema.decodeEffect(Endpoint);
export class RoutingStoreError extends Schema.TaggedError<RoutingStoreError>()(
  "RoutingStoreError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}
export interface StoredRoute {
  readonly revision: number;
  readonly state: typeof State.Type;
}

/** Infrastructure only. A single server owner must recover interrupted sends before dispatch.
 * Persist begin-send before external I/O; revision conflicts require rereading, never blind dispatch.
 * Receipts must be authenticated by the caller; this store cannot verify provider provenance.
 */
export interface RouteResolutionVerifier {
  /** Must authenticate an explicit user action, bind its source/request and independently read destination permissions. */
  readonly verify: (
    requestId: string,
    destination: RouteEndpoint,
  ) => Effect.Effect<RouteResolutionAuthority, RoutingStoreError>;
}

export const makeDurableRoutingStoreWithResolution = (verifier?: RouteResolutionVerifier) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const get = Effect.fn("DurableRoutingStore.get")(function* (requestId: string) {
      const rows = yield* sql<{
        revision: number;
        state_json: string;
      }>`SELECT revision, state_json FROM durable_routes WHERE request_id = ${requestId}`;
      const row = rows[0];
      if (!row) return null;
      return {
        revision: row.revision,
        state: yield* decodeState(row.state_json),
      };
    });
    const create = Effect.fn("DurableRoutingStore.create")(function* (input: RouteRequest) {
      const request = yield* decodeRequest(input);
      const state = yield* Effect.try(() => registerRoute(request));
      yield* sql`INSERT INTO durable_routes(request_id, fingerprint, revision, status, state_json)
      VALUES (${request.requestId}, ${state.fingerprint}, 0, ${state.status}, ${yield* encodeState(state)}) ON CONFLICT(request_id) DO NOTHING`;
      const stored = yield* get(request.requestId);
      if (!stored || stored.state.fingerprint !== state.fingerprint)
        return yield* Effect.fail(
          new RoutingStoreError({ operation: "validate", cause: "Route identity conflict" }),
        );
      return stored;
    });
    const transition = Effect.fn("DurableRoutingStore.transition")(function* (
      requestId: string,
      expectedRevision: number,
      input: RouteEvent | ((state: RouteState) => RouteState),
    ) {
      const stored = yield* get(requestId);
      if (!stored)
        return yield* Effect.fail(
          new RoutingStoreError({ operation: "validate", cause: "Route not found" }),
        );
      if (stored.revision !== expectedRevision)
        return yield* Effect.fail(
          new RoutingStoreError({ operation: "validate", cause: "Route revision conflict" }),
        );
      const state =
        typeof input === "function"
          ? yield* Effect.try(() => input(stored.state))
          : yield* Effect.try(() => transitionRoute(stored.state, decodeEvent(input)));
      // Duplicate receipts are no-ops, but still check the revision atomically.
      const revision = stored.revision + (state === stored.state ? 0 : 1);
      const rows =
        yield* sql`UPDATE durable_routes SET revision = ${revision}, status = ${state.status}, state_json = ${yield* encodeState(state)}
      WHERE request_id = ${requestId} AND revision = ${expectedRevision} RETURNING request_id`;
      if (rows.length !== 1)
        return yield* Effect.fail(
          new RoutingStoreError({ operation: "validate", cause: "Route revision conflict" }),
        );
      return { revision, state };
    });
    const recoverInterruptedSends = Effect.fn("DurableRoutingStore.recoverInterruptedSends")(
      function* () {
        // One atomic statement: no queued row is touched and no uncertain row is made sendable.
        const rows =
          yield* sql`UPDATE durable_routes SET revision = revision + 1, status = 'uncertain',
      state_json = json_set(state_json, '$.status', 'uncertain', '$.reason', 'send-outcome-unknown')
      WHERE status = 'sending' RETURNING request_id`;
        return rows.length;
      },
    );
    const wrap = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.mapError((cause) => new RoutingStoreError({ operation, cause })));
    return {
      resolve: (id: string, revision: number, destination: RouteEndpoint) =>
        wrap(
          "resolve",
          Effect.gen(function* () {
            if (!verifier)
              return yield* Effect.fail(
                new RoutingStoreError({
                  operation: "resolve",
                  cause: "User resolution verifier unavailable",
                }),
              );
            const endpoint = yield* decodeEndpoint(destination);
            const authority = yield* verifier.verify(id, endpoint);
            if (
              authority.destination.environmentId !== endpoint.environmentId ||
              authority.destination.projectId !== endpoint.projectId ||
              authority.destination.threadId !== endpoint.threadId
            )
              return yield* Effect.fail(
                new RoutingStoreError({
                  operation: "resolve",
                  cause: "Resolution destination mismatch",
                }),
              );
            return yield* transition(id, revision, (state) => resolveRoute(state, authority));
          }),
        ),
      commitResolution: (id: string, revision: number, authority: RouteResolutionAuthority) =>
        wrap(
          "resolve",
          transition(id, revision, (state) => resolveRoute(state, authority)),
        ),
      queued: () =>
        wrap(
          "queued",
          Effect.gen(function* () {
            const rows = yield* sql<{
              request_id: string;
            }>`SELECT request_id FROM durable_routes WHERE status = 'queued' ORDER BY request_id`;
            return rows.map((row) => row.request_id);
          }),
        ),
      get: (id: string) => wrap("get", get(id)),
      create: (request: RouteRequest) => wrap("create", create(request)),
      transition: (id: string, revision: number, event: RouteEvent) =>
        wrap("transition", transition(id, revision, event)),
      recoverInterruptedSends: () => wrap("recoverInterruptedSends", recoverInterruptedSends()),
    };
  });

export const makeDurableRoutingStore = makeDurableRoutingStoreWithResolution();
