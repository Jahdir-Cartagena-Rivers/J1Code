// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChatAttachmentId, EnvironmentId, MessageId, NodeId, ProjectId, ProviderInstanceId, ProviderSessionId, ProviderTurnId,
  RunAttemptId, RunId, ThreadId, type OrchestrationV2AppThread,
} from "@j1code/contracts";
import type { ProviderAdapterV2TurnInput } from "@j1code/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@j1code/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as HostProcess from "@j1code/shared/HostProcess";
import * as Layer from "effect/Layer";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { makeDeepAIAdapter } from "./DeepAIAdapter.ts";
import type { createDeepAIAgent } from "./DeepAIAgent.ts";
import { DEEPAI_INVOCATION_HEADER, deepAIMcpFetch, resolveDeepAIInvocation } from "./DeepAIMcpInvocation.ts";

const threadId = ThreadId.make("deepai-thread");
const instanceId = ProviderInstanceId.make("deepai-instance");
const modelSelection = { instanceId, model: "pilot" };
const runtimePolicy = { runtimeMode: "approval-required", interactionMode: "default", cwd: process.cwd() } as const;
type AgentOptions = Parameters<typeof createDeepAIAgent>[0];
type FixtureInput = Pick<Parameters<typeof makeDeepAIAdapter>[0],
  "directory" | "legacyHistory" | "attachmentsDir" | "describeImages">;
const setup = Effect.fn("DeepAIAdapterTest.setup")(function* (fixture?: Partial<FixtureInput> & {
  prompt?: (text: string, input: { images?: ReadonlyArray<{ data: string; mimeType: string }> },
    options: AgentOptions) => Promise<void>;
}) {
  let agentOptions: Parameters<typeof createDeepAIAgent>[0] | undefined;
  let resolvePrompt: (() => void) | undefined;
  let prompts = 0;
  let credentialReads = 0;
  const model = {
    id: "pilot", name: "Pilot", reasoning: true, input: ["text", "image"] as const,
    contextWindow: 4096, maxTokens: 512,
  };
  const adapter = yield* makeDeepAIAdapter({
    instanceId, directory: process.cwd(),
    ...fixture,
    credentials: async () => { credentialReads++; return "fixture-key"; },
    catalog: async () => ({ default: model.id, models: [model] }),
    createAgent: async (options) => {
      agentOptions = options;
      return {
        sessionFile: options.sessionFile ?? NodePath.join(options.sessionDir, "fixture.jsonl"),
        interruptCommands: () => {},
        checkpoint: () => () => {},
        stop: async () => { resolvePrompt?.(); },
        session: {
          getAvailableThinkingLevels: () => ["medium"],
          setThinkingLevel: () => {},
          messages: [],
          prompt: async (text: string, input = {}) => {
            prompts++;
            if (fixture?.prompt) return fixture.prompt(text, input, options);
            await new Promise<void>((resolve) => { resolvePrompt = resolve; });
          },
          abort: async () => { resolvePrompt?.(); },
        },
      };
    },
  });
  const open = {
    providerSessionId: ProviderSessionId.make("deepai-session"),
    threadId, modelSelection, runtimePolicy,
  };
  const runtime = yield* adapter.openSession(open);
  const providerThread = yield* runtime.ensureThread(open);
  const now = yield* DateTime.now;
  const appThread: OrchestrationV2AppThread = {
    id: threadId, title: "DeepAI fixture", projectId: ProjectId.make("project"),
    providerInstanceId: instanceId, modelSelection,
    runtimeMode: runtimePolicy.runtimeMode, interactionMode: runtimePolicy.interactionMode,
    createdBy: "user", creationSource: "web", createdAt: now, updatedAt: now,
    branch: null, worktreePath: null, activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null, archivedAt: null, deletedAt: null, settledAt: null,
    settledOverride: null, lastVisitedAt: null,
  };
  const turn: ProviderAdapterV2TurnInput = {
    appThread,
    threadId, providerThread, modelSelection, runtimePolicy, runOrdinal: 1, providerTurnOrdinal: 1,
    runId: RunId.make("run"), attemptId: RunAttemptId.make("attempt"), rootNodeId: NodeId.make("root"),
    message: { messageId: MessageId.make("message"), text: "one prompt", attachments: [],
      createdBy: "user", creationSource: "web" },
  };
  return { adapter, open, runtime, turn, getOptions: () => agentOptions!,
    prompts: () => prompts, credentialReads: () => credentialReads };
});

it.effect("uses the thread's MCP credential ID for authored prompts and keeps ordinary tools available", () =>
  Effect.gen(function* () {
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    const environmentId = EnvironmentId.make("env");
    const projectId = ProjectId.make("project");
    const providerSessionId = "mcp-credential";
    const endpoint = "http://localhost/mcp";
    yield* sessions.set({
      threadId, environmentId, providerSessionId, endpoint, providerInstanceId: instanceId,
      authorizationHeader: "Bearer fixture", browserToolsAvailable: false,
    });
    const calls: unknown[] = [];
    const f = yield* setup({
      prompt: async (_text, _input, options) => {
        const transport = deepAIMcpFetch(options.mcp!.endpoint, async (_url, init) => {
          const token = new Headers(init?.headers).get(DEEPAI_INVOCATION_HEADER) ?? undefined;
          calls.push(resolveDeepAIInvocation(token, { threadId, environmentId, providerSessionId }));
          return new Response(null, { status: 204 });
        });
        await transport(endpoint);
      },
    });
    assert.notEqual(f.open.providerSessionId, providerSessionId);
    assert.equal(f.getOptions().mcp?.endpoint, endpoint);
    const queue = yield* f.runtime.events.pipe(Stream.toQueue({ capacity: "unbounded" }));
    const turn = { ...f.turn, appThread: { ...f.turn.appThread, projectId } };
    yield* f.runtime.startTurn(turn);
    yield* Effect.repeat(Queue.take(queue), { until: (event) => event.type === "turn.terminal" });
    yield* f.runtime.startTurn({
      ...turn, runOrdinal: 2, providerTurnOrdinal: 2, runId: RunId.make("authored-run"),
      routingIntake: { subject: "user:owner", environmentId },
    });
    yield* Effect.repeat(Queue.take(queue), { until: (event) => event.type === "turn.terminal" });
    assert.deepEqual(calls, [undefined, {
      subject: "user:owner", environmentId, projectId, threadId, providerSessionId,
      runId: "authored-run", messageId: f.turn.message.messageId,
    }]);
  }).pipe(Effect.provide(Layer.merge(McpProviderSessions.layer, NodeServices.layer))),
);

it.effect("refuses cross-account opens, duplicate native owners, foreign history and promptless Resume", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    const foreign = {
      ...f.open, modelSelection: { ...modelSelection, instanceId: ProviderInstanceId.make("another") },
    };
    assert.equal((yield* f.adapter.openSession(foreign).pipe(Effect.result))._tag, "Failure");
    const contender = yield* f.adapter.openSession({ ...f.open, providerSessionId: ProviderSessionId.make("other") });
    assert.equal((yield* contender.ensureThread(f.open).pipe(Effect.result))._tag, "Failure");
    assert.equal((yield* f.runtime.resumeThread({
      providerThread: { ...f.turn.providerThread, appThreadId: ThreadId.make("foreign") },
    }).pipe(Effect.result))._tag, "Failure");
    assert.equal((yield* f.runtime.resumeThread({
      providerThread: { ...f.turn.providerThread, nativeThreadRef: { driver: f.turn.providerThread.driver, strength: "strong", nativeId: null } },
    }).pipe(Effect.result))._tag, "Failure");
    assert.equal((yield* f.runtime.startTurn({ ...f.turn, resume: true }).pipe(Effect.result))._tag, "Failure");
    assert.equal(f.credentialReads(), 1);
    assert.equal(f.prompts(), 0);
    // A different chat with the same account still opens normally.
    const neighbor = { ...f.open, threadId: ThreadId.make("deepai-neighbor"), providerSessionId: ProviderSessionId.make("neighbor") };
    const ordinary = yield* f.adapter.openSession(neighbor);
    assert.equal((yield* ordinary.ensureThread(neighbor)).appThreadId, neighbor.threadId);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reopens the exact managed history and rejects foreign bindings and escaped files before opening an agent", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const nativeDirectory = (id: ThreadId) =>
      NodePath.join(directory, NodeCrypto.createHash("sha256").update(id).digest("hex"));
    yield* fs.makeDirectory(nativeDirectory(threadId));
    const original = NodePath.join(nativeDirectory(threadId), "original.jsonl");
    const savedHistory = '{"type":"fixture","text":"old question and answer"}\n';
    yield* fs.writeFileString(original, savedHistory);
    const outside = yield* fs.makeTempDirectoryScoped();
    const outsideFile = NodePath.join(outside, "escaped.jsonl");
    yield* fs.writeFileString(outsideFile, savedHistory);
    const linkedThread = ThreadId.make("legacy-linked");
    const platform = yield* HostProcess.Platform;
    yield* Effect.promise(() => NodeFSP.symlink(outside, nativeDirectory(linkedThread),
      platform === "win32" ? "junction" : "dir"));
    const requested: string[] = [];
    const f = yield* setup({
      directory,
      legacyHistory: (id) => Effect.succeed(id === "ordinary-new" ? undefined : {
        threadId: id === "legacy-other-thread" ? threadId : id,
        providerName: id === "legacy-other-provider" ? "codex" : "deepai",
        providerInstanceId: id === "legacy-other-account" ? ProviderInstanceId.make("other") : instanceId,
        sessionFile: id === "legacy-outside" ? outsideFile :
          NodePath.join(nativeDirectory(id), id === linkedThread ? "escaped.jsonl" : "original.jsonl"),
      }),
      prompt: async (text) => { requested.push(text); },
    });
    const opened = f.getOptions();
    assert.equal(opened.sessionFile, yield* fs.realPath(original));
    assert.equal(f.turn.providerThread.nativeThreadRef?.nativeId, opened.sessionFile);
    assert.equal(f.turn.providerThread.id, "deepai:" + NodeCrypto.createHash("sha256").update(opened.sessionFile ?? "").digest("hex"));
    assert.deepEqual(requested, []);
    for (const key of ["legacy-other-thread", "legacy-other-provider", "legacy-other-account", "legacy-outside", linkedThread]) {
      const open = { ...f.open, threadId: ThreadId.make(key), providerSessionId: ProviderSessionId.make(key) };
      const runtime = yield* f.adapter.openSession(open);
      assert.equal((yield* runtime.ensureThread(open).pipe(Effect.result))._tag, "Failure", key);
      assert.equal(f.credentialReads(), 1, key);
      assert.strictEqual(f.getOptions(), opened, key);
    }
    const queue = yield* f.runtime.events.pipe(Stream.toQueue({ capacity: "unbounded" }));
    yield* f.runtime.startTurn(f.turn);
    const terminal = yield* Effect.repeat(Queue.take(queue), { until: (event) => event.type === "turn.terminal" });
    assert.equal(terminal.type === "turn.terminal" && terminal.status, "completed");
    assert.deepEqual(requested, [f.turn.message.text]);
    assert.equal(yield* fs.readFileString(original), savedHistory);
    const neighbor = { ...f.open, threadId: ThreadId.make("ordinary-new"), providerSessionId: ProviderSessionId.make("new") };
    const runtime = yield* f.adapter.openSession(neighbor);
    assert.equal((yield* runtime.ensureThread(neighbor)).appThreadId, neighbor.threadId);
    assert.isUndefined(f.getOptions().sessionFile);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["fallback", "tool started", "cancelled"] as const)(
  "handles image rejection with %s", (scenario) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const attachmentsDir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const image = { id: ChatAttachmentId.make("fixture-image"), type: "image" as const,
        name: "photo.png", mimeType: "image/png", sizeBytes: 3 };
      const attachmentPath = resolveAttachmentPath({ attachmentsDir, attachment: image })!;
      yield* fs.writeFile(attachmentPath, Uint8Array.from([1, 2, 3]));
      const attempts: Array<{ text: string; imageCount: number }> = [];
      const visionStarted = Promise.withResolvers<AbortSignal | undefined>();
      const visionResult = Promise.withResolvers<string>();
      let interpretations = 0;
      const f = yield* setup({
        directory: attachmentsDir, attachmentsDir,
        prompt: async (text, input, options) => {
          attempts.push({ text, imageCount: input.images?.length ?? 0 });
          if (attempts.length > 1) return;
          if (scenario === "tool started") {
            options.onEvent({ type: "tool_execution_start", toolCallId: "tool", toolName: "write", args: {} });
          }
          throw new Error("multimodal processing is not enabled");
        },
        describeImages: async (question, images, signal) => {
          interpretations++;
          assert.equal(question, "one prompt");
          const expectedImages = [{ type: "image", data: "AQID", mimeType: "image/png" }];
          assert.deepEqual(images, expectedImages);
          visionStarted.resolve(signal);
          return scenario === "cancelled" ? visionResult.promise : "interpreted photo";
        },
      });
      const queue = yield* f.runtime.events.pipe(Stream.toQueue({ capacity: "unbounded" }));
      yield* f.runtime.startTurn({ ...f.turn, message: { ...f.turn.message, attachments: [image] } });
      const started = yield* Queue.take(queue);
      if (started.type !== "provider_turn.updated") return yield* Effect.die("Missing turn start");
      if (scenario === "cancelled") {
        const signal = yield* Effect.promise(() => visionStarted.promise);
        yield* f.runtime.interruptTurn({ providerThread: f.turn.providerThread, providerTurnId: started.providerTurn.id });
        assert.isTrue(signal?.aborted);
        visionResult.resolve("late vision result");
      }
      const terminal = yield* Effect.repeat(Queue.take(queue), { until: (event) => event.type === "turn.terminal" });
      assert.equal(terminal.type === "turn.terminal" && terminal.status,
        scenario === "fallback" ? "completed" : scenario === "cancelled" ? "interrupted" : "failed");
      const first = { text: f.turn.message.text, imageCount: 1 };
      assert.deepEqual(attempts, scenario === "fallback"
        ? [first, { text: f.turn.message.text + "\n\ninterpreted photo", imageCount: 0 }]
        : [first]);
      assert.equal(interpretations, scenario === "tool started" ? 0 : 1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("isolates approval ownership and issues one interrupted terminal for the owned turn", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    const queue = yield* f.runtime.events.pipe(Stream.toQueue({ capacity: "unbounded" }));
    yield* f.runtime.startTurn(f.turn);
    const started = yield* Queue.take(queue);
    if (started.type !== "provider_turn.updated") return yield* Effect.die("Missing turn start");
    assert.equal((yield* f.runtime.interruptTurn({
      providerThread: f.turn.providerThread, providerTurnId: ProviderTurnId.make("foreign"),
    }).pipe(Effect.result))._tag, "Failure");
    const approval = yield* Effect.promise(() =>
      f.getOptions().authorize("write", {}, new AbortController().signal),
    ).pipe(Effect.forkScoped);
    yield* Queue.take(queue);
    const request = yield* Queue.take(queue);
    if (request.type !== "runtime_request.updated") return yield* Effect.die("Missing approval");
    const other = yield* f.adapter.openSession({
      ...f.open, threadId: ThreadId.make("neighbor"), providerSessionId: ProviderSessionId.make("other"),
    });
    assert.equal((yield* other.respondToRuntimeRequest({
      requestId: request.runtimeRequest.id, decision: "accept",
    }).pipe(Effect.result))._tag, "Failure");
    yield* f.runtime.respondToRuntimeRequest({ requestId: request.runtimeRequest.id, decision: "decline" });
    assert.isFalse(yield* Fiber.join(approval));
    yield* f.runtime.interruptTurn({ providerThread: f.turn.providerThread, providerTurnId: started.providerTurn.id });
    const terminal = yield* Effect.repeat(Queue.take(queue), { until: (event) => event.type === "turn.terminal" });
    assert.equal(terminal.type === "turn.terminal" && terminal.status, "interrupted");
    assert.equal(f.prompts(), 1);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps read-only sandbox restrictions even with full access", () =>
  Effect.gen(function* () {
    const f = yield* setup({
      prompt: async (_text, _input, options) => {
        const signal = new AbortController().signal;
        assert.isTrue(await options.authorize("command_status", {}, signal));
        assert.isFalse(await options.authorize("write", {}, signal));
      },
    });
    const queue = yield* f.runtime.events.pipe(Stream.toQueue({ capacity: "unbounded" }));
    yield* f.runtime.startTurn({ ...f.turn, runtimePolicy: {
      ...f.turn.runtimePolicy, runtimeMode: "full-access", sandboxPolicy: "read-only",
    } });
    const seen = [];
    let event = yield* Queue.take(queue);
    while (event.type !== "turn.terminal") {
      seen.push(event.type);
      event = yield* Queue.take(queue);
    }
    assert.equal(event.status, "completed");
    assert.notInclude(seen, "runtime_request.updated");
    assert.equal(f.prompts(), 1);
  }).pipe(Effect.provide(NodeServices.layer)),
);
