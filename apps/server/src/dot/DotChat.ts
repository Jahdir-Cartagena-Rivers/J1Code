import * as NodeCrypto from "node:crypto";
import {
  DotChatMessage,
  DotChatQuery,
  DotChatSendInput,
  DotChatSnapshot,
  DotChatWaitInput,
  DotIntegrationError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { DotConnections } from "./DotConnections.ts";
import { DotInvocation } from "./DotService.ts";
import { DotChatWebhook, callbackUrl, signingKey } from "./DotChatWebhook.ts";

export const DOT_CHAT_EVENT = "j1.dot.message";
export const REPLY_CHECK_DELAY_MS = 90_000;
export const MAX_REPLY_REMINDERS = 2;
export const DotChatReadInput = Schema.Struct({
  messageId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  ),
  before: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
  pendingOnly: Schema.optionalKey(Schema.Boolean),
});
export const DotChatPage = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({ ...DotChatMessage.fields, textTruncated: Schema.Boolean }),
  ),
  beforeCursor: Schema.NullOr(Schema.String),
});
export const DotEventSubscribe = Schema.Struct({
  name: Schema.Literal(DOT_CHAT_EVENT),
  arguments: Schema.Struct({ connectionId: Schema.String }),
  delivery: Schema.Struct({
    mode: Schema.Literal("webhook"),
    url: Schema.String,
    secret: Schema.String,
  }),
  ttlMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
export const DotEventUnsubscribe = Schema.Struct({
  name: Schema.Literal(DOT_CHAT_EVENT),
  arguments: Schema.Struct({ connectionId: Schema.String }),
  delivery: Schema.Struct({ mode: Schema.Literal("webhook"), url: Schema.String }),
});
export const DotReplyInput = Schema.Struct({
  messageId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40000)),
});
type Subscription = { id: string; connection_id: string; callback_url: string; expires_at: number };
const Secret = Schema.Struct({
  secret: Schema.String,
  verifiedUntil: Schema.optionalKey(Schema.Number),
  previous: Schema.optionalKey(Schema.String),
  rotateUntil: Schema.optionalKey(Schema.Number),
});
const storageError = () => new DotIntegrationError({ message: "Could not read or save Dot chat." });
const invalid = (message: string) => new DotIntegrationError({ message });
const decodeMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(DotChatMessage));
const encodeMessage = Schema.encodeEffect(Schema.fromJsonString(DotChatMessage));
const encodeSecret = Schema.encodeEffect(Schema.fromJsonString(Secret));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeSecret = Schema.decodeEffect(Schema.fromJsonString(Secret));
const decodeSend = Schema.decodeEffect(DotChatSendInput);
const decodeSubscription = Schema.decodeEffect(DotEventSubscribe);
const decodeUnsubscribe = Schema.decodeEffect(DotEventUnsubscribe);
const decodeReply = Schema.decodeEffect(DotReplyInput);
const decodeRead = Schema.decodeEffect(DotChatReadInput);
const isIntegrationError = Schema.is(DotIntegrationError);
const mapStorageError = (error: unknown) => (isIntegrationError(error) ? error : storageError());
const iso = (time: number) => DateTime.formatIso(DateTime.makeUnsafe(time));
const keyName = (id: string) => `dot-chat-webhook-${id}`;
const subscriptionId = (connectionId: string, url: string) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([connectionId, DOT_CHAT_EVENT, { connectionId }, url]))
    .digest("hex");

export class DotChat extends Context.Service<
  DotChat,
  {
    readonly snapshot: (query: DotChatQuery) => Effect.Effect<DotChatSnapshot, DotIntegrationError>;
    readonly send: (input: DotChatSendInput) => Effect.Effect<DotChatMessage, DotIntegrationError>;
    readonly wait: (
      input: typeof DotChatWaitInput.Type,
    ) => Effect.Effect<{ snapshot: DotChatSnapshot | null }, DotIntegrationError>;
    readonly notify: Effect.Effect<void, DotIntegrationError>;
    readonly read: (
      input: typeof DotChatReadInput.Type,
    ) => Effect.Effect<typeof DotChatPage.Type, DotIntegrationError, DotInvocation>;
    readonly subscribe: (
      input: typeof DotEventSubscribe.Type,
    ) => Effect.Effect<
      { id: string; refreshBefore: string; cursor: null; truncated: false },
      DotIntegrationError,
      DotInvocation
    >;
    readonly unsubscribe: (
      input: typeof DotEventUnsubscribe.Type,
    ) => Effect.Effect<void, DotIntegrationError, DotInvocation>;
    readonly reply: (
      input: typeof DotReplyInput.Type,
    ) => Effect.Effect<{ saved: true; messageId: string }, DotIntegrationError, DotInvocation>;
  }
>()("t3/dot/DotChat") {}

export const layer = Layer.effect(
  DotChat,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const uuid = crypto.randomUUIDv4.pipe(Effect.mapError(storageError));
    const connections = yield* DotConnections;
    const secrets = yield* ServerSecretStore;
    const webhook = yield* DotChatWebhook;
    const changes = yield* PubSub.unbounded<void>();
    const queue = yield* Queue.unbounded<{ messageId: string; subscriptionId: string }>();
    const lock = yield* Semaphore.make(1);
    const now = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
    const bump = sql`UPDATE dot_chat_revision SET revision = revision + 1 WHERE id = 1`.pipe(
      Effect.asVoid,
    );
    const notify = bump.pipe(
      Effect.mapError(storageError),
      Effect.andThen(PubSub.publish(changes, undefined)),
      Effect.asVoid,
    );
    const publish = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
    const readMessage = Effect.fn("DotChat.readMessage")(function* (id: string) {
      const rows = yield* sql<{
        message_json: string;
      }>`SELECT message_json FROM dot_chat_messages WHERE id = ${id}`;
      return rows[0] ? Option.some(yield* decodeMessage(rows[0].message_json)) : Option.none();
    });
    const putMessage = (message: DotChatMessage) =>
      encodeMessage(message).pipe(
        Effect.flatMap(
          (json) =>
            sql`UPDATE dot_chat_messages SET message_json = ${json} WHERE id = ${message.id}`,
        ),
      );
    const authorize = Effect.gen(function* () {
      const invocation = yield* DotInvocation;
      const connection = yield* connections.getActive(invocation.connectionId);
      if (!connection.chat || !invocation.scopes?.includes("dot:chat"))
        return yield* invalid("This Dot connection does not have native chat permission.");
      return connection;
    });
    const read = Effect.fn("DotChat.read")(function* (input: typeof DotChatReadInput.Type) {
      const connection = yield* authorize;
      const valid = yield* decodeRead(input);
      if (valid.messageId) {
        const found = yield* readMessage(valid.messageId);
        if (Option.isNone(found) || found.value.connectionId !== connection.id)
          return yield* invalid("Dot message was not found in this connection.");
        return { messages: [{ ...found.value, textTruncated: false }], beforeCursor: null };
      }
      let before = Number.MAX_SAFE_INTEGER;
      if (valid.before) {
        const cursor = yield* sql<{
          seq: number;
        }>`SELECT seq FROM dot_chat_messages WHERE id = ${valid.before} AND connection_id = ${connection.id}`;
        if (!cursor[0]) return yield* invalid("Dot history cursor was not found.");
        before = cursor[0].seq;
      }
      const rows = valid.pendingOnly
        ? yield* sql<{
            id: string;
            message_json: string;
          }>`SELECT id, message_json FROM dot_chat_messages AS m WHERE connection_id = ${connection.id} AND seq < ${before} AND json_extract(message_json, '$.role') = 'user' AND NOT EXISTS (SELECT 1 FROM dot_chat_messages AS r WHERE r.connection_id = m.connection_id AND r.reply_to = m.id) ORDER BY seq DESC LIMIT 21`
        : yield* sql<{
            id: string;
            message_json: string;
          }>`SELECT id, message_json FROM dot_chat_messages WHERE connection_id = ${connection.id} AND seq < ${before} ORDER BY seq DESC LIMIT 21`;
      const page = rows.slice(0, 20).toReversed();
      const decoded = yield* Effect.forEach(page, (row) => decodeMessage(row.message_json));
      let budget = 16000;
      return {
        messages: decoded.map((message) => {
          const text = message.text.slice(0, Math.min(4000, budget));
          budget -= text.length;
          return { ...message, text, textTruncated: text.length < message.text.length };
        }),
        beforeCursor: rows.length > 20 ? (page[0]?.id ?? null) : null,
      };
    }, Effect.mapError(mapStorageError));
    const readSecret = Effect.fn("DotChat.readSecret")(function* (id: string) {
      const bytes = yield* secrets.get(keyName(id)).pipe(Effect.mapError(storageError));
      if (Option.isNone(bytes))
        return yield* invalid("Dot callback credentials are unavailable. Reconnect your Dot.");
      return yield* decodeSecret(new TextDecoder().decode(bytes.value)).pipe(
        Effect.mapError(storageError),
      );
    });
    const expireSubscriptions = lock.withPermit(
      Effect.gen(function* () {
        const time = yield* now;
        const expired = yield* sql<{
          id: string;
        }>`SELECT id FROM dot_chat_subscriptions WHERE expires_at <= ${time}`;
        if (!expired.length) return;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            for (const sub of expired) {
              const rows = yield* sql<{
                message_json: string;
              }>`SELECT message_json FROM dot_chat_messages WHERE id IN (SELECT message_id FROM dot_chat_outbox WHERE subscription_id = ${sub.id} AND state IN ('pending', 'delivered'))`;
              for (const row of rows) {
                const message = yield* decodeMessage(row.message_json);
                if (message.status !== "answered")
                  yield* putMessage({
                    ...message,
                    status: "failed",
                    error: "Dot disconnected before delivery. Reconnect your Dot.",
                  });
              }
              yield* sql`DELETE FROM dot_chat_outbox WHERE subscription_id = ${sub.id}`;
              yield* sql`DELETE FROM dot_chat_subscriptions WHERE id = ${sub.id}`;
            }
            yield* bump;
          }),
        );
        for (const sub of expired)
          yield* secrets.remove(keyName(sub.id)).pipe(Effect.mapError(storageError));
        yield* publish;
      }),
    );
    const snapshot = Effect.fn("DotChat.snapshot")(function* (query: DotChatQuery) {
      yield* expireSubscriptions;
      const time = yield* now;
      const records = (yield* connections.list).filter((c) => c.chat === true);
      const subs =
        yield* sql<Subscription>`SELECT * FROM dot_chat_subscriptions WHERE expires_at > ${time}`;
      const entries = records.map((c) => ({
        id: c.id,
        label: c.label,
        connected:
          c.revokedAt === null &&
          Date.parse(c.expiresAt) > time &&
          subs.some((s) => s.connection_id === c.id),
      }));
      const selected =
        query.connectionId ?? entries.find((c) => c.connected)?.id ?? entries[0]?.id ?? null;
      if (selected && !entries.some((c) => c.id === selected))
        return yield* invalid("Dot chat connection was not found.");
      const revisionRows = yield* sql<{
        revision: number;
      }>`SELECT revision FROM dot_chat_revision WHERE id = 1`;
      let before = Number.MAX_SAFE_INTEGER;
      if (query.before && selected) {
        const cursor = yield* sql<{
          seq: number;
        }>`SELECT seq FROM dot_chat_messages WHERE id = ${query.before} AND connection_id = ${selected}`;
        if (!cursor[0]) return yield* invalid("Dot history cursor was not found.");
        before = cursor[0].seq;
      }
      const rows = selected
        ? yield* sql<{
            id: string;
            message_json: string;
          }>`SELECT id, message_json FROM dot_chat_messages WHERE connection_id = ${selected} AND seq < ${before} ORDER BY seq DESC LIMIT 51`
        : [];
      const page = rows.slice(0, 50).toReversed();
      return {
        revision: revisionRows[0]?.revision ?? 0,
        connectionId: selected,
        connections: entries,
        messages: yield* Effect.forEach(page, (row) => decodeMessage(row.message_json)),
        beforeCursor: rows.length > 50 ? (page[0]?.id ?? null) : null,
      };
    }, Effect.mapError(mapStorageError));

    const scheduledChecks = new Set<string>();
    const checkReply = Effect.fn("DotChat.checkReply")(function* (
      job: { messageId: string; subscriptionId: string },
      expectedCount: number,
    ) {
      const requeue = yield* lock.withPermit(
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{
              state: string;
              reminder_count: number;
            }>`SELECT state, reminder_count FROM dot_chat_outbox WHERE message_id = ${job.messageId} AND subscription_id = ${job.subscriptionId}`;
            const row = rows[0];
            if (!row || row.state !== "delivered" || row.reminder_count !== expectedCount)
              return null;
            const found = yield* readMessage(job.messageId);
            if (Option.isNone(found) || found.value.status === "answered") return null;
            const time = yield* now;
            const subs =
              yield* sql<Subscription>`SELECT * FROM dot_chat_subscriptions WHERE id = ${job.subscriptionId}`;
            const sub = subs[0];
            const active =
              sub && sub.expires_at > time
                ? yield* connections.getActive(sub.connection_id).pipe(Effect.option)
                : Option.none();
            const permitted = Option.isSome(active) && active.value.chat === true;
            if (!permitted || row.reminder_count >= MAX_REPLY_REMINDERS) {
              yield* putMessage({
                ...found.value,
                status: "failed",
                error: permitted
                  ? "Dot has not replied after automatic recovery. Your message is saved."
                  : "The Dot connection ended before a reply arrived. Your message is saved.",
              });
              yield* sql`UPDATE dot_chat_outbox SET state = 'failed', reply_due_at = NULL WHERE message_id = ${job.messageId} AND subscription_id = ${job.subscriptionId}`;
              yield* bump;
              return false;
            }
            // A reply reminder is a NEW event occurrence. Its id/time are durable;
            // HTTP retries of that reminder still use that same id and exact body.
            yield* sql`UPDATE dot_chat_outbox SET state = 'pending', attempts = 0, reminder_count = reminder_count + 1, event_created_at = ${time}, reply_due_at = NULL WHERE message_id = ${job.messageId} AND subscription_id = ${job.subscriptionId}`;
            yield* putMessage({
              ...found.value,
              error: "Waiting for Dot's reply; recovery is running automatically.",
            });
            yield* bump;
            return true;
          }),
        ),
      );
      if (requeue === null) return;
      yield* publish;
      if (requeue) yield* Queue.offer(queue, job);
    });
    const scheduleReplyCheck = Effect.fn("DotChat.scheduleReplyCheck")(function* (job: {
      messageId: string;
      subscriptionId: string;
    }) {
      const rows = yield* sql<{
        state: string;
        reminder_count: number;
        reply_due_at: number | null;
      }>`SELECT state, reminder_count, reply_due_at FROM dot_chat_outbox WHERE message_id = ${job.messageId} AND subscription_id = ${job.subscriptionId}`;
      const row = rows[0];
      if (!row || row.state !== "delivered") return;
      const message = yield* readMessage(job.messageId);
      if (Option.isNone(message) || message.value.status === "answered") return;
      const due = row.reply_due_at ?? Date.parse(message.value.createdAt) + REPLY_CHECK_DELAY_MS;
      const key = `${job.subscriptionId}:${job.messageId}:${row.reminder_count}`;
      if (scheduledChecks.has(key)) return;
      scheduledChecks.add(key);
      yield* Effect.sleep(Math.max(0, due - (yield* now))).pipe(
        Effect.andThen(checkReply(job, row.reminder_count)),
        Effect.catch(() => notify),
        Effect.ensuring(Effect.sync(() => scheduledChecks.delete(key))),
        Effect.forkScoped,
      );
    });

    // Durable outbox: a restart resumes delivery AND unanswered-reply deadlines.
    const deliver = Effect.fn("DotChat.deliver")(function* (job: {
      messageId: string;
      subscriptionId: string;
    }) {
      const attempt = Effect.gen(function* () {
        const time = yield* now;
        const deliveryRows = yield* sql<{
          attempts: number;
          state: string;
          reminder_count: number;
          event_created_at: number | null;
        }>`SELECT attempts, state, reminder_count, event_created_at FROM dot_chat_outbox WHERE message_id = ${job.messageId} AND subscription_id = ${job.subscriptionId}`;
        if (!deliveryRows[0] || deliveryRows[0].state !== "pending")
          return { accepted: false, permanent: false, skip: true };
        if (deliveryRows[0].attempts >= 4) return { accepted: false, permanent: true };
        const rows =
          yield* sql<Subscription>`SELECT * FROM dot_chat_subscriptions WHERE id = ${job.subscriptionId}`;
        const sub = rows[0];
        if (!sub || sub.expires_at <= time)
          return yield* invalid("Dot disconnected before this message was delivered.");
        const connection = yield* connections.getActive(sub.connection_id);
        if (!connection.chat) return yield* invalid("Native Dot chat permission was revoked.");
        const found = yield* readMessage(job.messageId);
        if (Option.isNone(found) || found.value.connectionId !== sub.connection_id)
          return yield* invalid("Dot message was not found.");
        if (found.value.status === "answered")
          return { accepted: false, permanent: false, skip: true };
        const row = deliveryRows[0];
        const eventId =
          row.reminder_count === 0
            ? found.value.id
            : `${found.value.id}:reply-reminder:${row.reminder_count}`;
        const secret = yield* readSecret(sub.id);
        yield* sql`UPDATE dot_chat_outbox SET attempts = attempts + 1 WHERE message_id = ${job.messageId} AND subscription_id = ${job.subscriptionId}`;
        const result = yield* webhook.post({
          url: sub.callback_url,
          secret: secret.secret,
          ...(secret.previous && (secret.rotateUntil ?? 0) > time
            ? { previousSecret: secret.previous }
            : {}),
          subscriptionId: sub.id,
          eventId,
          body: yield* encodeJson({
            eventId,
            name: DOT_CHAT_EVENT,
            timestamp:
              row.event_created_at === null ? found.value.createdAt : iso(row.event_created_at),
            data: {
              connectionId: sub.connection_id,
              messageId: found.value.id,
              text: found.value.text,
            },
            cursor: null,
          }),
        });
        if (result.status === 410 || result.status === 413)
          return { accepted: false, permanent: true };
        if (result.status < 200 || result.status >= 300)
          return yield* invalid("ChatGPT did not accept this message.");
        return { accepted: true, permanent: false };
      }).pipe(Effect.mapError(storageError));
      const result = yield* attempt.pipe(
        Effect.retry(Schedule.max([Schedule.exponential("1 second"), Schedule.recurs(3)])),
        Effect.catch(() => Effect.succeed({ accepted: false, permanent: false })),
      );
      if ("skip" in result && result.skip) return;
      yield* lock
        .withPermit(
          sql.withTransaction(
            Effect.gen(function* () {
              const outstanding = yield* sql<{
                state: string;
              }>`SELECT state FROM dot_chat_outbox WHERE message_id = ${job.messageId} AND subscription_id = ${job.subscriptionId}`;
              // Unsubscribe/expiry can remove the job while the callback is in flight.
              if (outstanding[0]?.state !== "pending") return;
              const found = yield* readMessage(job.messageId);
              if (Option.isNone(found)) return;
              // A fast Dot reply can land before the HTTP acknowledgement. Never undo answered.
              if (found.value.status !== "answered")
                yield* putMessage({
                  ...found.value,
                  status: result.accepted ? "delivered" : "failed",
                  error: result.accepted
                    ? found.value.error
                    : result.permanent
                      ? "ChatGPT rejected this message. Reconnect your Dot."
                      : "Delivery failed. Check the Dot connection before sending another message.",
                });
              const time = yield* now;
              yield* sql`UPDATE dot_chat_outbox SET state = ${result.accepted ? "delivered" : "failed"}, reply_due_at = ${result.accepted ? time + REPLY_CHECK_DELAY_MS : null} WHERE message_id = ${job.messageId} AND subscription_id = ${job.subscriptionId}`;
              yield* bump;
            }),
          ),
        )
        .pipe(Effect.mapError(storageError));
      yield* publish;
      if (result.accepted) yield* scheduleReplyCheck(job);
    });
    yield* Effect.forever(
      Queue.take(queue).pipe(
        Effect.flatMap(deliver),
        Effect.catch(() => notify),
      ),
    ).pipe(Effect.forkScoped);
    const pending = yield* sql<{
      message_id: string;
      subscription_id: string;
    }>`SELECT message_id, subscription_id FROM dot_chat_outbox WHERE state = 'pending'`;
    yield* Effect.forEach(pending, (row) =>
      Queue.offer(queue, { messageId: row.message_id, subscriptionId: row.subscription_id }),
    );
    const awaiting = yield* sql<{
      message_id: string;
      subscription_id: string;
    }>`SELECT message_id, subscription_id FROM dot_chat_outbox WHERE state = 'delivered'`;
    yield* Effect.forEach(awaiting, (row) =>
      scheduleReplyCheck({ messageId: row.message_id, subscriptionId: row.subscription_id }),
    );

    return DotChat.of({
      snapshot,
      notify,
      read,
      wait: (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            // Subscribe before reading the revision so a commit cannot be lost between the two.
            const subscription = yield* PubSub.subscribe(changes);
            const current = yield* snapshot(input);
            if (current.revision !== input.revision) return { snapshot: current };
            const receipt = yield* PubSub.take(subscription).pipe(
              Effect.timeoutOption("25 seconds"),
            );
            return { snapshot: Option.isSome(receipt) ? yield* snapshot(input) : null };
          }),
        ),
      send: (input) =>
        lock
          .withPermit(
            Effect.gen(function* () {
              const valid = yield* decodeSend(input).pipe(
                Effect.mapError(() => invalid("Enter a message of at most 40,000 characters.")),
              );
              const previous = yield* sql<{
                message_json: string;
              }>`SELECT message_json FROM dot_chat_messages WHERE connection_id = ${valid.connectionId} AND request_id = ${valid.requestId}`;
              if (previous[0]) {
                const message = yield* decodeMessage(previous[0].message_json);
                if (message.text !== valid.text)
                  return yield* invalid("This send request already belongs to another message.");
                return message;
              }
              const connection = yield* connections.getActive(valid.connectionId);
              if (!connection.chat)
                return yield* invalid("Native Dot chat permission is not enabled.");
              const time = yield* now;
              const subs =
                yield* sql<Subscription>`SELECT * FROM dot_chat_subscriptions WHERE connection_id = ${connection.id} AND expires_at > ${time}`;
              const sub = subs[0];
              if (!sub) return yield* invalid("Connect your actual Dot before sending a message.");
              const message: DotChatMessage = {
                id: yield* uuid,
                connectionId: connection.id,
                role: "user",
                text: valid.text,
                createdAt: iso(time),
                replyTo: null,
                status: "queued",
                error: null,
              };
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  const json = yield* encodeMessage(message);
                  yield* sql`INSERT INTO dot_chat_messages (id, connection_id, request_id, reply_to, message_json) VALUES (${message.id}, ${connection.id}, ${valid.requestId}, NULL, ${json})`;
                  yield* sql`INSERT INTO dot_chat_outbox (message_id, subscription_id, state) VALUES (${message.id}, ${sub.id}, 'pending')`;
                  yield* bump;
                }),
              );
              yield* publish;
              yield* Queue.offer(queue, { messageId: message.id, subscriptionId: sub.id });
              return message;
            }),
          )
          .pipe(Effect.mapError(mapStorageError)),
      subscribe: (input) =>
        Effect.gen(function* () {
          const connection = yield* authorize;
          const valid = yield* decodeSubscription(input).pipe(
            Effect.mapError(() => invalid("Invalid native Dot subscription.")),
          );
          if (valid.arguments.connectionId !== connection.id)
            return yield* invalid("You may subscribe only to this Dot connection.");
          yield* Effect.try({
            try: () => {
              callbackUrl(valid.delivery.url);
              signingKey(valid.delivery.secret);
            },
            catch: () => invalid("Invalid ChatGPT callback or signing key."),
          });
          const id = subscriptionId(connection.id, valid.delivery.url);
          const time = yield* now;
          const current =
            yield* sql<Subscription>`SELECT * FROM dot_chat_subscriptions WHERE connection_id = ${connection.id} AND expires_at > ${time}`;
          if (current.some((s) => s.id !== id))
            return yield* invalid(
              "This connection is already paired with a Dot. Disconnect it before pairing another.",
            );
          const requested = valid.ttlMs ?? 30 * 86400000;
          if (!Number.isFinite(requested) || requested <= 0)
            return yield* invalid("Subscription lifetime must be positive.");
          const expiresAt = Math.min(
            time + Math.min(requested, 30 * 86400000),
            Date.parse(connection.expiresAt),
          );
          const credentials = yield* secrets.get(keyName(id)).pipe(Effect.mapError(storageError));
          const cached = Option.isSome(credentials)
            ? yield* decodeSecret(new TextDecoder().decode(credentials.value)).pipe(
                Effect.mapError(storageError),
              )
            : null;
          const cachedVerification =
            cached?.secret === valid.delivery.secret && (cached.verifiedUntil ?? 0) > time;
          if (!cachedVerification) {
            const challenge = yield* crypto.randomBytes(32).pipe(
              Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
              Effect.mapError(storageError),
            );
            const result = yield* webhook.post({
              url: valid.delivery.url,
              secret: valid.delivery.secret,
              subscriptionId: id,
              eventId: yield* uuid,
              body: yield* encodeJson({ type: "verification", challenge }),
            });
            const expected = Buffer.from(challenge);
            const echoed = Buffer.from(result.challenge ?? "");
            if (
              result.status < 200 ||
              result.status >= 300 ||
              expected.length !== echoed.length ||
              !NodeCrypto.timingSafeEqual(expected, echoed)
            )
              return yield* invalid("ChatGPT callback verification failed.");
          }
          yield* lock.withPermit(
            Effect.gen(function* () {
              yield* authorize; // Permission may have changed while the callback was being verified.
              const others =
                yield* sql<Subscription>`SELECT * FROM dot_chat_subscriptions WHERE connection_id = ${connection.id} AND expires_at > ${time}`;
              if (others.some((s) => s.id !== id))
                return yield* invalid(
                  "This connection was paired with another Dot while verification was pending.",
                );
              const previous = yield* secrets.get(keyName(id)).pipe(Effect.mapError(storageError));
              const old = Option.isSome(previous)
                ? yield* decodeSecret(new TextDecoder().decode(previous.value)).pipe(
                    Effect.mapError(storageError),
                  )
                : null;
              const next = {
                secret: valid.delivery.secret,
                verifiedUntil: cachedVerification ? (cached?.verifiedUntil ?? time) : time + 120000,
                ...(old && old.secret !== valid.delivery.secret
                  ? { previous: old.secret, rotateUntil: time + 60000 }
                  : {}),
              };
              yield* secrets
                .set(keyName(id), new TextEncoder().encode(yield* encodeSecret(next)))
                .pipe(Effect.mapError(storageError));
              yield* sql`INSERT INTO dot_chat_subscriptions (id, connection_id, callback_url, expires_at) VALUES (${id}, ${connection.id}, ${valid.delivery.url}, ${expiresAt}) ON CONFLICT(id) DO UPDATE SET expires_at = excluded.expires_at`;
              yield* notify;
            }),
          );
          return { id, refreshBefore: iso(expiresAt), cursor: null, truncated: false as const };
        }).pipe(Effect.mapError(mapStorageError)),
      unsubscribe: (input) =>
        lock
          .withPermit(
            Effect.gen(function* () {
              const connection = yield* authorize;
              const valid = yield* decodeUnsubscribe(input).pipe(
                Effect.mapError(() => invalid("Invalid native Dot subscription.")),
              );
              if (valid.arguments.connectionId !== connection.id)
                return yield* invalid("This subscription belongs to another connection.");
              const id = subscriptionId(connection.id, valid.delivery.url);
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  const pending = yield* sql<{
                    message_json: string;
                  }>`SELECT message_json FROM dot_chat_messages WHERE id IN (SELECT message_id FROM dot_chat_outbox WHERE subscription_id = ${id} AND state IN ('pending', 'delivered'))`;
                  for (const row of pending) {
                    const message = yield* decodeMessage(row.message_json);
                    if (message.status !== "answered")
                      yield* putMessage({
                        ...message,
                        status: "failed",
                        error: "Dot disconnected before delivery. Reconnect your Dot.",
                      });
                  }
                  yield* sql`DELETE FROM dot_chat_outbox WHERE subscription_id = ${id}`;
                  yield* sql`DELETE FROM dot_chat_subscriptions WHERE id = ${id} AND connection_id = ${connection.id}`;
                  yield* bump;
                }),
              );
              yield* secrets.remove(keyName(id)).pipe(Effect.mapError(storageError));
              yield* publish;
            }),
          )
          .pipe(Effect.mapError(mapStorageError)),
      reply: (input) =>
        lock
          .withPermit(
            Effect.gen(function* () {
              const connection = yield* authorize;
              const valid = yield* decodeReply(input).pipe(
                Effect.mapError(() => invalid("Invalid Dot reply.")),
              );
              const found = yield* readMessage(valid.messageId);
              if (
                Option.isNone(found) ||
                found.value.connectionId !== connection.id ||
                found.value.role !== "user"
              )
                return yield* invalid(
                  "You may reply only to a message sent through this Dot connection.",
                );
              const existing = yield* sql<{
                message_json: string;
              }>`SELECT message_json FROM dot_chat_messages WHERE connection_id = ${connection.id} AND reply_to = ${valid.messageId}`;
              if (existing[0]) {
                // Concurrent event runs may phrase their answers differently.
                // The first reply wins; later runs acknowledge it without duplicates.
                return { saved: true as const, messageId: found.value.id };
              }
              const message: DotChatMessage = {
                id: yield* uuid,
                connectionId: connection.id,
                role: "dot",
                text: valid.text,
                createdAt: iso(yield* now),
                replyTo: valid.messageId,
                status: "answered",
                error: null,
              };
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  const json = yield* encodeMessage(message);
                  yield* sql`INSERT INTO dot_chat_messages (id, connection_id, request_id, reply_to, message_json) VALUES (${message.id}, ${connection.id}, NULL, ${valid.messageId}, ${json})`;
                  yield* putMessage({ ...found.value, status: "answered", error: null });
                  yield* bump;
                }),
              );
              yield* publish;
              return { saved: true as const, messageId: found.value.id };
            }),
          )
          .pipe(Effect.mapError(mapStorageError)),
    });
  }),
);
