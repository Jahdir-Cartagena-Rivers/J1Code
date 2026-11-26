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
import { nativeAgentCaller } from "../routing/boundary.ts";
import type { ThreadId } from "@j1code/contracts";
import { HiveMindError, HiveMindToolkit } from "./tools.ts";

const fromPromise = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => new HiveMindError({ message: String(error) }),
  });

// Authenticate before calling the selected backend, including operations that do not carry provenance.
const forCaller = <A>(run: (threadId: ThreadId) => Promise<A>) =>
  nativeAgentCaller.pipe(
    Effect.mapError((message) => new HiveMindError({ message })),
    Effect.flatMap(({ scope }) => fromPromise(() => run(scope.thread.threadId))),
  );

export const HiveMindToolkitHandlersLive = HiveMindToolkit.toLayer(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const filePath = NodePath.join(config.stateDir, "hive-mind.json");
    return HiveMindToolkit.of({
      hive_mind_continuity: ({ operation, input }) =>
        forCaller((threadId) => {
          // Legacy callers could supply owner/source fields. The selected backend stamps provenance.
          const payload = { ...input };
          delete payload.owner;
          delete payload.source;
          delete payload.sourceThreadId;
          return operateHiveContinuity(filePath, operation, payload, threadId);
        }),
      hive_mind_continue_task: ({ taskId }) =>
        forCaller((threadId) => bindHiveTask(filePath, threadId, taskId)),
      hive_mind_retain_reference: (input) =>
        forCaller((threadId) => retainHiveAttachment(filePath, input, config.attachmentsDir, threadId)),
      hive_mind_read_reference: ({ id }) =>
        forCaller(async (threadId) => {
          const connection = await selectedHiveConnection(filePath);
          if (!connection) throw new Error("Select external Hive Mind to retrieve retained images.");
          const result = await materializeHiveImage(connection, id, config.attachmentsDir, threadId);
          return { path: result.path, mimeType: result.attachment.mimeType };
        }),
      hive_mind_active_chats: () =>
        forCaller(async (threadId) => {
          const connection = await selectedHiveConnection(filePath);
          if (!connection) throw new Error("Live chat status requires the external Hive Mind backend.");
          return Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
            await requestHive(connection, "/v1/presence/list", { excludeChatId: threadId }),
          );
        }),
      hive_mind_status: () => forCaller(() => hiveMindStatus(filePath)),
      hive_mind_sync: () => forCaller(() => syncHiveMind(filePath)),
      hive_mind_recall: ({ query, project }) => forCaller(() => recallHiveMind(filePath, query, project)),
      hive_mind_remember: ({ scope, project, subject, fact }) =>
        forCaller(async (threadId) => ({
          memory: await rememberHiveMind(filePath, {
            scope,
            project: project ?? null,
            subject,
            fact,
            sourceThreadId: threadId,
          }),
        })),
      hive_mind_forget: ({ id }) => forCaller(async () => ({ removed: await forgetHiveMind(filePath, id) })),
    });
  }),
);
