import {
  ChatAttachment, CommandId, EnvironmentId, MessageId, OrchestrationV2LinkedSender,
  OrchestrationV2IdleRouteCommand, OrchestrationV2StrictSteerTarget, ProjectId, ProviderInstanceId, ProviderInteractionMode,
  RunId, RuntimeMode, ThreadId, TrimmedNonEmptyString,
} from "@j1code/contracts";
import type { PreparedStrictRouteDelivery, StrictRouteDeliveryResult } from "./v2StrictDelivery.ts";
import * as Effect from "effect/Effect";
import { automaticRouteFeedback } from "./feedback.ts";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  assertIdleRouteSubmission,
  claimIdleRouteSubmission,
  settleIdleRouteSubmission,
  type IdleDeliveryEvidence,
  assertStrictRouteSubmission,
  claimStrictRouteSubmission,
  settleStrictRouteSubmission,
  strictRouteDescriptorFingerprint,
  registerRoute,
  bindRouteInputFingerprint,
  replayRouteInput,
  resolveRoute,
  resolveDiscoveredOwner,
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
  origin: Schema.optionalKey(Schema.Struct({
    subject: TrimmedNonEmptyString,
    runId: TrimmedNonEmptyString,
    messageId: TrimmedNonEmptyString,
  })),
  requestId: Schema.String,
  feedbackFor: Schema.optionalKey(Schema.String),
  feedbackMessageHash: Schema.optionalKey(Schema.String),
  monitorSource: Schema.optionalKey(Schema.Boolean),
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
  message: Schema.optionalKey(Schema.String),
});
const Modes = { runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode };
const PreparedStrictDelivery = Schema.Struct({
  attempt: Schema.Struct({
    requestId: TrimmedNonEmptyString,
    attemptId: TrimmedNonEmptyString,
    source: Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId }),
    destination: Schema.Struct({
      ...Modes, environmentId: EnvironmentId, threadId: ThreadId, projectId: ProjectId,
      providerInstanceId: ProviderInstanceId, runId: RunId,
    }),
    ceiling: Schema.Struct(Modes),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
  }),
  command: Schema.Struct({
    type: Schema.Literal("message.steer-strict"),
    commandId: CommandId,
    threadId: ThreadId,
    messageId: MessageId,
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
    createdBy: Schema.Literals(["user", "agent", "system"]),
    creationSource: Schema.Literals(["web", "mobile", "mcp", "provider", "server"]),
    senderThreadId: Schema.optional(ThreadId),
    linkedSender: Schema.optional(OrchestrationV2LinkedSender),
    target: OrchestrationV2StrictSteerTarget,
  }),
});
const decodePreparedStrictDelivery = Schema.decodeUnknownEffect(PreparedStrictDelivery);
const State = Schema.Struct({
  inputFingerprint: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
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
  idleSubmission: Schema.optionalKey(Schema.Struct({
    routeFingerprint: TrimmedNonEmptyString,
    commandFingerprint: TrimmedNonEmptyString,
    command: OrchestrationV2IdleRouteCommand,
  })),
  strictSubmission: Schema.optionalKey(Schema.Struct({
    routeFingerprint: TrimmedNonEmptyString,
    descriptorFingerprint: TrimmedNonEmptyString,
    delivery: PreparedStrictDelivery,
  })),
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
const decodeIdleCommand = Schema.decodeEffect(OrchestrationV2IdleRouteCommand);
export class RoutingStoreError extends Schema.TaggedError<RoutingStoreError>()(
  "RoutingStoreError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}
export interface StoredRoute {
  readonly revision: number;
  readonly state: RouteState;
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

const validateRoute = <A>(operation: string, evaluate: () => A) =>
  Effect.try({ try: evaluate, catch: (cause) => new RoutingStoreError({ operation, cause }) });

export const makeDurableRoutingStoreWithResolution = Effect.fn("makeDurableRoutingStoreWithResolution")(
  function* (verifier?: RouteResolutionVerifier) {
    const sql = yield* SqlClient.SqlClient;
    const get = Effect.fn("DurableRoutingStore.get")(function* (requestId: string) {
      const rows = yield* sql<{
        revision: number;
        state_json: string;
      }>`SELECT revision, state_json FROM durable_routes WHERE request_id = ${requestId}`;
      const row = rows[0];
      if (!row) return null;
      const state = yield* decodeState(row.state_json);
      yield* validateRoute("validate-stored-proof", () => {
        assertIdleRouteSubmission(state);
        assertStrictRouteSubmission(state);
      });
      return { revision: row.revision, state };
    });
    const create = Effect.fn("DurableRoutingStore.create")(function* (input: RouteRequest, inputFingerprint?: string) {
      const request = yield* decodeRequest(input);
      const state = yield* validateRoute("register", () => {
        const initial = registerRoute(request);
        return inputFingerprint === undefined ? initial : bindRouteInputFingerprint(initial, inputFingerprint);
      });
      yield* sql`INSERT INTO durable_routes(request_id, fingerprint, revision, status, state_json)
      VALUES (${request.requestId}, ${state.fingerprint}, 0, ${state.status}, ${yield* encodeState(state)}) ON CONFLICT(request_id) DO NOTHING`;
      const stored = yield* get(request.requestId);
      if (stored && inputFingerprint !== undefined) {
        yield* validateRoute("replay-input", () => replayRouteInput(stored.state, inputFingerprint));
        return stored;
      }
      if (!stored || stored.state.fingerprint !== state.fingerprint)
        return yield* new RoutingStoreError({ operation: "validate", cause: "Route identity conflict" });
      return stored;
    });
    const transition = Effect.fn("DurableRoutingStore.transition")(function* (
      requestId: string,
      expectedRevision: number,
      input: RouteEvent | ((state: RouteState) => RouteState),
    ) {
      const stored = yield* get(requestId);
      if (!stored)
        return yield* new RoutingStoreError({ operation: "validate", cause: "Route not found" });
      if (stored.revision !== expectedRevision)
        return yield* new RoutingStoreError({ operation: "validate", cause: "Route revision conflict" });
      const state =
        typeof input === "function"
          ? yield* validateRoute("transition", () => input(stored.state))
          : yield* validateRoute("transition", () => transitionRoute(stored.state, decodeEvent(input)));
      yield* validateRoute("validate-strict-proof", () => assertStrictRouteSubmission(state));
      yield* validateRoute("validate-idle-proof", () => assertIdleRouteSubmission(state));
      // Duplicate receipts are no-ops, but still check the revision atomically.
      const revision = stored.revision + (state === stored.state ? 0 : 1);
      const rows =
        yield* sql`UPDATE durable_routes SET revision = ${revision}, status = ${state.status}, state_json = ${yield* encodeState(state)}
      WHERE request_id = ${requestId} AND revision = ${expectedRevision} RETURNING request_id`;
      if (rows.length !== 1)
        return yield* new RoutingStoreError({ operation: "validate", cause: "Route revision conflict" });
      const feedback = yield* validateRoute("create-feedback", () => automaticRouteFeedback(state));
      if (feedback && state !== stored.state) yield* create(feedback);
      return { revision, state };
    }, sql.withTransaction);
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
              return yield* new RoutingStoreError({
                  operation: "resolve",
                  cause: "User resolution verifier unavailable",
                });
            const endpoint = yield* decodeEndpoint(destination);
            const authority = yield* verifier.verify(id, endpoint);
            if (
              authority.destination.environmentId !== endpoint.environmentId ||
              authority.destination.projectId !== endpoint.projectId ||
              authority.destination.threadId !== endpoint.threadId
            )
              return yield* new RoutingStoreError({
                  operation: "resolve",
                  cause: "Resolution destination mismatch",
                });
            return yield* transition(id, revision, (state) => resolveRoute(state, authority));
          }),
        ),
      commitResolution: (id: string, revision: number, authority: RouteResolutionAuthority) =>
        wrap(
          "resolve",
          transition(id, revision, (state) => resolveRoute(state, authority)),
        ),
      commitDiscoveredOwner: (
        id: string,
        revision: number,
        destination: RouteEndpoint,
        permissions: readonly string[],
      ) =>
        wrap(
          "rediscover",
          transition(id, revision, (state) =>
            resolveDiscoveredOwner(state, destination, permissions),
          ),
        ),
      queued: () =>
        wrap(
          "queued",
          Effect.gen(function* () {
            const rows = yield* sql<{
              request_id: string;
            }>`SELECT request_id FROM durable_routes WHERE status = 'queued' ORDER BY rowid`;
            return rows.map((row) => row.request_id);
          }),
        ),
      unconfirmedNative: () =>
        wrap(
          "unconfirmedNative",
          Effect.gen(function* () {
            const rows = yield* sql<{
              request_id: string;
            }>`SELECT request_id FROM durable_routes WHERE status IN ('admitted', 'uncertain') AND json_type(state_json, '$.strictSubmission') IS NULL AND json_extract(state_json, '$.request.destination.threadId') LIKE 'mausbot:%' ORDER BY request_id LIMIT 128`;
            return rows.map((row) => row.request_id);
          }),
        ),
      unconfirmedStrict: () =>
        wrap("unconfirmedStrict", Effect.gen(function* () {
          const rows = yield* sql<{ request_id: string }>`SELECT request_id FROM durable_routes
            WHERE status IN ('sending', 'admitted', 'uncertain')
              AND json_type(state_json, '$.strictSubmission') = 'object'
            ORDER BY request_id LIMIT 128`;
          return rows.map((row) => row.request_id);
        })),
      claimIdleSubmission: (
        id: string, revision: number, fingerprint: string, command: OrchestrationV2IdleRouteCommand,
      ) => wrap("claimIdleSubmission", Effect.gen(function* () {
        const decoded = yield* decodeIdleCommand(command);
        return yield* transition(id, revision, (state) =>
          claimIdleRouteSubmission(
            transitionRoute(state, { type: "begin-send", attemptId: decoded.attemptId }),
            fingerprint, decoded,
          ),
        );
      })),
      settleIdleSubmission: (
        id: string, revision: number, commandFingerprint: string, evidence: IdleDeliveryEvidence,
      ) => wrap("settleIdleSubmission", transition(id, revision, (state) =>
        settleIdleRouteSubmission(state, commandFingerprint, evidence),
      )),
      idleRequestForRun: (runId: string) => wrap("idleRequestForRun", Effect.gen(function* () {
        const rows = yield* sql<{ request_id: string }>`
          SELECT request_id FROM durable_routes
          WHERE json_extract(state_json, '$.idleSubmission.command.runId') = ${runId} LIMIT 2
        `;
        return rows.length === 1 ? rows[0]?.request_id ?? null : null;
      })),
      lastUnconfirmedIdle: () => wrap("lastUnconfirmedIdle", Effect.gen(function* () {
        const rows = yield* sql<{ last_id: string | null }>`
          SELECT MAX(request_id) AS last_id FROM durable_routes
          WHERE status IN ('sending', 'admitted', 'uncertain')
            AND json_type(state_json, '$.idleSubmission') = 'object'
        `;
        return rows[0]?.last_id ?? null;
      })),
      unconfirmedIdle: (after: string, last: string) => wrap("unconfirmedIdle", Effect.gen(function* () {
        const rows = yield* sql<{ request_id: string }>`
          SELECT request_id FROM durable_routes
          WHERE status IN ('sending', 'admitted', 'uncertain')
            AND request_id > ${after} AND request_id <= ${last}
            AND json_type(state_json, '$.idleSubmission') = 'object'
          ORDER BY request_id LIMIT 128
        `;
        return rows.map((row) => row.request_id);
      })),
      claimStrictSubmission: (
        id: string,
        revision: number,
        fingerprint: string,
        delivery: PreparedStrictRouteDelivery,
      ) => wrap("claimStrictSubmission", Effect.gen(function* () {
        const decoded = yield* decodePreparedStrictDelivery(delivery);
        if (strictRouteDescriptorFingerprint(decoded) !== strictRouteDescriptorFingerprint(delivery)) {
          return yield* new RoutingStoreError({
            operation: "validate", cause: "Strict route descriptor changed during validation",
          });
        }
        return yield* transition(id, revision, (state) =>
          claimStrictRouteSubmission(state, fingerprint, decoded),
        );
      })),
      settleStrictSubmission: (
        id: string,
        revision: number,
        descriptorFingerprint: string,
        result: StrictRouteDeliveryResult,
      ) => wrap("settleStrictSubmission", transition(id, revision, (state) =>
        settleStrictRouteSubmission(state, descriptorFingerprint, result),
      )),
      get: (id: string) => wrap("get", get(id)),
      create: (request: RouteRequest, inputFingerprint?: string) => wrap("create", create(request, inputFingerprint)),
      transition: (id: string, revision: number, event: RouteEvent) =>
        wrap("transition", transition(id, revision, event)),
      recoverInterruptedSends: () => wrap("recoverInterruptedSends", recoverInterruptedSends()),
    };
  },
);

export const makeDurableRoutingStore = makeDurableRoutingStoreWithResolution();
