import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { DotConnections, layer as connectionsLayer } from "./DotConnections.ts";
import { DotInvocation } from "./DotService.ts";
import {
  DotChat,
  layer as chatLayer,
  DOT_CHAT_EVENT,
  DotEventSubscribe,
  REPLY_CHECK_DELAY_MS,
} from "./DotChat.ts";
import { DotChatWebhook } from "./DotChatWebhook.ts";

const infrastructure = Layer.mergeAll(
  SqlitePersistenceMemory,
  ServerConfig.layerTest(process.cwd(), { prefix: "j1-native-dot-test-" }),
  Layer.mock(ProjectionSnapshotQuery)({ getProjectShellById: () => Effect.succeed(Option.none()) }),
).pipe(Layer.provideMerge(NodeServices.layer));
const base = Layer.mergeAll(connectionsLayer, ServerSecretStore.layer).pipe(
  Layer.provideMerge(infrastructure),
);
const secret = `whsec_${Buffer.alloc(32, 42).toString("base64")}`;
const decodeEventId = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ eventId: Schema.String })),
);
const subscription = (id: string, suffix = "1"): typeof DotEventSubscribe.Type => ({
  name: DOT_CHAT_EVENT,
  arguments: { connectionId: id },
  delivery: {
    mode: "webhook" as const,
    url: `https://connectors.api.openai.com/native-dot-test/${suffix}`,
    secret,
  },
});
const invoke = (id: string, scopes = ["dot:chat"] as const) => ({ connectionId: id, scopes });
const create = Effect.fn("nativeDot.test.create")(function* (chat = true) {
  return yield* (yield* DotConnections).create({
    label: "My real Dot",
    chat,
    grants: [],
    ...(chat ? {} : { hiveMind: { read: true, write: false } }),
    expiresInDays: 30,
  });
});

const test = <E>(run: Effect.Effect<void, E, DotChat | DotConnections | SqlClient.SqlClient>) =>
  run.pipe(
    Effect.provide(
      chatLayer.pipe(
        Layer.provideMerge(
          Layer.succeed(DotChatWebhook, {
            post: (input) =>
              Effect.succeed({ status: 200, challenge: JSON.parse(input.body).challenge ?? null }),
          }),
        ),
        Layer.provideMerge(base),
      ),
    ),
  );

describe("durable native Dot chat", () => {
  it.effect(
    "resumes an overdue reply check after restart and keeps reminder ids stable across HTTP retries",
    () =>
      Effect.gen(function* () {
        const requests = yield* Queue.unbounded<string>();
        const a = yield* create();
        let reminderAttempts = 0;
        const transport = Layer.succeed(DotChatWebhook, {
          post: (input) => {
            const body = JSON.parse(input.body);
            if (body.type === "verification")
              return Effect.succeed({ status: 200, challenge: String(body.challenge) });
            const reminder = String(body.eventId).includes(":reply-reminder:");
            const status = reminder && reminderAttempts++ === 0 ? 503 : 200;
            return Queue.offer(requests, input.body).pipe(Effect.as({ status, challenge: null }));
          },
        });
        const first = yield* Effect.gen(function* () {
          const chat = yield* DotChat;
          yield* chat
            .subscribe(subscription(a.connection.id))
            .pipe(Effect.provideService(DotInvocation, invoke(a.connection.id)));
          const before = yield* chat.snapshot({});
          const message = yield* chat.send({
            connectionId: a.connection.id,
            requestId: "overdue",
            text: "Hello",
          });
          yield* Queue.take(requests);
          yield* chat.wait({ revision: before.revision + 1 });
          return message;
        }).pipe(Effect.provide(Layer.fresh(chatLayer).pipe(Layer.provide(transport))));
        yield* TestClock.adjust(REPLY_CHECK_DELAY_MS);
        yield* Effect.gen(function* () {
          const chat = yield* DotChat;
          const firstAttempt = yield* Queue.take(requests);
          expect((yield* decodeEventId(firstAttempt)).eventId).toBe(`${first.id}:reply-reminder:1`);
          yield* TestClock.adjust("1 second");
          const secondAttempt = yield* Queue.take(requests);
          expect(secondAttempt).toBe(firstAttempt);
          yield* chat
            .reply({ messageId: first.id, text: "Hello J" })
            .pipe(Effect.provideService(DotInvocation, invoke(a.connection.id)));
          yield* TestClock.adjust(REPLY_CHECK_DELAY_MS * 4);
          expect(yield* Queue.size(requests)).toBe(0);
          expect((yield* chat.snapshot({})).messages).toHaveLength(2);
        }).pipe(Effect.provide(Layer.fresh(chatLayer).pipe(Layer.provide(transport))));
      }).pipe(Effect.provide(base)),
  );
  it.effect("reads only the authorized native history and paginates unanswered messages", () =>
    test(
      Effect.gen(function* () {
        const chat = yield* DotChat;
        const a = yield* create();
        const b = yield* create();
        yield* chat
          .subscribe(subscription(a.connection.id))
          .pipe(Effect.provideService(DotInvocation, invoke(a.connection.id)));
        yield* chat
          .subscribe(subscription(b.connection.id))
          .pipe(Effect.provideService(DotInvocation, invoke(b.connection.id)));
        yield* chat.send({
          connectionId: b.connection.id,
          requestId: "private",
          text: "Other account private message",
        });
        const sent = yield* Effect.forEach(
          Array.from({ length: 21 }, (_, n) => n),
          (n) =>
            chat.send({
              connectionId: a.connection.id,
              requestId: `page-${n}`,
              text: `Message ${n}`,
            }),
        );
        const page = yield* chat
          .read({ pendingOnly: true })
          .pipe(Effect.provideService(DotInvocation, invoke(a.connection.id)));
        expect(page.messages).toHaveLength(20);
        expect(page.messages.every((m) => m.connectionId === a.connection.id)).toBe(true);
        expect(page.beforeCursor).not.toBeNull();
        const older = yield* chat
          .read({ pendingOnly: true, before: page.beforeCursor! })
          .pipe(Effect.provideService(DotInvocation, invoke(a.connection.id)));
        expect(older.messages.map((m) => m.id)).toEqual([sent[0]!.id]);
        yield* chat
          .reply({ messageId: sent[20]!.id, text: "Answered" })
          .pipe(Effect.provideService(DotInvocation, invoke(a.connection.id)));
        const pending = yield* chat
          .read({ pendingOnly: true })
          .pipe(Effect.provideService(DotInvocation, invoke(a.connection.id)));
        expect(pending.messages.some((m) => m.id === sent[20]!.id)).toBe(false);
        expect(
          yield* chat
            .read({})
            .pipe(
              Effect.provideService(DotInvocation, { connectionId: a.connection.id, scopes: [] }),
              Effect.flip,
            ),
        ).toMatchObject({ _tag: "DotIntegrationError" });
        expect(
          yield* chat
            .read({ before: older.messages[0]!.id })
            .pipe(Effect.provideService(DotInvocation, invoke(b.connection.id)), Effect.flip),
        ).toMatchObject({ _tag: "DotIntegrationError" });
        expect(
          yield* chat
            .read({ messageId: sent[0]!.id })
            .pipe(Effect.provideService(DotInvocation, invoke(b.connection.id)), Effect.flip),
        ).toMatchObject({ _tag: "DotIntegrationError" });
        const long = yield* chat.send({
          connectionId: a.connection.id,
          requestId: "long-text",
          text: "x".repeat(40000),
        });
        const bounded = yield* chat
          .read({})
          .pipe(Effect.provideService(DotInvocation, invoke(a.connection.id)));
        expect(bounded.messages.reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(16000);
        expect(bounded.messages.find((m) => m.id === long.id)).toMatchObject({
          textTruncated: true,
        });
        const full = yield* chat
          .read({ messageId: long.id })
          .pipe(Effect.provideService(DotInvocation, invoke(a.connection.id)));
        expect(full.messages[0]).toMatchObject({ text: long.text, textTruncated: false });
        yield* (yield* DotConnections).revoke(a.connection.id);
        expect(
          yield* chat
            .read({})
            .pipe(Effect.provideService(DotInvocation, invoke(a.connection.id)), Effect.flip),
        ).toMatchObject({ _tag: "DotIntegrationError" });
      }),
    ),
  );

  it.effect(
    "recovers omitted replies with bounded distinct reminders and accepts a late answer",
    () =>
      Effect.gen(function* () {
        const requests = yield* Queue.unbounded<{
          eventId: string;
          timestamp: string;
          data: { messageId: string; text: string };
        }>();
        yield* Effect.gen(function* () {
          const chat = yield* DotChat;
          const a = yield* create();
          yield* chat
            .subscribe(subscription(a.connection.id))
            .pipe(Effect.provideService(DotInvocation, invoke(a.connection.id)));
          const initial = yield* chat.snapshot({});
          const sent = yield* chat.send({
            connectionId: a.connection.id,
            requestId: "recover-omission",
            text: "Hello Dot",
          });
          const first = yield* Queue.take(requests);
          expect(first.eventId).toBe(sent.id);
          yield* chat.wait({ revision: initial.revision + 1 });
          for (let n = 1; n <= 2; n++) {
            yield* TestClock.adjust(REPLY_CHECK_DELAY_MS);
            const reminder = yield* Queue.take(requests);
            expect(reminder.eventId).toBe(`${sent.id}:reply-reminder:${n}`);
            expect(reminder.data).toEqual(first.data);
            expect(reminder.timestamp).not.toBe(first.timestamp);
          }
          yield* TestClock.adjust(REPLY_CHECK_DELAY_MS);
          const failed = yield* chat.snapshot({});
          expect(failed.messages[0]).toMatchObject({
            id: sent.id,
            status: "failed",
            error: expect.stringContaining("not replied"),
          });
          expect(yield* Queue.size(requests)).toBe(0);
          yield* chat
            .reply({ messageId: sent.id, text: "Hi J" })
            .pipe(Effect.provideService(DotInvocation, invoke(a.connection.id)));
          expect(
            (yield* chat
              .read({ pendingOnly: true })
              .pipe(Effect.provideService(DotInvocation, invoke(a.connection.id)))).messages,
          ).toEqual([]);
          expect((yield* chat.snapshot({})).messages.map((m) => m.status)).toEqual([
            "answered",
            "answered",
          ]);
        }).pipe(
          Effect.provide(
            chatLayer.pipe(
              Layer.provide(
                Layer.succeed(DotChatWebhook, {
                  post: (input) => {
                    const body = JSON.parse(input.body);
                    return body.type === "verification"
                      ? Effect.succeed({ status: 200, challenge: String(body.challenge) })
                      : Queue.offer(requests, body).pipe(
                          Effect.as({ status: 200, challenge: null }),
                        );
                  },
                }),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(base)),
  );

  it.effect("cancels reply reminders on answer, disconnect, and revoke", () =>
    test(
      Effect.gen(function* () {
        const chat = yield* DotChat;
        const connections = yield* DotConnections;
        const messages = [];
        for (let n = 0; n < 3; n++) {
          const a = yield* create();
          yield* chat
            .subscribe(subscription(a.connection.id))
            .pipe(Effect.provideService(DotInvocation, invoke(a.connection.id)));
          const before = yield* chat.snapshot({ connectionId: a.connection.id });
          const sent = yield* chat.send({
            connectionId: a.connection.id,
            requestId: `cancel-${n}`,
            text: "Hello",
          });
          yield* chat.wait({ connectionId: a.connection.id, revision: before.revision + 1 });
          messages.push({ id: sent.id, connectionId: a.connection.id });
          if (n === 0)
            yield* chat
              .reply({ messageId: sent.id, text: "Hey" })
              .pipe(Effect.provideService(DotInvocation, invoke(a.connection.id)));
          if (n === 1)
            yield* chat
              .unsubscribe(subscription(a.connection.id))
              .pipe(Effect.provideService(DotInvocation, invoke(a.connection.id)));
          if (n === 2) yield* connections.revoke(a.connection.id);
        }
        yield* TestClock.adjust(REPLY_CHECK_DELAY_MS * 4);
        for (let n = 0; n < messages.length; n++) {
          const m = messages[n]!;
          const snap = yield* chat.snapshot({ connectionId: m.connectionId });
          expect(snap.messages.find((x) => x.id === m.id)?.status).toBe(
            n === 0 ? "answered" : "failed",
          );
        }
        const sql = yield* SqlClient.SqlClient;
        expect(
          (yield* sql<{
            reminder_count: number;
          }>`SELECT reminder_count FROM dot_chat_outbox`).every((r) => r.reminder_count === 0),
        ).toBe(true);
      }),
    ),
  );
  it.effect("needs separate chat permission and a verified subscription", () =>
    test(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-02T12:00:00Z"));
        const chat = yield* DotChat;
        const old = yield* create(false);
        const prepared = yield* create();
        expect(
          yield* chat
            .subscribe(subscription(old.connection.id))
            .pipe(Effect.provideService(DotInvocation, invoke(old.connection.id)), Effect.flip),
        ).toMatchObject({ _tag: "DotIntegrationError" });
        expect(
          yield* chat.subscribe(subscription(prepared.connection.id)).pipe(
            Effect.provideService(DotInvocation, {
              connectionId: prepared.connection.id,
              scopes: [],
            }),
            Effect.flip,
          ),
        ).toMatchObject({ _tag: "DotIntegrationError" });
        expect(
          yield* chat
            .send({
              connectionId: prepared.connection.id,
              requestId: "not-connected",
              text: "hello",
            })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "DotIntegrationError" });
        const sub = yield* chat
          .subscribe(subscription(prepared.connection.id))
          .pipe(Effect.provideService(DotInvocation, invoke(prepared.connection.id)));
        const refreshed = yield* chat
          .subscribe(subscription(prepared.connection.id))
          .pipe(Effect.provideService(DotInvocation, invoke(prepared.connection.id)));
        expect(refreshed.id).toBe(sub.id);
        expect((yield* chat.snapshot({})).connections).toEqual([
          { id: prepared.connection.id, label: "My real Dot", connected: true },
        ]);
        expect(
          yield* chat
            .subscribe(subscription(prepared.connection.id, "another-dot"))
            .pipe(
              Effect.provideService(DotInvocation, invoke(prepared.connection.id)),
              Effect.flip,
            ),
        ).toMatchObject({ _tag: "DotIntegrationError" });
      }),
    ),
  );

  it.effect(
    "saves correlated idempotent replies, rejects other connections, and retains native history",
    () =>
      test(
        Effect.gen(function* () {
          const chat = yield* DotChat;
          const a = yield* create();
          const b = yield* create();
          yield* chat
            .subscribe(subscription(a.connection.id))
            .pipe(Effect.provideService(DotInvocation, invoke(a.connection.id)));
          const sent = yield* chat.send({
            connectionId: a.connection.id,
            requestId: "send-1",
            text: "hello actual Dot",
          });
          const retry = yield* chat.send({
            connectionId: a.connection.id,
            requestId: "send-1",
            text: "hello actual Dot",
          });
          expect(retry.id).toBe(sent.id);
          expect(
            yield* chat
              .send({ connectionId: a.connection.id, requestId: "send-1", text: "different" })
              .pipe(Effect.flip),
          ).toMatchObject({ _tag: "DotIntegrationError" });
          expect(
            yield* chat
              .reply({ messageId: sent.id, text: "not my message" })
              .pipe(Effect.provideService(DotInvocation, invoke(b.connection.id)), Effect.flip),
          ).toMatchObject({ _tag: "DotIntegrationError" });
          const reply = { messageId: sent.id, text: "hello J" };
          yield* chat
            .reply(reply)
            .pipe(Effect.provideService(DotInvocation, invoke(a.connection.id)));
          yield* chat
            .reply(reply)
            .pipe(Effect.provideService(DotInvocation, invoke(a.connection.id)));
          expect(
            yield* chat
              .reply({ ...reply, text: "different reply" })
              .pipe(Effect.provideService(DotInvocation, invoke(a.connection.id))),
          ).toEqual({ saved: true, messageId: sent.id });
          const snap = yield* chat.snapshot({ connectionId: a.connection.id });
          expect(snap.messages.map((m) => [m.role, m.text, m.status])).toEqual([
            ["user", "hello actual Dot", "answered"],
            ["dot", "hello J", "answered"],
          ]);
          const input = subscription(a.connection.id);
          yield* chat
            .unsubscribe(input)
            .pipe(Effect.provideService(DotInvocation, invoke(a.connection.id)));
          yield* chat
            .unsubscribe(input)
            .pipe(Effect.provideService(DotInvocation, invoke(a.connection.id)));
          expect(
            (yield* chat.snapshot({ connectionId: a.connection.id })).connections.find(
              (c) => c.id === a.connection.id,
            )?.connected,
          ).toBe(false);
          expect((yield* chat.snapshot({ connectionId: a.connection.id })).messages).toHaveLength(
            2,
          );
        }),
      ),
  );

  it.effect("does not activate failed callback verification or a revoked connection", () =>
    Effect.gen(function* () {
      const connection = yield* create();
      const chat = yield* DotChat;
      expect(
        yield* chat
          .subscribe(subscription(connection.connection.id))
          .pipe(
            Effect.provideService(DotInvocation, invoke(connection.connection.id)),
            Effect.flip,
          ),
      ).toMatchObject({ _tag: "DotIntegrationError" });
      expect((yield* chat.snapshot({})).connections[0]?.connected).toBe(false);
      yield* (yield* DotConnections).revoke(connection.connection.id);
      expect(
        yield* chat
          .send({ connectionId: connection.connection.id, requestId: "revoked", text: "hello" })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "DotIntegrationError" });
    }).pipe(
      Effect.provide(
        chatLayer.pipe(
          Layer.provideMerge(
            Layer.succeed(DotChatWebhook, {
              post: () => Effect.succeed({ status: 200, challenge: "wrong" }),
            }),
          ),
          Layer.provideMerge(base),
        ),
      ),
    ),
  );

  it.effect("does not overwrite a fast reply when the webhook acknowledgement lands later", () =>
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<string>();
      const ack = yield* Deferred.make<{ status: number; challenge: string | null }>();
      yield* Effect.gen(function* () {
        const connection = yield* create();
        const chat = yield* DotChat;
        yield* chat
          .subscribe(subscription(connection.connection.id))
          .pipe(Effect.provideService(DotInvocation, invoke(connection.connection.id)));
        const sent = yield* chat.send({
          connectionId: connection.connection.id,
          requestId: "fast-reply",
          text: "hello",
        });
        expect(yield* Queue.take(requests)).toBe(sent.id);
        yield* chat
          .reply({ messageId: sent.id, text: "already answered" })
          .pipe(Effect.provideService(DotInvocation, invoke(connection.connection.id)));
        const snap = yield* chat.snapshot({ connectionId: connection.connection.id });
        yield* Deferred.succeed(ack, { status: 200, challenge: null });
        const next = yield* chat.wait({
          connectionId: connection.connection.id,
          revision: snap.revision,
        });
        expect(next.snapshot?.messages[0]?.status).toBe("answered");
        expect(next.snapshot?.messages).toHaveLength(2);
      }).pipe(
        Effect.provide(
          chatLayer.pipe(
            Layer.provide(
              Layer.succeed(DotChatWebhook, {
                post: (input) => {
                  const body = JSON.parse(input.body);
                  return body.type === "verification"
                    ? Effect.succeed({ status: 200, challenge: String(body.challenge) })
                    : Queue.offer(requests, String(body.eventId)).pipe(
                        Effect.andThen(Deferred.await(ack)),
                      );
                },
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(base)),
  );

  it.effect("does not undo a disconnect when an in-flight callback accepts the message", () =>
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<string>();
      const ack = yield* Deferred.make<{ status: number; challenge: string | null }>();
      yield* Effect.gen(function* () {
        const connection = yield* create();
        const chat = yield* DotChat;
        const sub = subscription(connection.connection.id);
        yield* chat
          .subscribe(sub)
          .pipe(Effect.provideService(DotInvocation, invoke(connection.connection.id)));
        const sent = yield* chat.send({
          connectionId: connection.connection.id,
          requestId: "disconnect-in-flight",
          text: "hello",
        });
        expect(yield* Queue.take(requests)).toBe(sent.id);
        yield* chat
          .unsubscribe(sub)
          .pipe(Effect.provideService(DotInvocation, invoke(connection.connection.id)));
        const nextConnection = yield* create();
        yield* chat
          .subscribe(subscription(nextConnection.connection.id))
          .pipe(Effect.provideService(DotInvocation, invoke(nextConnection.connection.id)));
        const nextMessage = yield* chat.send({
          connectionId: nextConnection.connection.id,
          requestId: "queue-drain",
          text: "next message",
        });
        yield* Deferred.succeed(ack, { status: 200, challenge: null });
        // The next transport receipt proves the preceding callback finished processing.
        expect(yield* Queue.take(requests)).toBe(nextMessage.id);
        const snapshot = yield* chat.snapshot({ connectionId: connection.connection.id });
        expect(snapshot.messages[0]).toMatchObject({ status: "failed" });
        expect(snapshot.connections.find((c) => c.id === connection.connection.id)?.connected).toBe(
          false,
        );
      }).pipe(
        Effect.provide(
          chatLayer.pipe(
            Layer.provide(
              Layer.succeed(DotChatWebhook, {
                post: (input) => {
                  const body = JSON.parse(input.body);
                  return body.type === "verification"
                    ? Effect.succeed({ status: 200, challenge: String(body.challenge) })
                    : Queue.offer(requests, String(body.eventId)).pipe(
                        Effect.andThen(Deferred.await(ack)),
                      );
                },
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(base)),
  );

  it.effect(
    "resumes a pending outbox message after the chat service restarts with the same event id",
    () =>
      Effect.gen(function* () {
        const requests = yield* Queue.unbounded<string>();
        const connection = yield* create();
        const first = yield* Effect.gen(function* () {
          const chat = yield* DotChat;
          yield* chat
            .subscribe(subscription(connection.connection.id))
            .pipe(Effect.provideService(DotInvocation, invoke(connection.connection.id)));
          const message = yield* chat.send({
            connectionId: connection.connection.id,
            requestId: "restart",
            text: "keep my message",
          });
          expect(yield* Queue.take(requests)).toBe(message.id);
          return { message, revision: (yield* chat.snapshot({})).revision };
        }).pipe(
          Effect.provide(
            Layer.fresh(chatLayer).pipe(
              Layer.provide(
                Layer.succeed(DotChatWebhook, {
                  post: (input) => {
                    const body = JSON.parse(input.body);
                    return body.type === "verification"
                      ? Effect.succeed({ status: 200, challenge: String(body.challenge) })
                      : Queue.offer(requests, String(body.eventId)).pipe(
                          Effect.andThen(Effect.never),
                        );
                  },
                }),
              ),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const chat = yield* DotChat;
          expect(yield* Queue.take(requests)).toBe(first.message.id);
          const resumed = yield* chat.wait({
            connectionId: connection.connection.id,
            revision: first.revision,
          });
          expect(resumed.snapshot?.messages).toHaveLength(1);
          expect(resumed.snapshot?.messages[0]).toMatchObject({
            id: first.message.id,
            text: "keep my message",
            status: "delivered",
          });
          expect(
            (yield* chat.send({
              connectionId: connection.connection.id,
              requestId: "restart",
              text: "keep my message",
            })).id,
          ).toBe(first.message.id);
        }).pipe(
          Effect.provide(
            Layer.fresh(chatLayer).pipe(
              Layer.provide(
                Layer.succeed(DotChatWebhook, {
                  post: (input) =>
                    Queue.offer(requests, String(JSON.parse(input.body).eventId)).pipe(
                      Effect.as({ status: 200, challenge: null }),
                    ),
                }),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(base)),
  );

  it.effect("honours subscription expiry without dropping saved history", () =>
    test(
      Effect.gen(function* () {
        const connection = yield* create();
        const chat = yield* DotChat;
        const sub = yield* chat
          .subscribe({ ...subscription(connection.connection.id), ttlMs: 1000 })
          .pipe(Effect.provideService(DotInvocation, invoke(connection.connection.id)));
        expect(Date.parse(sub.refreshBefore)).toBe((yield* Clock.currentTimeMillis) + 1000);
        yield* TestClock.adjust("1 second");
        expect((yield* chat.snapshot({})).connections[0]?.connected).toBe(false);
        expect(
          yield* chat
            .send({
              connectionId: connection.connection.id,
              requestId: "expired",
              text: "no delivery",
            })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "DotIntegrationError" });
      }),
    ),
  );

  it.effect("marks pending messages undelivered when unsubscribed or revoked", () =>
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<string>();
      const acks = yield* Queue.unbounded<void>();
      yield* Effect.gen(function* () {
        const chat = yield* DotChat;
        for (const revoke of [false, true]) {
          const connection = yield* create();
          const sub = subscription(connection.connection.id);
          yield* chat
            .subscribe(sub)
            .pipe(Effect.provideService(DotInvocation, invoke(connection.connection.id)));
          const sent = yield* chat.send({
            connectionId: connection.connection.id,
            requestId: "disconnect",
            text: "hello",
          });
          expect(yield* Queue.take(requests)).toBe(sent.id);
          if (revoke) yield* (yield* DotConnections).revoke(connection.connection.id);
          else
            yield* chat
              .unsubscribe({
                name: sub.name,
                arguments: sub.arguments,
                delivery: { mode: "webhook", url: sub.delivery.url },
              })
              .pipe(Effect.provideService(DotInvocation, invoke(connection.connection.id)));
          const snapshot = yield* chat.snapshot({ connectionId: connection.connection.id });
          expect(snapshot.messages[0]?.status).toBe("failed");
          expect(
            snapshot.connections.find((c) => c.id === connection.connection.id)?.connected,
          ).toBe(false);
          // Release the in-flight callback so the queue can accept the next connection.
          yield* Queue.offer(acks, undefined);
        }
      }).pipe(
        Effect.provide(
          chatLayer.pipe(
            Layer.provide(
              Layer.succeed(DotChatWebhook, {
                post: (input) => {
                  const body = JSON.parse(input.body);
                  return body.type === "verification"
                    ? Effect.succeed({ status: 200, challenge: String(body.challenge) })
                    : Queue.offer(requests, String(body.eventId)).pipe(
                        Effect.andThen(Queue.take(acks)),
                        Effect.as({ status: 410, challenge: null }),
                      );
                },
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(base)),
  );
});
