// Host-only access to the original store. Bot callers retain list_threads visibility and generation fences.
import { z } from "zod";
import * as NodeCrypto from "node:crypto";
import { searchMessagesAsync } from "../message-db.ts";
import type { Store, BotRecord, TaskRecord } from "../store.ts";
import { approvalModeFor } from "../../shared/approval-mode.ts";
import { allowsTool } from "../../shared/tool-scope.ts";
import { routeDelivery, unrestrictedRouteProfile } from "./route-receiver.ts";

const historyAction = z.object({ action: z.enum(["search", "read", "readMessage"]) });
const historyNames = {
  search: "search_conversations",
  read: "read_conversation",
  readMessage: "read_conversation_message",
};
export function historyToolAllowed(scope: unknown, call: unknown) {
  const parsed = historyAction.safeParse(call);
  return (
    parsed.success &&
    allowsTool(scope, { kind: "mcp", server: "agents", name: historyNames[parsed.data.action] })
  );
}

const principal = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("j1"), environmentId: z.string(), threadId: z.string() }).strict(),
  z
    .object({
      kind: z.literal("mausbot"),
      environmentId: z.string(),
      botId: z.string(),
      threadId: z.string(),
      generation: z.string(),
    })
    .strict(),
]);
export type HistoryPrincipal = z.infer<typeof principal>;
const endpoint = z
  .object({ environmentId: z.string(), projectId: z.string(), threadId: z.string() })
  .strict();
const query = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("routeDeliveryStatus"),
      key: z
        .object({
          requestId: z.string(),
          fingerprint: z.string(),
          attemptId: z.string(),
          destination: endpoint,
        })
        .strict(),
    })
    .strict(),
  z.object({ action: z.literal("routeDeliver"), delivery: routeDelivery }).strict(),
  z
    .object({
      action: z.literal("routeNotice"),
      endpoint,
      requestId: z.string().regex(/^[a-f0-9]{64}$/),
      revision: z.number().int().nonnegative(),
      status: z.string().max(40),
      summary: z.string().max(200),
    })
    .strict(),
  z.object({ action: z.literal("routingSource"), endpoint }).strict(),
  z.object({ action: z.literal("inspect"), endpoint }).strict(),
  z.object({ action: z.literal("search"), principal, query: z.string().max(200) }).strict(),
  z
    .object({
      action: z.literal("read"),
      principal,
      endpoint,
      cursor: z.string().max(2048).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("readMessage"),
      principal,
      endpoint,
      messageId: z.string(),
      offset: z.number().int().nonnegative(),
    })
    .strict(),
]);
type Row = { botId: string; threadId: string; title: string };
type Deps = {
  store: Pick<
    Store,
    | "bot"
    | "tasks"
    | "taskByThread"
    | "projectBotForTask"
    | "activePath"
    | "messagesFor"
    | "patchMessage"
    | "insertMessageAfter"
  >;
  rows(principal: HistoryPrincipal | null): Row[];
  active(principal: HistoryPrincipal): boolean;
  generation(threadId: string): string | undefined;
  waiting(threadId: string): boolean;
  routingTarget?(
    value: z.infer<typeof endpoint>,
  ): { allowed: boolean; blocked: boolean; generation: string | null; canSteer: boolean } | null;
  deliver?(input: z.infer<typeof routeDelivery>): Promise<string>;
};

export function createConversationQueries(deps: Deps) {
  const failure = () => new Error("Conversation is unavailable to this caller.");
  const check = (who: HistoryPrincipal) => {
    if (!deps.active(who)) throw failure();
  };
  const resolve = (value: z.infer<typeof endpoint>, who: HistoryPrincipal | null) => {
    const match = /^mausbot:([\w-]{1,120}):([\w-]{1,120})$/.exec(value.threadId);
    if (
      !match ||
      value.projectId !== `mausbot:${match[1]}` ||
      (who && value.environmentId !== who.environmentId)
    )
      throw failure();
    if (who) check(who);
    const row = deps.rows(who).find((row) => row.botId === match[1] && row.threadId === match[2]);
    const bot = row && deps.store.projectBotForTask(row.botId, row.threadId);
    const task = row && deps.store.taskByThread(row.botId, row.threadId);
    if (!row || !bot || !task) throw failure();
    return { row, bot, task };
  };
  const metadata = (env: string, row: Row, bot: BotRecord, task: TaskRecord) => {
    const mode = approvalModeFor(bot);
    const waiting = deps.waiting(row.threadId);
    return {
      endpoint: {
        environmentId: env,
        projectId: `mausbot:${bot.id}`,
        threadId: `mausbot:${bot.id}:${row.threadId}`,
      },
      title: `${bot.name} / ${row.title}`,
      url: `/assistants?environmentId=${encodeURIComponent(env)}&botId=${encodeURIComponent(bot.id)}&conversation=${encodeURIComponent(row.threadId)}`,
      runtimeMode:
        mode === "full"
          ? "full-access"
          : mode === "edits"
            ? "auto-accept-edits"
            : mode === "auto"
              ? "auto"
              : "approval-required",
      providerInstanceId: bot.modelSelection.instanceId,
      // A native generation is not a provider turn id or proof that steering was applied.
      activeTurnId: null,
      ...(deps.generation(row.threadId) ? { generation: deps.generation(row.threadId) } : {}),
      approvalPending: waiting || task.activity === "waiting-on-you",
      inputPending: waiting || task.activity === "waiting-on-you",
    };
  };
  const messages = (threadId: string) =>
    deps.store
      .activePath(threadId)
      .filter(
        (message) => message.kind === "text" && (message.role === "user" || message.role === "bot"),
      )
      .map((message) => ({
        id: message.id,
        role: message.role === "user" ? ("user" as const) : ("assistant" as const),
        text: message.text ?? "",
      }));
  return async (input: unknown) => {
    const request = query.parse(input);
    if (request.action === "routeDeliveryStatus") {
      const { row } = resolve(request.key.destination, null);
      const proof = deps.store
        .messagesFor(row.threadId)
        .find(
          (message) => message.j1IncomingRoute?.requestId === request.key.requestId,
        )?.j1IncomingRoute;
      return proof?.state === "applied" &&
        proof.fingerprint === request.key.fingerprint &&
        proof.attemptId === request.key.attemptId &&
        proof.environmentId === request.key.destination.environmentId &&
        proof.generation &&
        proof.providerTurnId
        ? { generation: proof.generation, providerTurnId: proof.providerTurnId }
        : null;
    }
    if (request.action === "routeDeliver") {
      resolve(request.delivery.destination, null);
      if (!deps.deliver) throw failure();
      return deps.deliver(request.delivery);
    }
    if (request.action === "routeNotice") {
      const { row } = resolve(request.endpoint, null);
      const existing = deps.store
        .messagesFor(row.threadId)
        .find((message) => message.j1RouteId === request.requestId);
      if (existing && (existing.j1RouteRevision ?? 0) >= request.revision) return true;
      const text = `Routing request: ${request.status}. ${request.summary}`;
      if (existing)
        deps.store.patchMessage(row.threadId, existing.id, {
          kind: "options",
          text,
          tool: { name: text, ok: true },
          j1RouteRevision: request.revision,
        });
      else {
        const anchor = deps.store
          .activePath(row.threadId)
          .findLast(
            (message) =>
              (message.role === "user" && message.kind === "text") ||
              message.j1IncomingRoute !== undefined,
          );
        deps.store.insertMessageAfter(row.threadId, anchor?.id, {
          role: "bot",
          kind: "options",
          text,
          tool: { name: text, ok: true },
          j1RouteId: request.requestId,
          j1RouteRevision: request.revision,
        });
      }
      return true;
    }
    if (request.action === "routingSource") {
      try {
        const { row, bot, task } = resolve(request.endpoint, null);
        const target = deps.routingTarget?.(request.endpoint);
        return {
          endpoint: request.endpoint,
          url: metadata(request.endpoint.environmentId, row, bot, task).url,
          runtimeMode: metadata(request.endpoint.environmentId, row, bot, task).runtimeMode,
          providerKey: bot.modelSelection.instanceId,
          permissionsKnown: unrestrictedRouteProfile(bot),
          archived: task.archivedAt !== undefined || bot.hidden === true,
          activeGeneration: target?.generation ?? null,
          canSteer: target?.canSteer ?? false,
          blocked: target?.blocked ?? true,
        };
      } catch {
        return null;
      }
    }
    if (request.action === "inspect") {
      try {
        const { row, bot, task } = resolve(request.endpoint, null);
        return task.archivedAt !== undefined || bot.hidden
          ? null
          : metadata(request.endpoint.environmentId, row, bot, task);
      } catch {
        return null;
      }
    }
    const who = request.principal;
    check(who);
    if (request.action === "search") {
      const text = request.query.trim();
      const hits = text.length >= 2 ? await searchMessagesAsync(text, 500) : [];
      check(who);
      // Re-resolve visibility after the worker await; revocation is not a lease on old results.
      const result = [];
      for (const row of deps.rows(who)) {
        const bot = deps.store.projectBotForTask(row.botId, row.threadId);
        const task = deps.store.taskByThread(row.botId, row.threadId);
        if (!bot || !task || task.archivedAt !== undefined || bot.hidden) continue;
        const threadHits = hits.filter((hit) => hit.threadId === row.threadId);
        const active = threadHits.length
          ? new Set(messages(row.threadId).map((message) => message.id))
          : undefined;
        const hit = threadHits.find((hit) => active?.has(hit.messageId));
        if (
          !hit &&
          !`${bot.name} ${row.title}`.toLocaleLowerCase().includes(text.toLocaleLowerCase())
        )
          continue;
        result.push({
          ...metadata(who.environmentId, row, bot, task),
          ...(hit ? { match: { source: "message", snippet: hit.snippet } } : {}),
        });
        if (result.length === 50) break;
      }
      return result;
    }
    const { row, bot, task } = resolve(request.endpoint, who);
    const path = messages(row.threadId);
    if (request.action === "readMessage") {
      const message = path.find((message) => message.id === request.messageId);
      if (!message || request.offset > message.text.length) throw failure();
      const text = message.text.slice(request.offset, request.offset + 8_000);
      return {
        ...message,
        text,
        offset: request.offset,
        nextOffset:
          request.offset + text.length < message.text.length ? request.offset + text.length : null,
      };
    }
    let end = path.length;
    if (request.cursor) {
      const cursor = z
        .object({ botId: z.string(), threadId: z.string(), before: z.string() })
        .strict()
        .parse(JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")));
      if (cursor.botId !== bot.id || cursor.threadId !== row.threadId) throw failure();
      end = path.findIndex((message) => message.id === cursor.before);
      if (end < 0) throw failure();
    }
    const page = path.slice(Math.max(0, end - 30), end);
    let budget = 16_000;
    let textTruncated = false;
    const bounded = page.map((message) => {
      const text = message.text.slice(0, budget);
      budget -= text.length;
      if (text.length < message.text.length) textTruncated = true;
      return { ...message, text };
    });
    return {
      conversation: metadata(who.environmentId, row, bot, task),
      messages: bounded,
      textTruncated,
      nextCursor:
        end > page.length && page[0]
          ? Buffer.from(
              JSON.stringify({ botId: bot.id, threadId: row.threadId, before: page[0].id }),
            ).toString("base64url")
          : null,
    };
  };
}

/** Only the owning J1 process can submit queries; there is no HTTP owner-token equivalent. */
export function installConversationQueries(run: ReturnType<typeof createConversationQueries>) {
  const pending = new Set<string>();
  process.on("message", (message: unknown) => {
    const parsed = z
      .object({
        type: z.literal("j1:conversation-query"),
        requestId: z.string().uuid(),
        input: z.unknown(),
      })
      .strict()
      .safeParse(message);
    if (!parsed.success || !process.connected) return;
    const { requestId, input } = parsed.data;
    if (pending.size >= 8 || pending.has(requestId)) {
      process.send?.({
        type: "j1:conversation-result",
        requestId,
        error: "Too many conversation reads are open.",
      });
      return;
    }
    pending.add(requestId);
    void run(input)
      .then(
        (value) => {
          if (process.connected)
            process.send?.({ type: "j1:conversation-result", requestId, value });
        },
        () => {
          if (process.connected)
            process.send?.({
              type: "j1:conversation-result",
              requestId,
              error: "Conversation is unavailable to this caller.",
            });
        },
      )
      .finally(() => pending.delete(requestId));
  });
}

const hostCalls = new Map<
  string,
  {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
export function requestHostConversation(input: unknown): Promise<unknown> {
  if (!process.connected || !process.send || hostCalls.size >= 8)
    return Promise.reject(new Error("The J1 conversation host is unavailable."));
  const requestId = NodeCrypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      hostCalls.delete(requestId);
      if (process.connected) process.send?.({ type: "j1:conversation-host-cancel", requestId });
      reject(new Error("The J1 conversation request timed out."));
    }, 10_000);
    hostCalls.set(requestId, { resolve, reject, timer });
    process.send!({ type: "j1:conversation-host-request", requestId, input }, (error) => {
      if (!error) return;
      clearTimeout(timer);
      hostCalls.delete(requestId);
      reject(new Error("The J1 conversation host disconnected."));
    });
  });
}
process.on("message", (message: unknown) => {
  const parsed = z
    .object({
      type: z.literal("j1:conversation-host-result"),
      requestId: z.string(),
      value: z.unknown().optional(),
      error: z.string().optional(),
    })
    .strict()
    .safeParse(message);
  if (!parsed.success) return;
  const call = hostCalls.get(parsed.data.requestId);
  if (!call) return;
  clearTimeout(call.timer);
  hostCalls.delete(parsed.data.requestId);
  if (parsed.data.error) call.reject(new Error(parsed.data.error));
  else call.resolve(parsed.data.value);
});
