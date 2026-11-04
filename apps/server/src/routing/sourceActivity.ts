import { CommandId, EventId, ThreadId, manualRouteStatusLabel } from "@t3tools/contracts";
import { DateTime, Effect } from "effect";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type { StoredRoute } from "./durableRoutingStore.ts";

/** Durable source-chat notice, never evidence of destination acceptance. */
export const makeRouteSourceNotifier = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  return (row: StoredRoute) =>
    Effect.gen(function* () {
      const { state, revision } = row;
      const id = `routing-notice:${state.request.requestId}:${revision}`;
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(id),
        threadId: ThreadId.make(state.request.source.threadId),
        createdAt,
        activity: {
          id: EventId.make(id),
          kind: "routing.updated",
          tone: "info",
          turnId: null,
          createdAt,
          summary: `Request: ${manualRouteStatusLabel(state.status)}`,
          payload: {
            requestId: state.request.requestId,
            revision,
            status: state.status,
            summary:
              state.originalRequest.content.split("\n")[0]?.slice(0, 200) ?? "Forwarded request",
            destination: state.request.destination,
          },
        },
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not publish source routing notice", { cause }),
      ),
    );
});
