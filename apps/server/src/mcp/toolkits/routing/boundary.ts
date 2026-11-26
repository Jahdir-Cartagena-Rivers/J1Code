import { replayRouteInput } from "../../../routing/routeState.ts";
import { routeEndpointUrl } from "@j1code/shared/routeEndpointUrl";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { DeliveryRequest } from "../../../routing/deliveryDispatcher.ts";
import type { RouteEndpoint, RouteOrigin, RouteState } from "../../../routing/routeState.ts";
import { ServerEnvironment } from "../../../environment/ServerEnvironment.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { McpInvocationContext, requireMcpCapability, requireThreadScope } from "../../McpInvocationContext.ts";
import { assertLiveCaller, loadCaller } from "../../threadAccess.ts";
import { botExecutionContext } from "../../../mausbot/ExecutionContext.ts";
import { isLiveDeepAIOrigin } from "../../../provider/deepai/DeepAIMcpInvocation.ts";

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
    message?: string,
  ) => Effect.Effect<RouteState, string>;
  readonly reply?: (
    endpoint: RouteEndpoint,
    requestId: string,
    replyId: string,
    message: string,
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
  "@j1code/server/mcp/toolkits/routing/boundary/RoutingBoundaryPorts",
) {}

const same = (a: RouteEndpoint, b: RouteEndpoint) =>
  a.environmentId === b.environmentId && a.projectId === b.projectId && a.threadId === b.threadId;
const visible = (state: RouteState, endpoint: RouteEndpoint) =>
  same(state.request.source, endpoint) ||
  (state.request.destination !== null && same(state.request.destination, endpoint));

const sha256 = (text: string) =>
  Effect.promise(async () =>
    Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).toString("hex"),
  );

const unavailable = "An active native conversation is required for this tool.";

export const nativeAgentCallerDependencies = [McpInvocationContext, ThreadManagementService, ServerEnvironment] as const;

/** The provider credential selected by HTTP admission remains the sole native speaker. */
export const nativeAgentCaller = Effect.gen(function* () {
  const invocation = yield* requireMcpCapability("agents").pipe(Effect.mapError(() => unavailable));
  if (invocation.client !== undefined) return yield* Effect.fail(unavailable);
  const scope = yield* Effect.mapError(
    requireThreadScope(invocation, "Native conversation tools"),
    () => unavailable,
  );
  if (!scope.thread.providerSessionId.trim()) return yield* Effect.fail(unavailable);
  const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
  if (environmentId !== scope.environmentId) return yield* Effect.fail(unavailable);
  const context = yield* loadCaller().pipe(Effect.mapError(() => unavailable));
  if (context.caller === undefined || context.caller.id !== scope.thread.threadId)
    return yield* Effect.fail(unavailable);
  yield* Effect.mapError(assertLiveCaller(context), () => unavailable);
  if (botExecutionContext(scope.thread.threadId))
    return yield* Effect.fail("Use this bot's selected tools through bot_tools and bot_call.");
  return { scope, caller: context.caller };
});

export const currentEndpoint = Effect.gen(function* () {
  const { scope, caller } = yield* nativeAgentCaller;
  const ports = yield* RoutingBoundaryPorts;
  const expected = {
    environmentId: scope.environmentId, threadId: scope.thread.threadId, projectId: caller.projectId,
  };
  const source = yield* ports.current(expected.environmentId, expected.threadId);
  if (!source || !same(source, expected)) return yield* Effect.fail("Source unavailable.");
  return source;
});

const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeInput = Schema.decodeUnknownEffect(RouteInput);
const sameOrigin = (left: RouteOrigin | undefined, right: RouteOrigin | undefined) =>
  left?.subject === right?.subject &&
  left?.runId === right?.runId &&
  left?.messageId === right?.messageId;
/** Host adapters supply an authenticated endpoint effect; tool arguments never select a speaker. */
export function makeRoutingBoundary<R, RegistrationContext = never>(
  currentEndpoint: Effect.Effect<RouteEndpoint, string, R>,
  authorizeRegistration?: (source: RouteEndpoint) => Effect.Effect<RouteOrigin, string, RegistrationContext>,
) {
  const routeRequest = Effect.fn("RoutingBoundary.route")(function* (unknownInput: unknown) {
    const input = yield* decodeInput(unknownInput, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => "Invalid routing input."));
    const source = yield* currentEndpoint;
    const ports = yield* RoutingBoundaryPorts;
    // Namespace caller IDs by authenticated source; bind original intent before mutable discovery.
    const requestId = yield* sha256(encodeIdentity([source, input.requestId]));
    const origin = authorizeRegistration === undefined ? undefined : yield* authorizeRegistration(source);
    const recheckOrigin = authorizeRegistration === undefined
      ? Effect.void
      : authorizeRegistration(source).pipe(
          Effect.filterOrFail((current) => sameOrigin(origin, current), () => "Route input identity conflict"),
          Effect.asVoid,
        );
    const fingerprint = yield* sha256(encodeIdentity(origin === undefined ? [source, input] : [source, input, origin]));
    const prior = yield* ports.get(requestId);
    if (prior !== null) {
      yield* recheckOrigin;
      if (!same(prior.originalRequest.source, source) || !sameOrigin(prior.originalRequest.origin, origin))
        return yield* Effect.fail("Route input identity conflict");
      return yield* Effect.try({ try: () => replayRouteInput(prior, fingerprint), catch: () => "Route input identity conflict; read the saved route status." });
    }
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
    yield* recheckOrigin;
    const sourceUrl = routeEndpointUrl(source);
    return yield* ports.submit({
      fingerprint,
      originalRequest: input.request,
      sourceUrl,
      route: {
        requestId,
        ...(origin === undefined ? {} : { origin }),
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

  const canReadOrigin = (state: RouteState, subject: string | undefined) =>
    state.originalRequest.origin === undefined || state.originalRequest.origin.subject === subject;
  const readSubject = (source: RouteEndpoint) => Effect.serviceOption(McpInvocationContext).pipe(
    Effect.map((scope) => {
      const thread = Option.getOrUndefined(scope)?.thread;
      const origin = thread?.deepAIOrigin;
      return origin !== undefined && isLiveDeepAIOrigin(origin) &&
        origin.environmentId === source.environmentId && origin.projectId === source.projectId &&
        origin.threadId === source.threadId && origin.providerSessionId === thread?.providerSessionId
        ? origin.subject
        : undefined;
    }),
  );
  const routeStatus = Effect.fn("RoutingBoundary.status")(function* (requestId: string) {
    const source = yield* currentEndpoint;
    const ports = yield* RoutingBoundaryPorts;
    const state = yield* ports.get(requestId);
    const subject = authorizeRegistration === undefined ? undefined : yield* readSubject(source);
    if (!state || !visible(state, source) || !canReadOrigin(state, subject))
      return yield* Effect.fail("Route unavailable.");
    return state;
  });
  const listRoutes = Effect.gen(function* () {
    const source = yield* currentEndpoint;
    const ports = yield* RoutingBoundaryPorts;
    const states = yield* ports.list(source);
    const subject = authorizeRegistration === undefined ? undefined : yield* readSubject(source);
    return states.filter((state) => visible(state, source) && canReadOrigin(state, subject));
  });

  const recipientReceipt = Effect.fn("RoutingBoundary.recipientReceipt")(function* (
    requestId: string,
    kind: "accepted" | "completed" | "failed",
    message?: string,
  ) {
    const endpoint = yield* currentEndpoint;
    const ports = yield* RoutingBoundaryPorts;
    if (!ports.receipt) return yield* Effect.fail("Recipient acknowledgment unavailable.");
    return yield* ports.receipt(endpoint, requestId, kind, message);
  });

  const replyToRoute = Effect.fn("RoutingBoundary.reply")(function* (
    requestId: string,
    replyId: string,
    message: string,
  ) {
    const endpoint = yield* currentEndpoint;
    const ports = yield* RoutingBoundaryPorts;
    if (!ports.reply) return yield* Effect.fail("Route reply unavailable.");
    return yield* ports.reply(endpoint, requestId, replyId, message);
  });

  const routingMode = Effect.gen(function* () {
    const source = yield* currentEndpoint;
    return { mode: (yield* (yield* RoutingBoundaryPorts).policy(source, "mode")).mode };
  });
  const claimTask = Effect.fn("RoutingBoundary.claim")(function* (
    taskId: string,
    requestId: string,
  ) {
    const source = yield* currentEndpoint;
    const ports = yield* RoutingBoundaryPorts;
    if (!ports.claim) return yield* Effect.fail("Task ownership unavailable.");
    yield* ports.claim(source, taskId, requestId);
    return { taskId };
  });
  const releaseTask = Effect.fn("RoutingBoundary.release")(function* (
    taskId: string,
    requestId: string,
  ) {
    const source = yield* currentEndpoint;
    const ports = yield* RoutingBoundaryPorts;
    if (!ports.release) return yield* Effect.fail("Task release unavailable.");
    yield* ports.release(source, taskId, requestId);
    return { taskId };
  });
  return {
    routeRequest,
    routeStatus,
    listRoutes,
    recipientReceipt,
    replyToRoute,
    routingMode,
    claimTask,
    releaseTask,
  };
}
export const {
  routeRequest,
  routeStatus,
  listRoutes,
  recipientReceipt,
  replyToRoute,
  routingMode,
  claimTask,
  releaseTask,
} = makeRoutingBoundary(
  currentEndpoint,
  (source) => Effect.gen(function* () {
    const { scope, caller } = yield* nativeAgentCaller;
    const origin = scope.thread.deepAIOrigin;
    if (origin === undefined || !isLiveDeepAIOrigin(origin) || origin.environmentId !== source.environmentId ||
        origin.projectId !== source.projectId || origin.threadId !== source.threadId ||
        origin.runId !== caller.activeRunId || origin.providerSessionId !== scope.thread.providerSessionId)
      return yield* Effect.fail("This provider call has no verified originating message. Route registration unavailable.");
    return { subject: origin.subject, runId: origin.runId, messageId: origin.messageId };
  }),
);
