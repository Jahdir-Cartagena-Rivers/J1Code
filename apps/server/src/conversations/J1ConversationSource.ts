import { MessageId, ThreadId, type OrchestrationThreadShell } from "@t3tools/contracts";
import { Effect, Option } from "effect";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionThreadMessageRepositoryShape } from "../persistence/Services/ProjectionThreadMessages.ts";
import type { ExternalConversation, ExternalConversationSource } from "./ExternalConversations.ts";
import { decodeThreadDetailPageCursor } from "../orchestration/threadDetailCursor.ts";

/** Read the existing projection, including its opaque history cursor and consistent snapshot. */
export function makeJ1ConversationSource(
  environmentId: string,
  snapshots: ProjectionSnapshotQueryShape,
  messageRepository: ProjectionThreadMessageRepositoryShape,
): ExternalConversationSource {
  const failure = () => "Conversation is unavailable.";
  const metadata = (thread: OrchestrationThreadShell): ExternalConversation => ({
    endpoint: { environmentId, projectId: thread.projectId, threadId: thread.id },
    title: thread.title,
    url: `/${encodeURIComponent(environmentId)}/${encodeURIComponent(thread.id)}`,
    runtimeMode: thread.runtimeMode,
    providerInstanceId: thread.modelSelection.instanceId,
    activeTurnId: thread.session?.activeTurnId ?? null,
    approvalPending: thread.hasPendingApprovals,
    inputPending: thread.hasPendingUserInput,
  });
  return {
    kind: "j1",
    accepts: (id) => !id.startsWith("mausbot:"),
    inspect: (endpoint) =>
      Effect.gen(function* () {
        if (endpoint.environmentId !== environmentId) return null;
        const thread = yield* snapshots.getThreadShellById(ThreadId.make(endpoint.threadId));
        return Option.isSome(thread) &&
          thread.value.projectId === endpoint.projectId &&
          thread.value.archivedAt === null
          ? metadata(thread.value)
          : null;
      }).pipe(Effect.mapError(failure)),
    search: (principal, query) =>
      Effect.gen(function* () {
        if (principal.environmentId !== environmentId) return yield* Effect.fail(failure());
        const snapshot = yield* snapshots.getShellSnapshot();
        const text = query.trim();
        if (text.length > 200) return yield* Effect.fail(failure());
        const active = snapshot.threads.filter((thread) => thread.archivedAt === null);
        const titles = active
          .filter((thread) => thread.title.toLocaleLowerCase().includes(text.toLocaleLowerCase()))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 50)
          .map(metadata);
        if (text.length >= 2) {
          const result = yield* snapshots.searchThreads({ query: text, limit: 50 });
          const byId = new Map(active.map((thread) => [thread.id, thread]));
          const found = new Map(titles.map((thread) => [thread.endpoint.threadId, thread]));
          for (const match of result.matches) {
            const thread = byId.get(match.threadId);
            if (thread && thread.projectId === match.projectId)
              found.set(thread.id, {
                ...metadata(thread),
                match: { source: match.source, snippet: match.snippet },
              });
          }
          return [...found.values()].slice(0, 50);
        }
        return titles;
      }).pipe(Effect.mapError(failure)),
    read: (principal, endpoint, cursor) =>
      Effect.gen(function* () {
        if (principal.environmentId !== environmentId || endpoint.environmentId !== environmentId)
          return yield* Effect.fail(failure());
        if (
          cursor &&
          (cursor.length > 2048 ||
            decodeThreadDetailPageCursor(cursor)?.threadId !== endpoint.threadId)
        )
          return yield* Effect.fail(failure());
        const shell = yield* snapshots.getThreadShellById(ThreadId.make(endpoint.threadId));
        if (Option.isNone(shell) || shell.value.projectId !== endpoint.projectId)
          return yield* Effect.fail(failure());
        const result = yield* snapshots.getThreadDetailSnapshot(ThreadId.make(endpoint.threadId), {
          turnLimit: 3,
          ...(cursor ? { beforeCursor: cursor } : {}),
        });
        if (Option.isNone(result) || result.value.thread.projectId !== endpoint.projectId)
          return yield* Effect.fail(failure());
        let remaining = 16_000;
        let textTruncated = false;
        const messages = result.value.thread.messages.flatMap((message) => {
          if (message.role !== "user" && message.role !== "assistant") return [];
          if (remaining <= 0) {
            textTruncated = true;
            return [{ id: message.id, role: message.role, text: "" }];
          }
          const text = message.text.slice(0, remaining);
          if (text.length < message.text.length) textTruncated = true;
          remaining -= text.length;
          return [{ id: message.id, role: message.role, text }];
        });
        return {
          conversation: metadata(shell.value),
          messages,
          nextCursor: result.value.page?.beforeCursor ?? null,
          textTruncated,
        };
      }).pipe(Effect.mapError(failure)),
    readMessage: (principal, endpoint, messageId, offset) =>
      Effect.gen(function* () {
        if (
          principal.environmentId !== environmentId ||
          endpoint.environmentId !== environmentId ||
          !Number.isSafeInteger(offset) ||
          offset < 0
        )
          return yield* Effect.fail(failure());
        const shell = yield* snapshots.getThreadShellById(ThreadId.make(endpoint.threadId));
        if (Option.isNone(shell) || shell.value.projectId !== endpoint.projectId)
          return yield* Effect.fail(failure());
        const row = yield* messageRepository.getByMessageId({
          messageId: MessageId.make(messageId),
        });
        if (
          Option.isNone(row) ||
          row.value.threadId !== endpoint.threadId ||
          offset > row.value.text.length ||
          (row.value.role !== "user" && row.value.role !== "assistant")
        )
          return yield* Effect.fail(failure());
        const text = row.value.text.slice(offset, offset + 8_000);
        return {
          id: messageId,
          role: row.value.role,
          text,
          offset,
          nextOffset: offset + text.length < row.value.text.length ? offset + text.length : null,
        };
      }).pipe(Effect.mapError(failure)),
  };
}
