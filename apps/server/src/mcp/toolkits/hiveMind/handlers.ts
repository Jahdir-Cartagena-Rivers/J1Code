// @effect-diagnostics nodeBuiltinImport:off - joins the server-owned state directory for the Node-backed store.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as ServerConfig from "../../../config.ts";
import {
  forgetHiveMind,
  hiveMindStatus,
  recallHiveMind,
  rememberHiveMind,
  syncHiveMind,
} from "../../../hiveMind/engine.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { HiveMindError, HiveMindToolkit } from "./tools.ts";

const fromPromise = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => new HiveMindError({ message: String(error) }),
  });

export const HiveMindToolkitHandlersLive = HiveMindToolkit.toLayer(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const filePath = NodePath.join(config.stateDir, "hive-mind.json");
    return HiveMindToolkit.of({
      hive_mind_status: () => fromPromise(() => hiveMindStatus(filePath)),
      hive_mind_sync: () => fromPromise(() => syncHiveMind(filePath)),
      hive_mind_recall: ({ query, project }) =>
        fromPromise(() => recallHiveMind(filePath, query, project)),
      hive_mind_remember: ({ scope, project, subject, fact }) =>
        McpInvocationContext.pipe(
          Effect.flatMap((invocation) =>
            fromPromise(async () => ({
              memory: await rememberHiveMind(filePath, {
                scope,
                project: project ?? null,
                subject,
                fact,
                sourceThreadId: String(invocation.threadId),
              }),
            })),
          ),
        ),
      hive_mind_forget: ({ id }) =>
        fromPromise(async () => ({ removed: await forgetHiveMind(filePath, id) })),
    });
  }),
);
