import * as Effect from "effect/Effect";
import {
  forgetHiveMind,
  hiveMindStatus,
  recallHiveMind,
  rememberHiveMind,
  syncHiveMind,
} from "../../../hiveMind/connector.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { HiveMindToolkit } from "./tools.ts";

/** Agent-facing tools; the memory itself lives in the separate Hive Mind app. */
export const HiveMindToolkitHandlersLive = HiveMindToolkit.toLayer(
  Effect.succeed(
    HiveMindToolkit.of({
      hive_mind_status: () => hiveMindStatus(),
      hive_mind_sync: () => syncHiveMind(),
      hive_mind_recall: ({ query, project }) => recallHiveMind(query, project),
      hive_mind_remember: ({ scope, project, subject, fact }) =>
        McpInvocationContext.pipe(
          Effect.flatMap((invocation) =>
            rememberHiveMind({
              scope,
              subject,
              fact,
              project,
              sourceThreadId: String(invocation.threadId),
            }),
          ),
        ),
      hive_mind_forget: ({ id }) => forgetHiveMind(id),
    }),
  ),
);
