// @effect-diagnostics nodeBuiltinImport:off - joins the server-owned state directory for the Node-backed store.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../../config.ts";
import {
  forgetSelectedHive as forgetHiveMind,
  selectedHiveStatus as hiveMindStatus,
  recallSelectedHive as recallHiveMind,
  rememberSelectedHive as rememberHiveMind,
  syncSelectedHive as syncHiveMind,
} from "../../../hiveMind/backend.ts";
import {
  operateHiveContinuity,
  bindHiveTask,
  retainHiveAttachment,
  selectedHiveConnection,
  materializeHiveImage,
  requestHive,
} from "../../../hiveMind/backend.ts";
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
      hive_mind_continuity: ({ operation, input }) =>
        McpInvocationContext.pipe(
          Effect.flatMap((invocation) =>
            fromPromise(() =>
              operateHiveContinuity(filePath, operation, input, String(invocation.threadId)),
            ),
          ),
        ),
      hive_mind_continue_task: ({ taskId }) =>
        McpInvocationContext.pipe(
          Effect.flatMap((invocation) =>
            fromPromise(() => bindHiveTask(filePath, String(invocation.threadId), taskId)),
          ),
        ),
      hive_mind_retain_reference: (input) =>
        McpInvocationContext.pipe(
          Effect.flatMap((invocation) =>
            fromPromise(async () => ({
              ...(await retainHiveAttachment(
                filePath,
                input,
                config.attachmentsDir,
                String(invocation.threadId),
              )),
            })),
          ),
        ),
      hive_mind_read_reference: ({ id }) =>
        McpInvocationContext.pipe(
          Effect.flatMap((invocation) =>
            fromPromise(async () => {
              const connection = await selectedHiveConnection(filePath);
              if (!connection)
                throw new Error("Select external Hive Mind to retrieve retained images.");
              const result = await materializeHiveImage(
                connection,
                id,
                config.attachmentsDir,
                String(invocation.threadId),
              );
              return { path: result.path, mimeType: result.attachment.mimeType };
            }),
          ),
        ),
      hive_mind_active_chats: () =>
        McpInvocationContext.pipe(
          Effect.flatMap((invocation) =>
            fromPromise(async () => {
              const connection = await selectedHiveConnection(filePath);
              if (!connection)
                throw new Error("Live chat status requires the external Hive Mind backend.");
              return Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
                await requestHive(connection, "/v1/presence/list", {
                  excludeChatId: String(invocation.threadId),
                }),
              );
            }),
          ),
        ),
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
