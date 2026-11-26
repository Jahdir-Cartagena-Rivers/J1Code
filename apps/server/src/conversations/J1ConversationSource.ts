import { MessageId, ThreadId, type ConversationPrincipal, type OrchestrationV2ThreadShell } from "@j1code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import type { ThreadSearch } from "../orchestration-v2/ThreadSearch.ts";
import type { RouteEndpoint } from "../routing/routeState.ts";
import type { ExternalConversation, ExternalConversationSource } from "./ExternalConversations.ts";

const PAGE_SIZE = 40;
const unavailable = "Conversation is unavailable.";
const cursorScope = (endpoint: RouteEndpoint) =>
  ["j1-v2", endpoint.environmentId, endpoint.projectId, endpoint.threadId] as const;

function encodeCursor(endpoint: RouteEndpoint, position: number): string {
  return Buffer.from(JSON.stringify([...cursorScope(endpoint), position])).toString("base64url");
}

function decodeCursor(endpoint: RouteEndpoint, cursor: string): number {
  if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error(unavailable);
  const payload: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Array.isArray(payload)) throw new Error(unavailable);
  const position: unknown = payload[4];
  if (typeof position !== "number" || !Number.isSafeInteger(position) || position <= 0 ||
      encodeCursor(endpoint, position) !== cursor) throw new Error(unavailable);
  return position;
}

const nativeId = /^[A-Za-z0-9_-]{1,120}$/;
const active = (thread: OrchestrationV2ThreadShell) =>
  thread.archivedAt === null && thread.deletedAt === null;

export function makeJ1ConversationSource(
  environmentId: string,
  threads: Pick<ThreadManagementService["Service"],
    "getThreadShell" | "getShellSnapshot" | "getTimelinePage" | "getMessagesById">,
  search: Pick<ThreadSearch["Service"], "search">,
): ExternalConversationSource {
  const accepts = (id: string) => !id.startsWith("mausbot:");
  const metadata = (thread: OrchestrationV2ThreadShell): ExternalConversation => {
    const [namespace, botId, conversation, extra] = thread.id.split(":");
    const request = thread.pendingRuntimeRequest;
    return {
      endpoint: { environmentId, projectId: thread.projectId, threadId: thread.id },
      title: thread.title,
      url: namespace === "j1-mausbot" && extra === undefined &&
        botId && nativeId.test(botId) && conversation && nativeId.test(conversation)
        ? `/assistants?environmentId=${encodeURIComponent(environmentId)}&botId=${encodeURIComponent(botId)}&conversation=${encodeURIComponent(conversation)}`
        : `/${encodeURIComponent(environmentId)}/${encodeURIComponent(thread.id)}`,
      runtimeMode: thread.runtimeMode,
      providerInstanceId: thread.modelSelection.instanceId,
      activeTurnId: thread.activeRunId,
      approvalPending: request !== null && request.kind !== "user_input" &&
        request.kind !== "dynamic_tool_call" && request.kind !== "auth_refresh",
      inputPending: request?.kind === "user_input",
    };
  };
  const getOwnedThread = Effect.fn("J1ConversationSource.getOwnedThread")(function* (endpoint: RouteEndpoint) {
    if (endpoint.environmentId !== environmentId || !accepts(endpoint.threadId)) return null;
    const shell = yield* threads.getThreadShell(ThreadId.make(endpoint.threadId));
    return shell !== null && shell.id === endpoint.threadId &&
      shell.projectId === endpoint.projectId && shell.deletedAt === null ? shell : null;
  });

  return {
    kind: "j1",
    accepts,
    inspect: (endpoint) => getOwnedThread(endpoint).pipe(
      Effect.map((shell) => shell !== null && active(shell) ? metadata(shell) : null),
      Effect.mapError(() => unavailable),
    ),
    search: Effect.fn("J1ConversationSource.search")(function* (principal: ConversationPrincipal, query: string) {
        const text = query.trim();
        if (principal.environmentId !== environmentId || text.length > 200)
          return yield* Effect.fail(unavailable);
        const snapshot = yield* threads.getShellSnapshot({ location: "active" });
        const eligible = snapshot.threads.filter(
          (thread) => active(thread) && accepts(thread.id) && !thread.id.startsWith("j1-mausbot:"),
        );
        const folded = text.toLocaleLowerCase();
        const titles = eligible
          .filter((thread) => thread.title.toLocaleLowerCase().includes(folded))
          .sort((a, b) => DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt))
          .slice(0, 50);
        const found = new Map(titles.map((thread) => [thread.id, metadata(thread)]));
        if (text.length >= 2) {
          const { matches } = yield* search.search({ query: text, limit: 50 });
          const byId = new Map(eligible.map((thread) => [thread.id, thread]));
          for (const match of matches) {
            const thread = byId.get(match.threadId);
            if (thread && thread.projectId === match.projectId)
              found.set(thread.id, {
                ...metadata(thread),
                match: { source: match.source, snippet: match.snippet },
              });
          }
        }
        return [...found.values()].slice(0, 50);
      }, Effect.mapError(() => unavailable)),
    read: Effect.fn("J1ConversationSource.read")(function* (
      principal: ConversationPrincipal, endpoint: RouteEndpoint, cursor?: string,
    ) {
        if (principal.environmentId !== environmentId || endpoint.environmentId !== environmentId)
          return yield* Effect.fail(unavailable);
        const beforePosition = cursor === undefined
          ? Number.POSITIVE_INFINITY
          : yield* Effect.try({ try: () => decodeCursor(endpoint, cursor), catch: () => unavailable });
        const before = yield* getOwnedThread(endpoint);
        if (before === null) return yield* Effect.fail(unavailable);
        const threadId = ThreadId.make(endpoint.threadId);
        const page = yield* threads.getTimelinePage(threadId, {
          beforePosition, view: "messages", limit: PAGE_SIZE,
        });
        const ids = new Set<MessageId>();
        for (const row of page.items) {
          if (row.sourceThreadId === threadId && row.visibility === "local" &&
              (row.item.type === "user_message" || row.item.type === "assistant_message") &&
              row.item.messageId != null) ids.add(row.item.messageId);
        }
        const canonical = yield* threads.getMessagesById(threadId, [...ids]);
        const shell = yield* getOwnedThread(endpoint);
        if (shell === null || (shell.archivedAt === null) !== (before.archivedAt === null))
          return yield* Effect.fail(unavailable);
        let remaining = 16_000;
        let textTruncated = false;
        const messages = [...ids].flatMap((id) => {
          const message = canonical.get(id);
          if (message?.id !== id || message.threadId !== threadId ||
              (message.role !== "user" && message.role !== "assistant")) return [];
          const text = message.text.slice(0, remaining);
          textTruncated ||= text.length < message.text.length;
          remaining -= text.length;
          return [{ id, role: message.role, text }];
        });
        const first = page.items[0]?.position ?? 0;
        return {
          conversation: metadata(shell),
          messages,
          nextCursor: page.hasEarlier && first > 0 && first < beforePosition
            ? encodeCursor(endpoint, first) : null,
          textTruncated,
        };
      }, Effect.mapError(() => unavailable)),
    readMessage: Effect.fn("J1ConversationSource.readMessage")(function* (
      principal: ConversationPrincipal, endpoint: RouteEndpoint, messageId: string, offset: number,
    ) {
        if (principal.environmentId !== environmentId ||
            !Number.isSafeInteger(offset) || offset < 0)
          return yield* Effect.fail(unavailable);
        const before = yield* getOwnedThread(endpoint);
        if (before === null) return yield* Effect.fail(unavailable);
        const threadId = ThreadId.make(endpoint.threadId);
        const id = MessageId.make(messageId);
        const row = (yield* threads.getMessagesById(threadId, [id])).get(id);
        if (row?.id !== id || row.threadId !== threadId || offset > row.text.length ||
            (row.role !== "user" && row.role !== "assistant"))
          return yield* Effect.fail(unavailable);
        const shell = yield* getOwnedThread(endpoint);
        if (shell === null || (shell.archivedAt === null) !== (before.archivedAt === null))
          return yield* Effect.fail(unavailable);
        const text = row.text.slice(offset, offset + 8_000);
        return {
          id, role: row.role, text, offset,
          nextOffset: offset + text.length < row.text.length ? offset + text.length : null,
        };
      }, Effect.mapError(() => unavailable)),
  };
}
