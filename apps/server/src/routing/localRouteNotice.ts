import { CommandId, OrchestrationV2RouteNotice, ThreadId } from "@j1code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { makeDurableRoutingStore } from "./durableRoutingStore.ts";
import { LocalRouteNoticeWriter, toLocalRouteNotice } from "./sourceActivity.ts";

/** Re-read the server-owned route; caller-supplied notices never supply status or authority. */
export const layerLocalRouteNoticeWriter = Layer.effect(
  LocalRouteNoticeWriter,
  Effect.gen(function* () {
    const routes = yield* makeDurableRoutingStore;
    const environment = yield* ServerEnvironment;
    const orchestration = yield* OrchestratorV2;
    return LocalRouteNoticeWriter.of({
      write: Effect.fn("LocalRouteNoticeWriter.write")(function* (input) {
        const row = yield* routes.get(input.requestId);
        if (row === null || row.revision < input.revision) {
          return yield* Effect.fail(new Error("Route notice revision is unavailable."));
        }
        const current = toLocalRouteNotice(row, yield* DateTime.now);
        if (current === null) return;
        const env = yield* environment.getEnvironmentId;
        if (current.source.environmentId !== env ||
            current.source.environmentId !== input.source.environmentId ||
            current.source.projectId !== input.source.projectId ||
            current.source.threadId !== input.source.threadId ||
            current.source.threadId.startsWith("mausbot:")) {
          return yield* Effect.fail(new Error("Route notice source is unavailable."));
        }
        const notice = yield* Schema.decodeUnknownEffect(OrchestrationV2RouteNotice)({
          ...current, occurredAt: DateTime.formatIso(current.occurredAt),
        });
        yield* orchestration.dispatch({
          type: "thread.route-status.record",
          commandId: CommandId.make(current.id),
          threadId: ThreadId.make(current.source.threadId),
          notice,
        });
      }),
    });
  }),
);
