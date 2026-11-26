import type { ChatAttachment } from "@j1code/contracts";
import * as Effect from "effect/Effect";
import * as Hive from "../hiveMind/backend.ts";
import { isConversationalOnly } from "../hiveMind/store.ts";
import { WorkflowCapture, workflowSummary } from "../hiveMind/workflowCapture.ts";
import { LivePresence, type PresenceTarget } from "../hiveMind/livePresence.ts";

const MiB = 1024 * 1024;

export interface HiveTurnCapture {
  readonly presenceTarget?: PresenceTarget<Hive.HiveConnection>;
  readonly acknowledged: Effect.Effect<void>;
  readonly append: (turnId: string, itemId: string, text: string) => void;
  readonly finish: (turnId: string, status: string) => Effect.Effect<void> | undefined;
}

export class HiveRunPresence {
  private readonly owners = new Map<string, symbol>();
  private readonly presence: LivePresence<Hive.HiveConnection>;
  private closed = false;

  constructor(
    send: ConstructorParameters<typeof LivePresence<Hive.HiveConnection>>[0] =
      (connection, body) => Hive.requestHive(connection, "/v1/presence", body),
    now: () => number = Date.now,
  ) {
    this.presence = new LivePresence(send, now);
  }

  begin(threadId: string, target: PresenceTarget<Hive.HiveConnection>) {
    if (this.closed) return undefined;
    const owner = Symbol();
    this.owners.set(threadId, owner);
    this.presence.begin(threadId, target);
    const release = (method: "finish" | "end") => {
      if (this.owners.get(threadId) !== owner) return;
      this.owners.delete(threadId);
      this.presence[method](threadId);
    };
    return {
      observe: (event: Parameters<LivePresence<Hive.HiveConnection>["observe"]>[1]) => {
        if (this.owners.get(threadId) === owner) this.presence.observe(threadId, event);
      },
      finish: () => release("finish"),
      end: () => release("end"),
    };
  }

  heartbeat() {
    this.presence.heartbeat();
  }

  close() {
    this.closed = true;
    for (const threadId of this.owners.keys()) this.presence.end(threadId);
    this.owners.clear();
    return this.presence.flush();
  }
}

export const prepareHiveTurnRecall = Effect.fn("HiveTurnRecall.prepare")(function* (
  input: {
    readonly file: string;
    readonly query: string;
    readonly projects: readonly string[];
    readonly standalone: boolean;
    readonly threadId: string;
    readonly attachmentsDir: string;
    readonly attachments: readonly ChatAttachment[];
    readonly charactersAvailable: number;
  },
  backend: Pick<typeof Hive, "selectedHiveContext" | "materializeHiveImage" |
    "acknowledgeHiveContext" | "captureHiveEvent"> = Hive,
) {
  const query = input.query.trim();
  if (!query || query.startsWith("/") || isConversationalOnly(query) || input.charactersAvailable < 3)
    return undefined;
  const selection = yield* Effect.tryPromise(() =>
    backend.selectedHiveContext(input.file, query, input.standalone ? [] : input.projects, input.threadId),
  ).pipe(Effect.catch(() => Effect.logWarning("Selected Hive Mind recall was unavailable.").pipe(
    Effect.as(undefined),
  )));
  if (!selection?.context.trim() || selection.context.length + 2 > input.charactersAvailable)
    return undefined;
  const { connection, packet } = selection;
  if (input.standalone && packet?.project != null) return undefined;
  let context = selection.context;
  const attachments = [...input.attachments];
  const assetIds: string[] = [];
  let imageBytes = attachments.reduce((bytes, attachment) =>
    bytes + (attachment.type === "image" ? attachment.sizeBytes : 0), 0);
  if (connection && packet) {
    for (const asset of packet.assets) {
      if (attachments.length >= 100 || imageBytes + 10 * MiB > 80 * MiB) {
        const notice = "\n\nSome Hive Mind references exceeded the attachment budget. Retrieve them with hive_mind_read_reference.";
        if (context.length + notice.length + 2 <= input.charactersAvailable) context += notice;
        break;
      }
      const retained = yield* Effect.tryPromise(() =>
        backend.materializeHiveImage(connection, asset.id, input.attachmentsDir, input.threadId),
      ).pipe(Effect.catch(() => Effect.logWarning("A Hive Mind reference was unavailable.").pipe(
        Effect.as(undefined),
      )));
      if (!retained) continue;
      const hint = `\n\nRetained Hive Mind reference ${asset.id}: ${retained.path}. Inspect the actual reference when relevant.`;
      if (context.length + hint.length + 2 <= input.charactersAvailable) context += hint;
      attachments.push(retained.attachment);
      assetIds.push(asset.id);
      if (retained.attachment.type === "image") imageBytes += retained.attachment.sizeBytes;
    }
  }
  const acknowledge = Effect.fn("HiveTurnRecall.acknowledge")(function* (
    provider: string, instance: string, turn: string,
  ) {
    if (!connection || !packet) return;
    yield* Effect.tryPromise(async () => {
      await backend.acknowledgeHiveContext(input.file, connection, input.threadId, packet);
      await backend.captureHiveEvent(connection, {
        eventId: Hive.hiveEventId(input.file, input.threadId, instance, turn, "input"),
        threadId: input.threadId, provider,
        project: input.standalone ? null : (packet.project ?? input.projects[0] ?? "J1Code"),
        summary: `User request excerpt (source message remains authoritative): ${query.slice(0, 4000)}`,
        ...(packet.taskId ? { taskId: packet.taskId } : {}),
        assetIds, contextSequence: packet.sequence,
        ...(packet.streamId ? { contextStreamId: packet.streamId } : {}),
        deliveredIds: packet.usedIds,
      });
    }).pipe(Effect.catch(() => Effect.logWarning("Could not record delivered Hive Mind context.")));
  });
  const track = Effect.fn("HiveTurnRecall.track")(function* (
    provider: string, instance: string, turn: string,
  ) {
    if (!connection || !packet) return undefined;
    const workflow = new WorkflowCapture();
    const acknowledged = yield* Effect.cached(acknowledge(provider, instance, turn));
    let finished = false;
    const project = input.standalone ? null : (packet.project ?? input.projects[0] ?? "J1Code");
    return {
      presenceTarget: {
        connection, provider,
        ...(project ? { project } : {}),
        ...(packet.taskId && !input.standalone ? { taskId: packet.taskId } : {}),
      },
      acknowledged,
      append(turnId: string, itemId: string, text: string) {
        if (turnId === turn && !finished)
          workflow.append(input.threadId, instance, turn, text, itemId, true);
      },
      finish(turnId: string, status: string) {
        if (turnId !== turn || finished) return undefined;
        finished = true;
        const output = workflow.take(input.threadId, instance, turn);
        return acknowledged.pipe(Effect.andThen(Effect.tryPromise(() =>
          backend.captureHiveEvent(connection, {
            eventId: Hive.hiveEventId(input.file, input.threadId, instance, turn, "terminal"),
            threadId: input.threadId,
            provider,
            project,
            summary: workflowSummary(query, output, status, turn),
            contextSequence: packet.sequence,
            ...(packet.streamId ? { contextStreamId: packet.streamId } : {}),
            deliveredIds: packet.usedIds,
            ...(packet.taskId ? { taskId: packet.taskId } : {}),
          }),
        ).pipe(
          Effect.retry({ times: 2 }),
          Effect.catch(() => Effect.logWarning("Hive Mind could not save the turn outcome after three attempts.")),
          Effect.asVoid,
        )));
      },
    } satisfies HiveTurnCapture;
  });
  return { prefix: context + "\n\n", attachments, acknowledge, track };
});
