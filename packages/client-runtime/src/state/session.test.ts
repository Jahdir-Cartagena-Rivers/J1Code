import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type AuthSessionState } from "@j1code/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcHttp from "../rpc/http.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createEnvironmentSessionAtoms, sessionDeniesScope } from "./session.ts";
import { BotId, EventId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@j1code/contracts";
import { applyThreadDetailEvent } from "./threadReducer.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: "https://environment.example.test",
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: { _tag: "Bearer", token: "bearer-token" },
  target: TARGET,
};
const SESSION = {
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "t3_session",
  },
  scopes: ["orchestration:read"],
} satisfies AuthSessionState;

const rpcSession = (): RpcSession => ({ closed: Effect.never }) as unknown as RpcSession;

const makeHarness = Effect.fn("TestSessionState.makeHarness")(function* (
  reply: (requestNumber: number) => Promise<Response>,
) {
  let requestCount = 0;
  const transport = yield* SubscriptionRef.make(Option.some(rpcSession()));
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: transport,
    prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _environmentId,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(
        EnvironmentRegistry.EnvironmentRegistry,
        EnvironmentRegistry.EnvironmentRegistry.of({
          followStream,
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      ),
      RpcHttp.layerRemoteHttpClient(async () => reply(++requestCount)),
      // The test's clock, so the retry wait moves with `TestClock.adjust`.
      Layer.succeed(Clock.Clock, yield* Clock.Clock),
    ),
  );
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  const results = yield* Queue.unbounded<AsyncResult.AsyncResult<AuthSessionState, unknown>>();
  const atom = createEnvironmentSessionAtoms(runtime).sessionStateAtom(TARGET.environmentId);
  const unsubscribe = registry.subscribe(atom, (result) => Queue.offerUnsafe(results, result), {
    immediate: true,
  });
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  const nextSettled = Effect.fn("TestSessionState.nextSettled")(function* () {
    for (;;) {
      const result = yield* Queue.take(results);
      if (!result.waiting && result._tag !== "Initial") return result;
    }
  });
  return { transport, nextSettled };
});

const unreachable = () => Promise.reject(new TypeError("Network request failed"));

describe("environment session state", () => {
  it.effect("fetches permissions again when the connection is re-established", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness((requestNumber) =>
        requestNumber === 1 ? unreachable() : Promise.resolve(Response.json(SESSION)),
      );
      expect((yield* harness.nextSettled())._tag).toBe("Failure");

      yield* SubscriptionRef.set(harness.transport, Option.some(rpcSession()));

      expect(yield* harness.nextSettled()).toMatchObject({ _tag: "Success", value: SESSION });
    }),
  );

  it.effect("retries a failed permission check with backoff that restarts per connection", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness((requestNumber) =>
        requestNumber <= 3 ? unreachable() : Promise.resolve(Response.json(SESSION)),
      );
      expect((yield* harness.nextSettled())._tag).toBe("Failure");

      yield* TestClock.adjust("2 seconds");
      expect((yield* harness.nextSettled())._tag).toBe("Failure");

      yield* SubscriptionRef.set(harness.transport, Option.some(rpcSession()));
      expect((yield* harness.nextSettled())._tag).toBe("Failure");

      yield* TestClock.adjust("2 seconds");
      expect(yield* harness.nextSettled()).toMatchObject({ _tag: "Success", value: SESSION });
    }),
  );

  // "Cannot control" must reflect the host's answer, not a lookup still pending or lost on the network.
  it.effect("denies a scope only once the host has answered without it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness((requestNumber) => {
        if (requestNumber === 1) return Promise.resolve(Response.json(SESSION));
        if (requestNumber === 2) return unreachable();
        return Promise.resolve(new Response(null, { status: 401 }));
      });
      expect(sessionDeniesScope(AsyncResult.initial(), "orchestration:read")).toBe(false);

      const answered = yield* harness.nextSettled();
      expect(sessionDeniesScope(answered, "orchestration:read")).toBe(false);
      expect(sessionDeniesScope(answered, "orchestration:operate")).toBe(true);

      yield* SubscriptionRef.set(harness.transport, Option.some(rpcSession()));
      const networkFailure = yield* harness.nextSettled();
      expect(networkFailure._tag).toBe("Failure");
      expect(sessionDeniesScope(networkFailure, "orchestration:operate")).toBe(false);

      yield* SubscriptionRef.set(harness.transport, Option.some(rpcSession()));
      expect(sessionDeniesScope(yield* harness.nextSettled(), "orchestration:read")).toBe(true);
    }),
  );
});


describe("session rejection boundaries", () => {
  it.effect.each([401, 403, 500])("distinguishes host rejection from status %s", (status) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(() => Promise.resolve(new Response(null, { status })));
      expect(sessionDeniesScope(yield* harness.nextSettled(), "orchestration:read")).toBe(status !== 500);
    }),
  );

  it("does not turn a wrapped successful session into a permission denial", () => {
    for (const authenticated of [true, false]) {
      const error = new RpcHttp.RemoteEnvironmentAuthFetchError({
        message: "Could not fetch session",
        cause: { ...SESSION, authenticated },
      });
      expect(sessionDeniesScope(AsyncResult.failure(Cause.fail(error)), "orchestration:read")).toBe(!authenticated);
    }
  });
});



type LegacyThread = Parameters<typeof applyThreadDetailEvent>[0];
type LegacyEvent = Parameters<typeof applyThreadDetailEvent>[1];
const NOW = "2026-11-18T00:00:00.000Z";
const legacyThread = (): LegacyThread => ({
  id: ThreadId.make("saved-thread"),
  projectId: ProjectId.make("saved-project"),
  title: "Saved history",
  bot: { id: BotId.make("saved-bot"), name: "Lin", instructions: "Saved identity" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  branchPullRequest: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
});
const revertEvent = (threadId: ThreadId): Extract<LegacyEvent, { type: "thread.reverted" }> => ({
  sequence: 1,
  eventId: EventId.make("revert"),
  aggregateKind: "thread",
  aggregateId: threadId,
  occurredAt: NOW,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.reverted",
  payload: { threadId, turnCount: 0 },
});

describe("saved V1 history compatibility boundary", () => {
  it("rejects a neighboring thread event and preserves the owning thread", () => {
    const thread = legacyThread();
    expect(applyThreadDetailEvent(thread, revertEvent(ThreadId.make("neighbor")))).toEqual({ kind: "unchanged" });
    expect(thread.updatedAt).toBe(NOW);
    expect(applyThreadDetailEvent(thread, revertEvent(thread.id)).kind).toBe("updated");
  });

  it("keeps imported and system history when live turns are reverted", () => {
    const thread = legacyThread();
    const messages: LegacyThread["messages"] = [
      { id: MessageId.make("import:provider-message"), role: "assistant" as const, text: "Imported answer" },
      { id: MessageId.make("system-message"), role: "system" as const, text: "System history" },
      { id: MessageId.make("live-message"), role: "user" as const, text: "Live turn" },
    ].map((message) => ({ ...message, turnId: null, streaming: false, createdAt: NOW, updatedAt: NOW }));
    const result = applyThreadDetailEvent({ ...thread, messages }, revertEvent(thread.id));
    expect(result.kind).toBe("updated");
    if (result.kind !== "updated") throw new Error("Expected reverted thread");
    expect(result.thread.messages.map((message) => message.id)).toEqual([
      MessageId.make("import:provider-message"), MessageId.make("system-message"),
    ]);
    expect(messages.length).toBe(3);
    expect(result.thread.id).toBe(thread.id);
    expect(result.thread.runtimeMode).toBe("full-access");
    expect(result.thread.bot).toEqual(thread.bot);
  });
});
