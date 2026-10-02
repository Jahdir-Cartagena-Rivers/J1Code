import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { DotConnections, layer as connectionsLayer } from "./DotConnections.ts";
import { DotInvocation } from "./DotService.ts";
import { DotChat, layer as chatLayer, DOT_CHAT_EVENT, DotEventSubscribe } from "./DotChat.ts";
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
              .pipe(Effect.provideService(DotInvocation, invoke(a.connection.id)), Effect.flip),
          ).toMatchObject({ _tag: "DotIntegrationError" });
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
