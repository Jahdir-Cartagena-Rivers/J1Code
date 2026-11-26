import {
  CommandId,
  MessageId,
  type ChatAttachment,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2StoredEvent,
  type ThreadId,
} from "@j1code/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import type { MausbotNativeProofError } from "./MausbotNativeProofError.ts";
import type { SavedNativeBotEnrollment } from "../mausbot/NativeBotEnrollment.ts";

export type MausbotHistoryImportCommand = Extract<
  OrchestrationV2InternalCommand, { type: "thread.bot.history.import" }
>;

export const MAUSBOT_HISTORY_COMMAND_PREFIX = "command:maus-history:";
export const mausbotHistoryCommandId = (threadId: ThreadId) =>
  CommandId.make(MAUSBOT_HISTORY_COMMAND_PREFIX + threadId);

export const mausbotHistoryMessageId = (threadId: ThreadId, nativeMessageId: string) =>
  MessageId.make(mausbotHistoryCommandId(threadId) + ":message:" + nativeMessageId);

export const MausbotHistoryImport = Context.Reference<{
  readonly command: MausbotHistoryImportCommand;
  readonly botId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly anchorMessageId: string;
  readonly promptText: string;
  readonly promptAttachments: ReadonlyArray<ChatAttachment>;
  readonly current: () => boolean;
  readonly read: Effect.Effect<SavedNativeBotEnrollment | null, MausbotNativeProofError>;
} | undefined>("@j1code/server/orchestration-v2/MausbotHistoryImport", {
  defaultValue: () => undefined,
});

export function matchesMausbotHistoryRows(
  command: MausbotHistoryImportCommand,
  rows: ReadonlyArray<{
    readonly nativeMessageId: string;
    readonly createdAt: string;
    readonly completedAt: string | null;
    readonly role: string;
    readonly text: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
  }>,
): boolean {
  return rows.length === command.messages.length && command.messages.every((row, index) => {
    const saved = rows[index];
    return saved?.nativeMessageId === row.nativeMessageId &&
      saved.createdAt === row.createdAt && saved.completedAt === row.completedAt &&
      saved.role === row.role && saved.text === row.text &&
      JSON.stringify(saved.attachments) === JSON.stringify(row.attachments);
  });
}

export function matchesMausbotHistoryReceipt(
  command: MausbotHistoryImportCommand,
  events: ReadonlyArray<OrchestrationV2StoredEvent>,
): boolean {
  const messages = events.flatMap(({ event }) => event.type === "message.updated" ? [event.payload] : []);
  const items = events.flatMap(({ event }) => event.type === "turn-item.updated" ? [event.payload] : []);
  return messages.length === command.messages.length && items.length === messages.length &&
    command.messages.every((row, index) => {
      const saved = messages[index];
      const item = items[index];
      return saved?.threadId === command.threadId &&
        saved.id === mausbotHistoryMessageId(command.threadId, row.nativeMessageId) &&
        saved.role === row.role && saved.text === row.text &&
        DateTime.formatIso(saved.createdAt) === row.createdAt &&
        DateTime.formatIso(saved.updatedAt) === (row.completedAt ?? row.createdAt) &&
        item?.threadId === command.threadId && item.ordinal === index + 1 &&
        (item.type === "user_message" || item.type === "assistant_message") &&
        item.type === (row.role === "user" ? "user_message" : "assistant_message") &&
        item.messageId === saved.id &&
        item.text === row.text &&
        (item.completedAt === null ? null : DateTime.formatIso(item.completedAt)) === row.completedAt &&
        JSON.stringify(saved.attachments) === JSON.stringify(row.attachments) &&
        JSON.stringify(item.attachments) === JSON.stringify(row.attachments);
    });
}
