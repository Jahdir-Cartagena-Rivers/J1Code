import { DateTime, Effect, Option, Schema } from "effect";
import * as Context from "effect/Context";

import { ExternalRouteEndpoints } from "./ExternalRouteEndpoints.ts";
import type { StoredRoute } from "./durableRoutingStore.ts";
import { automaticRouteFeedback } from "./feedback.ts";
import type { RouteEndpoint, RouteStatus } from "./routeState.ts";

export interface LocalRouteNotice {
  readonly id: string;
  readonly source: RouteEndpoint;
  readonly destination: RouteEndpoint | null;
  readonly requestId: string;
  readonly revision: number;
  readonly status: RouteStatus;
  readonly summary: string;
  readonly occurredAt: DateTime.Utc;
}

export class LocalRouteNoticeError extends Schema.TaggedError<LocalRouteNoticeError>()(
  "LocalRouteNoticeError",
  { cause: Schema.Defect() },
) {}

/** Supplied by a durable V2 audit writer when local route activity is supported. */
export class LocalRouteNoticeWriter extends Context.Service<
  LocalRouteNoticeWriter,
  { readonly write: (notice: LocalRouteNotice) => Effect.Effect<void, LocalRouteNoticeError> }
>()("@j1code/server/routing/sourceActivity/LocalRouteNoticeWriter") {}

export function toLocalRouteNotice(
  row: StoredRoute,
  occurredAt: DateTime.Utc,
): LocalRouteNotice | null {
  const { state, revision } = row;
  if (state.request.feedbackFor) return null;
  return {
    id: `routing-notice:${state.request.requestId}:${revision}`,
    source: state.request.source,
    destination: state.request.destination,
    requestId: state.request.requestId,
    revision,
    status: state.status,
    summary: state.originalRequest.content.split("\n")[0]?.slice(0, 200) ?? "Forwarded request",
    occurredAt,
  };
}

/** Source status is informational and never advances the receiving attempt. */
export const makeRouteSourceNotifier = Effect.gen(function* () {
  const external = yield* Effect.serviceOption(ExternalRouteEndpoints);
  const local = yield* Effect.serviceOption(LocalRouteNoticeWriter);
  return Effect.fn("RouteSourceNotifier.publish")(
    function* (row: StoredRoute) {
      const notice = toLocalRouteNotice(row, yield* DateTime.now);
      if (notice === null) return "suppressed" as const;
      if (notice.source.threadId.startsWith("mausbot:")) {
        if (Option.isNone(external)) {
          yield* Effect.logWarning("External route source notice held", {
            requestId: notice.requestId,
          });
          return "held" as const;
        }
        if (automaticRouteFeedback(row.state)) yield* external.value.wake;
        yield* external.value.notice({
          endpoint: notice.source,
          requestId: notice.requestId,
          revision: notice.revision,
          status: notice.status,
          summary: notice.summary,
        });
      } else {
        if (Option.isNone(local)) {
          yield* Effect.logWarning("Local route source notice held pending V2 audit support", {
            requestId: notice.requestId,
            revision: notice.revision,
          });
          return "held" as const;
        }
        yield* local.value.write(notice);
      }
      return "published" as const;
    },
    (effect) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not publish source routing notice", { cause }).pipe(
            Effect.as("held" as const),
          ),
        ),
      ),
  );
});
