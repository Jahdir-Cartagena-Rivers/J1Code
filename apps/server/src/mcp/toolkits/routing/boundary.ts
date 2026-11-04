import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { DeliveryRequest } from "../../../routing/deliveryDispatcher.ts";
import type { RouteEndpoint, RouteState } from "../../../routing/routeState.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000));
export const Endpoint = Schema.Struct({ environmentId: Text, projectId: Text, threadId: Text });
export const RouteInput = Schema.Struct({
  requestId: Text.check(Schema.isMaxLength(128)),
  taskId: Text,
  request: Text,
  candidate: Schema.optional(Endpoint),
});
export type RouteInput = typeof RouteInput.Type;
export interface RoutingPorts {
  readonly release?: (
    endpoint: RouteEndpoint,
    taskId: string,
    requestId: string,
  ) => Effect.Effect<void, string>;
  readonly claim?: (
    endpoint: RouteEndpoint,
    taskId: string,
    requestId: string,
  ) => Effect.Effect<void, string>;
  readonly receipt?: (
    endpoint: RouteEndpoint,
    requestId: string,
    kind: "accepted" | "completed" | "failed",
  ) => Effect.Effect<RouteState, string>;
  /** Current snapshot lookup; null includes archived/deleted/unavailable threads. */
  readonly current: (
    environmentId: string,
    threadId: string,
  ) => Effect.Effect<RouteEndpoint | null, string>;
  readonly policy: (
    source: RouteEndpoint,
    requestId: string,
    taskId?: string,
  ) => Effect.Effect<
    {
      readonly mode: "off" | "suggest" | "auto";
      /** An authenticated user action bound to this request, never model intent. */
      readonly manual: boolean;
      readonly visited: readonly RouteEndpoint[];
      readonly maxHops: number;
    },
    string
  >;
  readonly owner: (
    source: RouteEndpoint,
    taskId: string,
    candidate?: RouteEndpoint,
    request?: string,
  ) => Effect.Effect<
    {
      readonly destination: RouteEndpoint | null;
      readonly ambiguous: boolean;
    },
    string
  >;
  /** Must atomically bind idempotency to the supplied fingerprint AND persist before dispatch.
   * Adapt to DeliveryDispatcher.register/dispatch; permissions come from its trusted inspect port.
   * Store the original request and sourceUrl alongside the route, not only in model prose.
   */
  readonly submit: (input: {
    readonly route: DeliveryRequest;
    readonly fingerprint: string;
    readonly originalRequest: string;
    readonly sourceUrl: string;
  }) => Effect.Effect<RouteState, string>;
  readonly get: (requestId: string) => Effect.Effect<RouteState | null, string>;
  /** Must query only routes involving this endpoint; boundary also filters every result. */
  readonly list: (endpoint: RouteEndpoint) => Effect.Effect<readonly RouteState[], string>;
}
export class RoutingBoundaryPorts extends Context.Service<RoutingBoundaryPorts, RoutingPorts>()(
  "t3/mcp/toolkits/routing/boundary/RoutingBoundaryPorts",
) {}

const same = (a: RouteEndpoint, b: RouteEndpoint) =>
  a.environmentId === b.environmentId && a.projectId === b.projectId && a.threadId === b.threadId;
const visible = (state: RouteState, endpoint: RouteEndpoint) =>
  same(state.request.source, endpoint) ||
  (state.request.destination !== null && same(state.request.destination, endpoint));

export const currentEndpoint = Effect.gen(function* () {
  const scope = yield* McpInvocationContext;
  if (!scope.capabilities.has("agents"))
    return yield* Effect.fail("Routing unavailable for this session.");
  const ports = yield* RoutingBoundaryPorts;
  const source = yield* ports.current(scope.environmentId, scope.threadId);
  if (!source || source.environmentId !== scope.environmentId || source.threadId !== scope.threadId)
    return yield* Effect.fail("Source unavailable.");
  return source;
});

const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeInput = Schema.decodeUnknownEffect(RouteInput);

export const routeRequest = Effect.fn("RoutingBoundary.route")(function* (unknownInput: unknown) {
  const input = yield* decodeInput(unknownInput, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => "Invalid routing input."));
  const source = yield* currentEndpoint;
  const ports = yield* RoutingBoundaryPorts;
  const policy = yield* ports.policy(source, input.requestId, input.taskId);
  const owner = yield* ports.owner(source, input.taskId, input.candidate, input.request);
  if (owner.destination) {
    const actual = yield* ports.current(
      owner.destination.environmentId,
      owner.destination.threadId,
    );
    if (!actual || !same(actual, owner.destination))
      return yield* Effect.fail("Destination unavailable.");
  }
  const sourceUrl = `/${encodeURIComponent(source.environmentId)}/${encodeURIComponent(source.threadId)}`;
  // Namespace caller IDs by authenticated source; bind original intent before mutable discovery.
  const requestId = NodeCrypto.createHash("sha256")
    .update(encodeIdentity([source, input.requestId]))
    .digest("hex");
  const fingerprint = NodeCrypto.createHash("sha256")
    .update(encodeIdentity([source, input]))
    .digest("hex");
  return yield* ports.submit({
    fingerprint,
    originalRequest: input.request,
    sourceUrl,
    route: {
      requestId,
      taskId: input.taskId,
      source,
      destination: owner.destination,
      content: `${input.request}\n\n[Source conversation](${sourceUrl})`,
      mode: policy.mode,
      initiation: policy.manual ? "manual" : "automatic",
      ambiguous: owner.ambiguous,
      visited: policy.visited,
      maxHops: policy.maxHops,
    },
  });
});

export const routeStatus = Effect.fn("RoutingBoundary.status")(function* (requestId: string) {
  const source = yield* currentEndpoint;
  const ports = yield* RoutingBoundaryPorts;
  const state = yield* ports.get(requestId);
  if (!state || !visible(state, source)) return yield* Effect.fail("Route unavailable.");
  return state;
});
export const listRoutes = Effect.gen(function* () {
  const source = yield* currentEndpoint;
  const ports = yield* RoutingBoundaryPorts;
  return (yield* ports.list(source)).filter((state) => visible(state, source));
});

export const recipientReceipt = Effect.fn("RoutingBoundary.recipientReceipt")(function* (
  requestId: string,
  kind: "accepted" | "completed" | "failed",
) {
  const endpoint = yield* currentEndpoint;
  const ports = yield* RoutingBoundaryPorts;
  if (!ports.receipt) return yield* Effect.fail("Recipient acknowledgment unavailable.");
  return yield* ports.receipt(endpoint, requestId, kind);
});

export const routingMode = Effect.gen(function* () {
  const source = yield* currentEndpoint;
  return { mode: (yield* (yield* RoutingBoundaryPorts).policy(source, "mode")).mode };
});
export const claimTask = Effect.fn("RoutingBoundary.claim")(function* (
  taskId: string,
  requestId: string,
) {
  const source = yield* currentEndpoint;
  const ports = yield* RoutingBoundaryPorts;
  if (!ports.claim) return yield* Effect.fail("Task ownership unavailable.");
  yield* ports.claim(source, taskId, requestId);
  return { taskId };
});
export const releaseTask = Effect.fn("RoutingBoundary.release")(function* (
  taskId: string,
  requestId: string,
) {
  const source = yield* currentEndpoint;
  const ports = yield* RoutingBoundaryPorts;
  if (!ports.release) return yield* Effect.fail("Task release unavailable.");
  yield* ports.release(source, taskId, requestId);
  return { taskId };
});
