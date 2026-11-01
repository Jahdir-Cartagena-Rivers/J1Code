import * as Effect from "effect/Effect";
import type { RouteState } from "../../../routing/routeState.ts";
import {
  listRoutes,
  routeRequest,
  routeStatus,
  recipientReceipt,
  claimTask,
  releaseTask,
  routingMode,
} from "./boundary.ts";
import { RoutingToolkit } from "./tools.ts";

const summary = (state: RouteState) => ({
  requestId: state.request.requestId,
  status: state.status,
  reason: state.reason,
  destinationUrl: state.request.destination
    ? `/${encodeURIComponent(state.request.destination.environmentId)}/${encodeURIComponent(state.request.destination.threadId)}`
    : null,
  sourceUrl: `/${encodeURIComponent(state.request.source.environmentId)}/${encodeURIComponent(state.request.source.threadId)}`,
});
export const RoutingToolkitHandlers = RoutingToolkit.toLayer(
  Effect.succeed(
    RoutingToolkit.of({
      release_task: ({ taskId, requestId }) => releaseTask(taskId, requestId),
      routing_mode: () => routingMode,
      claim_task: ({ taskId, requestId }) => claimTask(taskId, requestId),
      acknowledge_route: ({ requestId, kind }) =>
        recipientReceipt(requestId, kind).pipe(Effect.map(summary)),
      route_task: (input) => routeRequest(input).pipe(Effect.map(summary)),
      routing_status: ({ requestId }) => routeStatus(requestId).pipe(Effect.map(summary)),
      list_routes: () => listRoutes.pipe(Effect.map((routes) => routes.map(summary))),
    }),
  ),
);
