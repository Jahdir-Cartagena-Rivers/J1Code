import { it, assert } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ApprovalRequestId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { createDeepAIAgent } from "./DeepAIAgent.ts";
import { makeDeepAIAdapter } from "./DeepAIAdapter.ts";
import type { CommandJobResult } from "./CommandJobs.ts";

const harness = vi.hoisted(() => ({
  options: undefined as Parameters<typeof createDeepAIAgent>[0] | undefined,
  prompt: undefined as (() => Promise<void>) | undefined,
  interruptCommands: vi.fn(),
}));
vi.mock("./DeepAIAgent.ts", () => ({
  createDeepAIAgent: async (options: Parameters<typeof createDeepAIAgent>[0]) => {
    harness.options = options;
    return {
      sessionFile: `${options.sessionDir}/fixture.jsonl`,
      session: { prompt: async () => harness.prompt?.(), abort: async () => {}, messages: [] },
      interruptCommands: harness.interruptCommands,
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

it.effect("publishes tool lifecycle and preserves a background job's original turn", () =>
  Effect.gen(function* () {
    const done = Promise.withResolvers<void>();
    harness.prompt = () => done.promise;
    const adapter = yield* make();
    const queue = yield* adapter.streamEvents.pipe(Stream.toQueue({ capacity: "unbounded" }));
    yield* Effect.yieldNow;
    yield* adapter.startSession({ threadId: thread, runtimeMode: "full-access" });
    yield* Queue.take(queue);
    const turn = yield* adapter.sendTurn({ threadId: thread, input: "scan" });
    yield* Queue.take(queue);
    yield* Queue.take(queue);
    const options = harness.options!;
    options.onEvent({
      type: "tool_execution_start",
      toolCallId: "scan",
      toolName: "bash",
      args: { command: "scan fixture" },
    });
    const started = yield* Queue.take(queue);
    assert.strictEqual(started.type, "item.started");
    if (started.type !== "item.started") throw new Error("Expected tool start");
    assert.strictEqual(started.payload.itemType, "command_execution");
    const job: CommandJobResult = {
      id: "owned-job",
      key: "scan fixture",
      state: "running",
      output: "partial",
      outputTruncated: false,
      cancelRequested: false,
      elapsedMs: 10000,
      outputChars: 7,
      msSinceOutput: 2000,
    };
    options.onCommandJob!(job, false);
    options.onCommandJob!(job, true);
    assert.strictEqual((yield* Queue.take(queue)).type, "task.started");
    assert.strictEqual((yield* Queue.take(queue)).type, "task.progress");
    done.resolve();
    yield* Queue.take(queue);
    assert.strictEqual((yield* Queue.take(queue)).type, "turn.completed");
    harness.prompt = undefined;
    const nextDone = Promise.withResolvers<void>();
    harness.prompt = () => nextDone.promise;
    const next = yield* adapter.sendTurn({ threadId: thread, input: "status" });
    yield* Queue.take(queue);
    yield* Queue.take(queue);
    options.onCommandJob!({ ...job, state: "failed", exitCode: 2 }, false);
    const completed = yield* Queue.take(queue);
    assert.strictEqual(completed.type, "task.completed");
    if (completed.type !== "task.completed") throw new Error("Expected task completion");
    assert.strictEqual(completed.turnId, turn.turnId);
    assert.notStrictEqual(completed.turnId, next.turnId);
    assert.strictEqual(completed.payload.status, "failed");
    yield* adapter.interruptTurn(thread);
    assert.isTrue(harness.interruptCommands.mock.calls.length > 0);
    nextDone.resolve();
    harness.prompt = undefined;
    yield* Queue.take(queue);
    yield* Queue.take(queue);
  }).pipe(Effect.scoped),
);

it.effect("allows owned status reads while cancellation still needs approval", () =>
  Effect.gen(function* () {
    const adapter = yield* make();
    const queue = yield* adapter.streamEvents.pipe(Stream.toQueue({ capacity: "unbounded" }));
    yield* Effect.yieldNow;
    yield* adapter.startSession({ threadId: thread, runtimeMode: "approval-required" });
    yield* Queue.take(queue);
    assert.isTrue(
      yield* Effect.promise(() =>
        harness.options!.authorize("command_status", {}, new AbortController().signal),
      ),
    );
    const cancel = yield* Effect.promise(() =>
      harness.options!.authorize("command_cancel", {}, new AbortController().signal),
    ).pipe(Effect.forkScoped);
    const request = yield* Queue.take(queue);
    assert.strictEqual(request.type, "request.opened");
    yield* adapter.respondToRequest(thread, ApprovalRequestId.make(request.requestId!), "decline");
    assert.isFalse(yield* Fiber.join(cancel));
  }).pipe(Effect.scoped),
);

it.effect("ignores callbacks retained by a stopped session after its replacement starts", () =>
  Effect.gen(function* () {
    const adapter = yield* make();
    const queue = yield* adapter.streamEvents.pipe(Stream.toQueue({ capacity: "unbounded" }));
    yield* Effect.yieldNow;
    yield* adapter.startSession({ threadId: thread, runtimeMode: "full-access" });
    yield* Queue.take(queue);
    const old = harness.options!;
    yield* adapter.stopSession(thread);
    yield* adapter.startSession({ threadId: thread, runtimeMode: "full-access" });
    yield* Queue.take(queue);
    const done = Promise.withResolvers<void>();
    harness.prompt = () => done.promise;
    yield* adapter.sendTurn({ threadId: thread, input: "new turn" });
    yield* Queue.take(queue);
    yield* Queue.take(queue);
    const event = {
      type: "tool_execution_start",
      toolCallId: "fixture",
      toolName: "read",
      args: {},
    } as const;
    old.onEvent({ ...event, toolCallId: "stale" });
    harness.options!.onEvent(event);
    const current = yield* Queue.take(queue);
    assert.isTrue(current.itemId?.endsWith(":fixture"));
    assert.isFalse(
      yield* Effect.promise(() => old.authorize("read", {}, new AbortController().signal)),
    );
    done.resolve();
    harness.prompt = undefined;
    yield* Queue.take(queue);
    yield* Queue.take(queue);
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
