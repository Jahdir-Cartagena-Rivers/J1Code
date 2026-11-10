import { it, assert } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ApprovalRequestId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { createDeepAIAgent } from "./DeepAIAgent.ts";
import { makeDeepAIAdapter } from "./DeepAIAdapter.ts";
import type { CommandJobResult } from "./CommandJobs.ts";

const harness = vi.hoisted(() => ({
  prompt: vi.fn(async (..._args: unknown[]) => {}),
  effort: vi.fn(),
  messages: [] as Array<{ role: "assistant"; stopReason: "error"; errorMessage: string }>,
  options: undefined as Parameters<typeof createDeepAIAgent>[0] | undefined,
  waitPrompt: undefined as (() => Promise<void>) | undefined,
  interruptCommands: vi.fn(),
}));
vi.mock("./DeepAIAgent.ts", () => ({
  createDeepAIAgent: async (options: Parameters<typeof createDeepAIAgent>[0]) => {
    harness.options = options;
    return {
      sessionFile: `${options.sessionDir}/fixture.jsonl`,
      interruptCommands: harness.interruptCommands,
      checkpoint: () => () => {
        harness.messages.length = 0;
      },
      session: {
        prompt: async (...args: unknown[]) => {
          await harness.prompt(...args);
          await harness.waitPrompt?.();
        },
        getAvailableThinkingLevels: () => ["low", "medium", "high"],
        setThinkingLevel: harness.effort,
        abort: async () => {},
        messages: harness.messages,
      },
      stop: async () => {},
    };
  },
}));
const thread = ThreadId.make("deepai-test");
const instanceId = ProviderInstanceId.make("deepai-test");
const make = (
  attachmentsDir?: string,
  imageCapable = true,
  describeImages?: (
    question: string,
    images: ReadonlyArray<{ data: string; mimeType: string }>,
  ) => Promise<string>,
) =>
  makeDeepAIAdapter({
    instanceId,
    ...(attachmentsDir ? { attachmentsDir } : {}),
    ...(describeImages ? { describeImages } : {}),
    directory: "C:/isolated-deepai",
    credentials: async () => "test-only",
    catalog: async () => ({
      default: "pilot",
      models: [
        {
          id: "pilot",
          name: "Pilot",
          reasoning: true,
          input: imageCapable ? ["text", "image"] : ["text"],
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
    harness.waitPrompt = () => done.promise;
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
    harness.waitPrompt = undefined;
    const nextDone = Promise.withResolvers<void>();
    harness.waitPrompt = () => nextDone.promise;
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
    harness.waitPrompt = undefined;
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
    harness.waitPrompt = () => done.promise;
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
    harness.waitPrompt = undefined;
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

it.effect("sends stored images and selected effort to the model runtime", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deepai-image-")),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => NodeFSP.rm(directory, { recursive: true })),
    );
    const id = "deepai-test-12345678-1234-1234-1234-123456789abc";
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(directory, `${id}.png`), Buffer.from("fixture")),
    );
    harness.prompt.mockClear();
    harness.effort.mockClear();
    const vision = vi.fn(async () => "Should not run");
    const adapter = yield* make(directory, true, vision);
    const queue = yield* adapter.streamEvents.pipe(Stream.toQueue({ capacity: "unbounded" }));
    yield* Effect.yieldNow;
    yield* adapter.startSession({ threadId: thread, runtimeMode: "full-access" });
    yield* Queue.take(queue);
    yield* adapter.sendTurn({
      threadId: thread,
      input: "Describe",
      modelSelection: {
        instanceId,
        model: "pilot",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      attachments: [{ type: "image", id, name: "test.png", mimeType: "image/png", sizeBytes: 7 }],
    });
    let event = yield* Queue.take(queue);
    while (event.type !== "turn.completed") event = yield* Queue.take(queue);
    assert.strictEqual(event.payload.state, "completed");
    assert.deepStrictEqual(harness.prompt.mock.calls[0], [
      "Describe",
      {
        images: [
          { type: "image", mimeType: "image/png", data: Buffer.from("fixture").toString("base64") },
        ],
      },
    ]);
    assert.deepStrictEqual(harness.effort.mock.calls.at(-1), ["high"]);
    assert.strictEqual(vision.mock.calls.length, 0);
  }).pipe(Effect.scoped),
);

it.effect("rejects images for text models and reports the reason without starting a turn", () =>
  Effect.gen(function* () {
    const adapter = yield* make("C:/isolated", false);
    yield* adapter.startSession({ threadId: thread, runtimeMode: "full-access" });
    const result = yield* adapter
      .sendTurn({
        threadId: thread,
        input: "Describe",
        attachments: [
          {
            type: "image",
            id: "deepai-test-12345678-1234-1234-1234-123456789abc",
            name: "test.png",
            mimeType: "image/png",
            sizeBytes: 7,
          },
        ],
      })
      .pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") assert.include(String(result.failure), "does not accept images");
    assert.strictEqual((yield* adapter.listSessions())[0]?.status, "ready");
  }).pipe(Effect.scoped),
);

it.effect("failed attachment preparation and invalid effort leave the session reusable", () =>
  Effect.gen(function* () {
    const adapter = yield* make("C:/missing-deepai-fixture");
    yield* adapter.startSession({ threadId: thread, runtimeMode: "full-access" });
    const missing = yield* adapter
      .sendTurn({
        threadId: thread,
        attachments: [
          {
            type: "image",
            id: "deepai-test-12345678-1234-1234-1234-123456789abc",
            name: "test.png",
            mimeType: "image/png",
            sizeBytes: 7,
          },
        ],
      })
      .pipe(Effect.result);
    assert.strictEqual(missing._tag, "Failure");
    if (missing._tag === "Failure") assert.include(String(missing.failure), "could not be read");
    const invalid = yield* adapter
      .sendTurn({
        threadId: thread,
        input: "Hello",
        modelSelection: {
          instanceId,
          model: "pilot",
          options: [{ id: "reasoningEffort", value: "invalid" }],
        },
      })
      .pipe(Effect.result);
    assert.strictEqual(invalid._tag, "Failure");
    assert.strictEqual((yield* adapter.listSessions())[0]?.status, "ready");
    const queue = yield* adapter.streamEvents.pipe(Stream.toQueue({ capacity: "unbounded" }));
    yield* Effect.yieldNow;
    yield* adapter.sendTurn({ threadId: thread, input: "Hello" });
    let event = yield* Queue.take(queue);
    while (event.type !== "turn.completed") event = yield* Queue.take(queue);
    assert.strictEqual(event.payload.state, "completed");
  }).pipe(Effect.scoped),
);

it.effect("explains upstream image rejection without exposing upstream payloads", () =>
  Effect.gen(function* () {
    const adapter = yield* make();
    yield* adapter.startSession({ threadId: thread, runtimeMode: "full-access" });
    harness.messages.push({
      role: "assistant",
      stopReason: "error",
      errorMessage: "secret-prompt ValueError: multimodal processing is not enabled",
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        harness.messages.length = 0;
      }),
    );
    const queue = yield* adapter.streamEvents.pipe(Stream.toQueue({ capacity: "unbounded" }));
    yield* Effect.yieldNow;
    yield* adapter.sendTurn({ threadId: thread, input: "Describe" });
    let event = yield* Queue.take(queue);
    while (event.type !== "runtime.error") event = yield* Queue.take(queue);
    assert.include(event.payload.message, "image processing disabled");
    assert.notInclude(event.payload.message, "secret-prompt");
    while (event.type !== "turn.completed") event = yield* Queue.take(queue);
    assert.strictEqual(event.payload.state, "failed");
  }).pipe(Effect.scoped),
);

it.effect("passes file attachments as references instead of reading them into context", () =>
  Effect.gen(function* () {
    const adapter = yield* make("C:/isolated-deepai-attachments");
    yield* adapter.startSession({ threadId: thread, runtimeMode: "full-access" });
    harness.prompt.mockClear();
    const queue = yield* adapter.streamEvents.pipe(Stream.toQueue({ capacity: "unbounded" }));
    yield* Effect.yieldNow;
    yield* adapter.sendTurn({
      threadId: thread,
      input: "Read the file",
      attachments: [
        {
          type: "file",
          id: "deepai-test-12345678-1234-1234-1234-123456789abc-txt",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 7,
        },
      ],
    });
    let event = yield* Queue.take(queue);
    while (event.type !== "turn.completed") event = yield* Queue.take(queue);
    assert.include(String(harness.prompt.mock.calls[0]?.[0]), "Attached file");
    assert.include(String(harness.prompt.mock.calls[0]?.[0]), "notes.txt");
    assert.include(String(harness.prompt.mock.calls[0]?.[0]), "123456789abc-txt.txt");
  }).pipe(Effect.scoped),
);

it.effect("tries DeepAI before vision, restores rejected context and retries without images", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deepai-first-")),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => NodeFSP.rm(directory, { recursive: true })),
    );
    const id = "deepai-test-12345678-1234-1234-1234-123456789abc";
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(directory, `${id}.png`), Buffer.from("fixture")),
    );
    const order: string[] = [];
    const describe = vi.fn(async () => {
      order.push("vision");
      return "[Codex vision] red square";
    });
    harness.prompt.mockImplementationOnce(async () => {
      order.push("deepai");
      harness.messages.push({
        role: "assistant",
        stopReason: "error",
        errorMessage: "multimodal processing is not enabled",
      });
    });
    const adapter = yield* make(directory, true, describe);
    yield* adapter.startSession({ threadId: thread, runtimeMode: "full-access" });
    harness.prompt.mockClear();
    const queue = yield* adapter.streamEvents.pipe(Stream.toQueue({ capacity: "unbounded" }));
    yield* Effect.yieldNow;
    yield* adapter.sendTurn({
      threadId: thread,
      input: "Shape?",
      attachments: [
        { type: "image", id, name: "fixture.png", mimeType: "image/png", sizeBytes: 7 },
      ],
    });
    let event = yield* Queue.take(queue);
    while (event.type !== "turn.completed") event = yield* Queue.take(queue);
    assert.deepStrictEqual(order, ["deepai", "vision"]);
    assert.strictEqual(harness.prompt.mock.calls.length, 2);
    assert.include(String(harness.prompt.mock.calls[1]?.[0]), "Codex vision");
    assert.strictEqual(harness.prompt.mock.calls[1]?.[1], undefined);
    assert.strictEqual(event.payload.state, "completed");
  }).pipe(Effect.scoped),
);

it.effect("authentication and usage errors never invoke a vision fallback", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deepai-auth-")),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => NodeFSP.rm(directory, { recursive: true })),
    );
    const id = "deepai-test-12345678-1234-1234-1234-123456789abc";
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(directory, `${id}.png`), Buffer.from("fixture")),
    );
    const describe = vi.fn(async () => "Should not run");
    const adapter = yield* make(directory, true, describe);
    yield* adapter.startSession({ threadId: thread, runtimeMode: "full-access" });
    const queue = yield* adapter.streamEvents.pipe(Stream.toQueue({ capacity: "unbounded" }));
    yield* Effect.yieldNow;
    for (const errorMessage of [
      "Sign in again (401)",
      "Daily connection check-in limit (429)",
      "network failure",
    ]) {
      harness.prompt.mockImplementationOnce(async () => {
        throw new Error(errorMessage);
      });
      yield* adapter.sendTurn({
        threadId: thread,
        input: "Describe",
        attachments: [{ type: "image", id, name: "test.png", mimeType: "image/png", sizeBytes: 7 }],
      });
      let event = yield* Queue.take(queue);
      while (event.type !== "turn.completed") event = yield* Queue.take(queue);
      assert.strictEqual(event.payload.state, "failed");
    }
    assert.strictEqual(describe.mock.calls.length, 0);
  }).pipe(Effect.scoped),
);
