// @effect-diagnostics nodeBuiltinImport:off - selected memory service, credentials and attachment persistence are host-owned boundaries.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  HiveMindSnapshot,
  HiveMindImportResult,
  ChatImageAttachment,
  ChatFileAttachment,
  type HiveMindMutation,
} from "@t3tools/contracts";
import { readHiveConfig, readHiveConfigSync } from "./config.ts";
import { hiveContext, hiveMemoryDigest, type HiveImportFact } from "./store.ts";
import {
  recallHiveMind,
  rememberHiveMind,
  forgetHiveMind,
  hiveMindStatus,
  syncHiveMind,
} from "./engine.ts";
import { importHiveHindsight } from "./importHindsight.ts";
import {
  createAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";

import {
  selectedHiveConnection,
  requestHive,
  HiveTransportError,
  type HiveConnection,
} from "./connection.ts";
export { selectedHiveConnection, requestHive };
export type { HiveConnection };

const Packet = Schema.Struct({
  context: Schema.String,
  streamId: Schema.optionalKey(Schema.String),
  sequence: Schema.Number,
  usedIds: Schema.Array(Schema.String),
  taskId: Schema.NullOr(Schema.String),
  project: Schema.optionalKey(Schema.NullOr(Schema.String)),
  assets: Schema.Array(
    Schema.Struct({ id: Schema.String, mime: Schema.String, caption: Schema.String }),
  ),
});
export type HivePacket = typeof Packet.Type;
const RecordResult = Schema.Struct({
  id: Schema.String,
  revision: Schema.String,
  project: Schema.NullOr(Schema.String),
  scope: Schema.Literals(["general", "project"]),
  data: Schema.Record(Schema.String, Schema.Unknown),
});

export async function recallSelectedHive(file: string, query: string, project?: string) {
  const result = await recallHiveMind(file, query, project);
  return {
    ...result,
    memories: result.memories.map((m) => ({
      ...m,
      revision:
        "revision" in m && typeof m.revision === "string" ? m.revision : hiveMemoryDigest(m),
    })),
  };
}
export const rememberSelectedHive = rememberHiveMind;
export const forgetSelectedHive = forgetHiveMind;
export const selectedHiveStatus = hiveMindStatus;
export const syncSelectedHive = syncHiveMind;
export async function importSelectedHive(file: string, url: string, bank: string) {
  const connection = await selectedHiveConnection(file);
  return connection
    ? Schema.decodeUnknownSync(HiveMindImportResult)(
        await requestHive(connection, "/v1/import", { url, bank }),
      )
    : importHiveHindsight(file, url, bank);
}
export async function mutateExternalHive(file: string, input: HiveMindMutation) {
  const connection = await selectedHiveConnection(file);
  if (!connection) return false;
  const { action, ...body } = input;
  await requestHive(connection, `/v1/${action}`, body);
  return true;
}
export async function externalHiveSnapshot(file: string) {
  const config = await readHiveConfig(file);
  if (config.backend?.mode !== "external") return null;
  try {
    const connection = await selectedHiveConnection(file);
    if (!connection) return null;
    const snapshot = Schema.decodeUnknownSync(HiveMindSnapshot)(
      await requestHive(connection, "/v1/status"),
    );
    return { ...snapshot, config };
  } catch (error) {
    // Keep configuration reachable so the user can repair or switch back during an outage.
    return {
      config,
      defaultVault: "",
      defaultBank: "",
      records: 0,
      skills: 0,
      pendingIndex: 0,
      phase: "degraded" as const,
      lastSync: null,
      issues: [error instanceof Error ? error.message : "External Hive Mind is unavailable."],
    };
  }
}
export const hiveClientId = (file: string, threadId: string) =>
  `j1-${createHash("sha256").update(path.resolve(file)).digest("hex").slice(0, 12)}-${createHash("sha256").update(threadId).digest("hex").slice(0, 24)}`;
export const hiveEventId = (
  file: string,
  thread: string,
  instance: string,
  turn: string,
  event: string,
) =>
  `event:${hiveClientId(file, [thread, instance, turn, event].map(encodeURIComponent).join("|"))}`;
export async function selectedHiveContext(
  file: string,
  query: string,
  projects: readonly string[],
  threadId: string,
) {
  if (readHiveConfigSync(file).backend?.mode !== "external")
    return { context: hiveContext(file, query, projects), packet: null, connection: null };
  const connection = await selectedHiveConnection(file);
  if (!connection)
    return { context: hiveContext(file, query, projects), packet: null, connection: null };
  const packet = Schema.decodeUnknownSync(Packet)(
    await requestHive(connection, "/v1/working-context", {
      query: query.slice(0, 4000),
      projects,
      clientId: hiveClientId(file, threadId),
      threadId,
    }),
  );
  return { context: packet.context, packet, connection };
}
export async function acknowledgeHiveContext(
  file: string,
  connection: HiveConnection,
  threadId: string,
  packet: HivePacket,
) {
  const id = hiveClientId(file, threadId);
  const list = Schema.decodeUnknownSync(Schema.Struct({ records: Schema.Array(RecordResult) }))(
    await requestHive(connection, "/v1/brain", { kind: "client", id }),
  );
  const existing = list.records[0];
  let task;
  if (packet.taskId)
    task = Schema.decodeUnknownSync(Schema.Struct({ records: Schema.Array(RecordResult) }))(
      await requestHive(connection, "/v1/brain", { kind: "task", id: packet.taskId }),
    ).records[0];
  await requestHive(connection, "/v1/brain/save", {
    id,
    ...(existing ? { revision: existing.revision } : {}),
    kind: "client",
    scope: task?.scope ?? "general",
    project: task?.project ?? undefined,
    title: "J1 chat context",
    source: { threadId, provider: "J1", type: "agent" },
    data: {
      consumedSequence: packet.sequence,
      ...(packet.streamId ? { consumedStreamId: packet.streamId } : {}),
      deliveredIds: packet.usedIds,
      usedIds: [],
      ...(packet.taskId ? { taskId: packet.taskId } : {}),
    },
  });
}
export async function bindHiveTask(file: string, threadId: string, taskId?: string) {
  const connection = await selectedHiveConnection(file);
  if (!connection)
    throw new Error("Task binding requires the external Hive Mind backend in this version.");
  const packet = Schema.decodeUnknownSync(Packet)(
    await requestHive(connection, "/v1/working-context", {
      taskId,
      projects: [],
      query: "Continue this task",
      discoverTask: false,
    }),
  );
  await acknowledgeHiveContext(file, connection, threadId, packet);
  return { taskId: packet.taskId, sequence: packet.sequence };
}
export async function operateHiveContinuity(
  file: string,
  operation: "list" | "save" | "forget" | "claim",
  input: Readonly<Record<string, unknown>>,
  threadId: string,
) {
  const connection = await selectedHiveConnection(file);
  if (!connection)
    throw new Error(
      "Continuity records require the external Hive Mind backend in this version. Built-in memory remains available.",
    );
  const route = {
    list: "/v1/brain",
    save: "/v1/brain/save",
    forget: "/v1/brain/forget",
    claim: "/v1/tasks/claim",
  }[operation];
  return Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
    await requestHive(connection, route, {
      ...input,
      ...(operation === "claim" ? { owner: threadId } : {}),
      ...(operation === "save" ? { source: { threadId, provider: "J1", type: "agent" } } : {}),
    }),
  );
}
export async function retainHiveAttachment(
  file: string,
  input: {
    attachmentId: string;
    title: string;
    scope: "general" | "project";
    project?: string;
    media?: "file" | "image";
  },
  attachmentsDir: string,
  threadId: string,
) {
  const connection = await selectedHiveConnection(file);
  if (!connection)
    throw new Error("Retaining images requires the external Hive Mind backend in this version.");
  if (
    parseThreadSegmentFromAttachmentId(input.attachmentId) !==
    toSafeThreadAttachmentSegment(threadId)
  )
    throw new Error("Only an attachment from this chat can be retained.");
  const target = resolveAttachmentPathById({ attachmentsDir, attachmentId: input.attachmentId });
  if (!target) throw new Error("The source attachment is unavailable.");
  const stat = await fs.lstat(target);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > (input.media === "file" ? 25 : 10) * 1024 * 1024
  )
    throw new Error("Invalid source reference.");
  return Schema.decodeUnknownSync(RecordResult)(
    await requestHive(connection, input.media === "file" ? "/v1/files" : "/v1/assets", {
      scope: input.scope,
      project: input.project,
      title: input.title,
      ...(input.media === "file" ? { filename: path.basename(target) } : {}),
      base64: (await fs.readFile(target)).toString("base64"),
      source: { threadId, provider: "J1", type: "agent" },
    }),
  );
}
export async function captureHiveEvent(
  connection: HiveConnection,
  input: {
    eventId: string;
    threadId: string;
    provider: string;
    project: string;
    summary: string;
    taskId?: string;
    assetIds?: readonly string[];
    contextSequence?: number;
    contextStreamId?: string;
    deliveredIds?: readonly string[];
  },
) {
  const redact = (s: string) =>
    s
      .replace(
        /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu,
        "[redacted private key]",
      )
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/giu, "[redacted credential]")
      .replace(/\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{16,}\b/gu, "[redacted credential]")
      .replace(
        /\b(?:password|api[_ -]?key|access[_ -]?token|secret)\s*(?::|=|is\b)\s*\S+/giu,
        "[redacted credential]",
      );
  return requestHive(connection, "/v1/brain/save", {
    kind: "episode",
    eventId: input.eventId,
    scope: "project",
    project: input.project,
    title: "J1 turn activity",
    source: { threadId: input.threadId, provider: input.provider, type: "agent" },
    data: {
      eventId: input.eventId,
      summary: redact(input.summary).slice(0, 1500),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.assetIds?.length ? { assetIds: input.assetIds } : {}),
      ...(input.contextSequence !== undefined ? { contextSequence: input.contextSequence } : {}),
      ...(input.contextStreamId ? { contextStreamId: input.contextStreamId } : {}),
      ...(input.deliveredIds ? { deliveredIds: input.deliveredIds } : {}),
    },
  });
}
export async function materializeHiveAsset(
  connection: HiveConnection,
  id: string,
  attachmentsDir: string,
  threadId: string,
) {
  if (!/^[\w.-]{1,128}$/u.test(id)) throw new Error("Invalid image reference.");
  const downloaded = await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.setHeader(
          HttpClientRequest.get(`${connection.origin}/v1/assets/${id}`),
          "authorization",
          `Bearer ${connection.token}`,
        ),
      );
      if (response.status !== 200 || Number(response.headers["content-length"]) > 25 * 1024 * 1024)
        return yield* new HiveTransportError({
          message: "Hive Mind reference is unavailable or exceeds the reference limit.",
        });
      return {
        mime: response.headers["content-type"] ?? "",
        filename: response.headers["x-hive-filename"],
        bytes: yield* response.arrayBuffer,
      };
    }).pipe(
      Effect.timeout(5000),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    ),
  ).catch(() => {
    throw new Error("Hive Mind reference is unavailable; no other memory source was used.");
  });
  const mime = downloaded.mime;
  const extensions: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  const filename = downloaded.filename
    ? decodeURIComponent(downloaded.filename)
    : `Hive Mind reference.${extensions[mime] ?? "bin"}`;
  if (!filename || filename.length > 255 || /[\\/\u0000-\u001f]/u.test(filename))
    throw new Error("Invalid reference filename.");
  const ext =
    extensions[mime] ??
    (mime === "application/octet-stream"
      ? path
          .extname(filename)
          .slice(1)
          .replace(/[^a-zA-Z0-9]/gu, "")
          .slice(0, 10) || "bin"
      : undefined);
  if (!ext) throw new Error("Unsupported Hive Mind reference response.");
  const bytes = Buffer.from(downloaded.bytes);
  if (bytes.length > (extensions[mime] ? 10 : 25) * 1024 * 1024)
    throw new Error("Hive Mind reference is too large.");
  const attachmentId = createAttachmentId(threadId, ext);
  if (!attachmentId) throw new Error("Invalid image destination thread.");
  const attachment = Schema.decodeUnknownSync(
    Schema.Union([ChatImageAttachment, ChatFileAttachment]),
  )({
    type: extensions[mime] ? "image" : "file",
    id: attachmentId,
    name: filename,
    mimeType: mime,
    sizeBytes: bytes.length,
  });
  await fs.mkdir(attachmentsDir, { recursive: true });
  const target = path.join(attachmentsDir, `${attachmentId}.${ext}`);
  await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  const resolved = resolveAttachmentPath({ attachmentsDir, attachment });
  if (resolved !== target) {
    await fs.unlink(target);
    throw new Error("Image attachment could not be resolved.");
  }
  return { attachment, path: target };
}
export const materializeHiveImage = materializeHiveAsset;
