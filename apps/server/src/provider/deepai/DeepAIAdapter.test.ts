import { it, assert } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ApprovalRequestId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { createDeepAIAgent } from "./DeepAIAgent.ts";
import { makeDeepAIAdapter } from "./DeepAIAdapter.ts";

const harness = vi.hoisted(() => ({
  options: undefined as Parameters<typeof createDeepAIAgent>[0] | undefined,
}));
vi.mock("./DeepAIAgent.ts", () => ({
  createDeepAIAgent: async (options: Parameters<typeof createDeepAIAgent>[0]) => {
    harness.options = options;
    return {
      sessionFile: `${options.sessionDir}/fixture.jsonl`,
      session: { prompt: async () => {}, abort: async () => {}, messages: [] },
      stop: async () => {},
    };
  },
}));
const thread = ThreadId.make("deepai-test");
const instanceId = ProviderInstanceId.make("deepai-test");
const make = () =>
  makeDeepAIAdapter({
    instanceId,
    directory: "C:/isolated-deepai",
    credentials: async () => "test-only",
    catalog: async () => ({
      default: "pilot",
      models: [
        {
          id: "pilot",
          name: "Pilot",
          reasoning: false,
          input: ["text"],
          contextWindow: 4096,
          maxTokens: 512,
        },
      ],
    }),
  });

it.effect("routes approvals to the owning thread and denial reaches the tool hook", () =>
  Effect.gen(function* () {
    const adapter = yield* make();
    const queue = yield* adapter.streamEvents.pipe(Stream.toQueue({ capacity: "unbounded" }));
    yield* Effect.yieldNow;
    yield* adapter.startSession({
      threadId: thread,
      runtimeMode: "approval-required",
      modelSelection: { instanceId, model: "pilot" },
    });
    yield* Queue.take(queue);
    const options = harness.options!;
    const authorization = yield* Effect.promise(() =>
      options.authorize("write", { path: "fixture.txt" }, new AbortController().signal),
    ).pipe(Effect.forkScoped);
    const event = yield* Queue.take(queue);
    assert.strictEqual(event.type, "request.opened");
    assert.isDefined(event.requestId);
    const rejected = yield* adapter
      .respondToRequest(ThreadId.make("other"), ApprovalRequestId.make(event.requestId!), "accept")
      .pipe(Effect.result);
    assert.strictEqual(rejected._tag, "Failure");
    yield* adapter.respondToRequest(thread, ApprovalRequestId.make(event.requestId!), "decline");
    assert.isFalse(yield* Fiber.join(authorization));
  }).pipe(Effect.scoped),
);

it.effect("stopping a session releases pending approvals and removes ownership", () =>
  Effect.gen(function* () {
    const adapter = yield* make();
    const queue = yield* adapter.streamEvents.pipe(Stream.toQueue({ capacity: "unbounded" }));
    yield* Effect.yieldNow;
    yield* adapter.startSession({ threadId: thread, runtimeMode: "approval-required" });
    yield* Queue.take(queue);
    const authorization = yield* Effect.promise(() =>
      harness.options!.authorize("read", {}, new AbortController().signal),
    ).pipe(Effect.forkScoped);
    yield* Queue.take(queue);
    yield* adapter.stopSession(thread);
    assert.isFalse(yield* Fiber.join(authorization));
    assert.isFalse(yield* adapter.hasSession(thread));
  }).pipe(Effect.scoped),
);

it.effect("rejects resume files outside the thread-owned session directory", () =>
  Effect.gen(function* () {
    const adapter = yield* make();
    const result = yield* adapter
      .startSession({
        threadId: thread,
        runtimeMode: "full-access",
        resumeCursor: { sessionFile: "C:/other/private.jsonl" },
      })
      .pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
    assert.isFalse(yield* adapter.hasSession(thread));
  }).pipe(Effect.scoped),
);

it.effect("full access needs no approval and unsupported attachments fail explicitly", () =>
  Effect.gen(function* () {
    const adapter = yield* make();
    yield* adapter.startSession({ threadId: thread, runtimeMode: "full-access" });
    assert.isTrue(
      yield* Effect.promise(() =>
        harness.options!.authorize("read", {}, new AbortController().signal),
      ),
    );
    const result = yield* adapter
      .sendTurn({ threadId: thread, input: "Plan", interactionMode: "plan" })
      .pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
  }).pipe(Effect.scoped),
);
