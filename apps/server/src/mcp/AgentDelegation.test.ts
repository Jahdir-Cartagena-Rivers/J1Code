import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  AGENT_DELEGATION_ACTIVITY_KIND,
  AgentDelegationRecord,
  CheckpointRef,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type AgentDelegationStatus,
  type OrchestrationCommand,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { TestClock } from "effect/testing";
import { describe, expect } from "vite-plus/test";
import { ServerConfig } from "../config.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { foldSubagentActivities } from "../../../../packages/client-runtime/src/state/subagentRuntime.ts";
import { AgentDelegation, AgentDelegationLive } from "./AgentDelegation.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import { AgentsToolkit } from "./toolkits/agents/tools.ts";
import { AgentsToolkitHandlersLive } from "./toolkits/agents/handlers.ts";

const NOW = "2026-09-30T12:00:00.000Z";
const isDelegationRecord = Schema.is(AgentDelegationRecord);
const projectId = ProjectId.make("project-delegation-test");
const root = ThreadId.make("lead");
const kind = ProviderDriverKind.make;
const instance = ProviderInstanceId.make;
const allProviders = ["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity"];
const provider = (driver: string): ServerProvider => ({
  instanceId: instance(driver),
  driver: kind(driver),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  checkedAt: NOW,
  auth: { status: "authenticated" },
  models: [
    { slug: `${driver}-model`, name: `${driver} model`, isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
});
const invocation = (threadId = root, providerId = "claudeAgent"): McpInvocationScope => ({
  environmentId: EnvironmentId.make("test-environment"),
  threadId,
  providerInstanceId: instance(providerId),
  providerSessionId: `session:${threadId}`,
  capabilities: new Set(["agents"]),
  issuedAt: 0,
});
const task = (requestId = "task-1", driver = "codex") => ({
  requestId,
  title: `Inspect ${requestId}`,
  task: "Inspect only. Do not modify files.",
  modelSelection: { instanceId: instance(driver), model: `${driver}-model` },
});
const providers = Layer.mock(ProviderService)({
  getInstanceInfo: (id) =>
    Effect.succeed({
      instanceId: id,
      driverKind: kind(id),
      displayName: id,
      enabled: true,
      continuationIdentity: { driverKind: kind(id), continuationKey: id },
    }),
  stopSession: () => Effect.void,
});
const infrastructure = OrchestrationLayerLive.pipe(
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j1-delegation-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const base = Layer.mergeAll(
  infrastructure,
  providers,
  Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(allProviders.map(provider)) }),
);
const testLayer = AgentDelegationLive.pipe(Layer.provideMerge(base));
const wireLayer = McpServer.toolkit(AgentsToolkit).pipe(
  Layer.provide(AgentsToolkitHandlersLive),
  Layer.provideMerge(testLayer),
  Layer.provideMerge(McpServer.McpServer.layer),
);
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "delegation-test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "delegation-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const command = Effect.fn("test.command")(function* (input: OrchestrationCommand) {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch(input);
});
const startSession = Effect.fn("test.startSession")(function* (id: ThreadId, driver: string) {
  yield* command({
    type: "thread.session.set",
    commandId: CommandId.make(`session:${id}`),
    threadId: id,
    session: {
      threadId: id,
      status: "running",
      providerName: driver,
      providerInstanceId: instance(driver),
      runtimeMode: "approval-required",
      activeTurnId: TurnId.make(`turn:${id}`),
      lastError: null,
      updatedAt: NOW,
    },
    createdAt: NOW,
  });
});
const seed = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse(NOW));
  const agents = yield* AgentDelegation;
  yield* agents.models(invocation());
  yield* command({
    type: "project.create",
    commandId: CommandId.make("project"),
    projectId,
    title: "Delegation",
    workspaceRoot: process.cwd(),
    defaultModelSelection: null,
    createdAt: NOW,
  });
  yield* command({
    type: "thread.create",
    commandId: CommandId.make("lead"),
    threadId: root,
    projectId,
    title: "Lead",
    modelSelection: task("x", "claudeAgent").modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
  });
  yield* startSession(root, "claudeAgent");
  return agents;
});
const awaitStatus = Effect.fn("test.awaitStatus")(function* (
  id: ThreadId,
  status: AgentDelegationStatus,
) {
  const agents = yield* AgentDelegation;
  let result = yield* agents.get(id, invocation());
  while (result.status !== status) result = yield* agents.wait(id, 60, invocation());
  return result;
});

describe("cross-provider delegation with real orchestration and SQLite", () => {
  it.effect(
    "exposes discoverable MCP tools with real structured results and capability rejection",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const server = yield* McpServer.McpServer;
        const call = (name: string, args: Record<string, unknown>, scope = invocation()) =>
          server
            .callTool({ name, arguments: args })
            .pipe(
              Effect.provideService(McpInvocationContext, scope),
              Effect.provideService(McpSchema.McpServerClient, client),
            );
        const models = yield* call("list_agent_models", {});
        expect(models.isError).toBe(false);
        expect(models.structuredContent).toMatchObject({
          providers: expect.arrayContaining([
            expect.objectContaining({
              instanceId: "codex",
              driver: "codex",
              enabled: true,
              available: true,
              models: [{ model: "codex-model", name: "codex model" }],
            }),
          ]),
        });
        const denied = yield* call("spawn_agent", task(), {
          ...invocation(),
          capabilities: new Set(),
        });
        expect(denied.isError).toBe(true);
        const spawned = yield* call("spawn_agent", task());
        expect(spawned.isError).toBe(false);
        expect(spawned.structuredContent).toMatchObject({
          status: "starting",
          modelSelection: task().modelSelection,
        });
        const agents = yield* AgentDelegation;
        const [worker] = yield* agents.list(invocation());
        expect(worker).toBeDefined();
        const cancelled = yield* call("cancel_agent", { threadId: worker!.threadId });
        expect(cancelled.structuredContent).toMatchObject({ status: "cancelled" });
      }).pipe(Effect.provide(wireLayer)),
  );
  it.effect.each(allProviders)("routes a Claude lead to %s and preserves permissions", (driver) =>
    Effect.gen(function* () {
      const agents = yield* seed;
      const spawned = yield* agents.spawn(task("task-1", driver), invocation());
      expect(spawned.status).toBe("starting");
      const snapshots = yield* ProjectionSnapshotQuery;
      const child = Option.getOrThrow(yield* snapshots.getThreadDetailById(spawned.threadId));
      expect(child.modelSelection.instanceId).toBe(driver);
      expect(child.runtimeMode).toBe("approval-required");
      expect(child.projectId).toBe(projectId);
      expect(child.messages[0]?.text).toContain("Inspect only");
      const parent = Option.getOrThrow(yield* snapshots.getThreadDetailById(root));
      expect(foldSubagentActivities(parent.activities)[0]).toMatchObject({
        id: spawned.threadId,
        title: "Inspect task-1",
        model: `${driver}-model`,
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("deduplicates simultaneous retries and rejects a changed task key", () =>
    Effect.gen(function* () {
      const agents = yield* seed;
      const results = yield* Effect.all(
        [agents.spawn(task(), invocation()), agents.spawn(task(), invocation())],
        { concurrency: "unbounded" },
      );
      expect(results[0]?.threadId).toBe(results[1]?.threadId);
      expect(yield* agents.list(invocation())).toHaveLength(1);
      const error = yield* agents
        .spawn({ ...task(), task: "Different task" }, invocation())
        .pipe(Effect.flip);
      expect(error.message).toContain("different task");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("blocks foreign, unbound, missing-capability and unknown-model calls", () =>
    Effect.gen(function* () {
      const agents = yield* seed;
      const worker = yield* agents.spawn(task(), invocation());
      expect(
        (yield* agents.get(worker.threadId, invocation(ThreadId.make("other"))).pipe(Effect.flip))
          .message,
      ).toContain("does not belong");
      expect(
        (yield* agents
          .cancel(worker.threadId, invocation(ThreadId.make("other")))
          .pipe(Effect.flip)).message,
      ).toContain("does not belong");
      expect(
        (yield* agents.spawn(task("other"), invocation(root, "codex")).pipe(Effect.flip)).message,
      ).toContain("active lead session");
      expect(
        (yield* agents
          .spawn(task("other"), { ...invocation(), capabilities: new Set() })
          .pipe(Effect.flip)).message,
      ).toContain("no agent delegation");
      expect(
        (yield* agents
          .spawn(
            {
              ...task("other"),
              modelSelection: { instanceId: instance("codex"), model: "unknown" },
            },
            invocation(),
          )
          .pipe(Effect.flip)).message,
      ).toContain("Unknown model");
      expect(yield* agents.list(invocation())).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "allows workers to delegate across providers, bounds depth, and cancels descendants",
    () =>
      Effect.gen(function* () {
        const agents = yield* seed;
        const first = yield* agents.spawn(task("first", "codex"), invocation());
        yield* startSession(first.threadId, "codex");
        const second = yield* agents.spawn(
          task("second", "antigravity"),
          invocation(first.threadId, "codex"),
        );
        yield* startSession(second.threadId, "antigravity");
        const third = yield* agents.spawn(
          task("third", "claudeAgent"),
          invocation(second.threadId, "antigravity"),
        );
        yield* startSession(third.threadId, "claudeAgent");
        const error = yield* agents
          .spawn(task("fourth"), invocation(third.threadId, "claudeAgent"))
          .pipe(Effect.flip);
        expect(error.message).toContain("depth limit");
        expect(yield* agents.list(invocation())).toHaveLength(3);
        yield* agents.cancel(first.threadId, invocation());
        expect((yield* agents.list(invocation())).map((job) => job.status)).toEqual([
          "cancelled",
          "cancelled",
          "cancelled",
        ]);
        const snapshots = yield* ProjectionSnapshotQuery;
        expect(Option.isSome(yield* snapshots.getThreadDetailById(third.threadId))).toBe(true);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("caps active workers and expires them on the server clock", () =>
    Effect.gen(function* () {
      const agents = yield* seed;
      for (let index = 0; index < 8; index++)
        yield* agents.spawn(task(`worker-${index}`), invocation());
      const error = yield* agents.spawn(task("overflow"), invocation()).pipe(Effect.flip);
      expect(error.message).toContain("Active worker limit");
      yield* TestClock.adjust("601 seconds");
      const workers = yield* agents.list(invocation());
      for (const worker of workers) yield* awaitStatus(worker.threadId, "timed-out");
      expect(
        (yield* agents.list(invocation())).every((worker) => worker.status === "timed-out"),
      ).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("stopping the lead cancels workers while retaining their histories", () =>
    Effect.gen(function* () {
      const agents = yield* seed;
      const worker = yield* agents.spawn(task(), invocation());
      yield* command({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("stop-lead"),
        threadId: root,
        createdAt: NOW,
      });
      yield* awaitStatus(worker.threadId, "cancelled");
      expect((yield* agents.spawn(task("late"), invocation()).pipe(Effect.flip)).message).toContain(
        "stopped",
      );
      const snapshots = yield* ProjectionSnapshotQuery;
      expect(
        Option.getOrThrow(yield* snapshots.getThreadDetailById(worker.threadId)).messages,
      ).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("preserves a provider failure instead of treating it as a successful result", () =>
    Effect.gen(function* () {
      const agents = yield* seed;
      const worker = yield* agents.spawn(task(), invocation());
      yield* command({
        type: "thread.session.set",
        commandId: CommandId.make("worker-failure"),
        threadId: worker.threadId,
        session: {
          threadId: worker.threadId,
          status: "error",
          providerName: "codex",
          providerInstanceId: instance("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: "Authentication failed",
          updatedAt: NOW,
        },
        createdAt: NOW,
      });
      const result = yield* awaitStatus(worker.threadId, "failed");
      expect(result.error).toBe("Authentication failed");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reports waiting for a user approval and does not answer it", () =>
    Effect.gen(function* () {
      const agents = yield* seed;
      const worker = yield* agents.spawn(task(), invocation());
      yield* startSession(worker.threadId, "codex");
      yield* command({
        type: "thread.activity.append",
        commandId: CommandId.make("approval"),
        threadId: worker.threadId,
        activity: {
          id: EventId.make("approval"),
          kind: "approval.requested",
          tone: "approval",
          summary: "Needs approval",
          payload: { requestId: "worker-approval", requestKind: "command" },
          turnId: TurnId.make(`turn:${worker.threadId}`),
          createdAt: NOW,
        },
        createdAt: NOW,
      });
      yield* awaitStatus(worker.threadId, "waiting");
      expect((yield* agents.wait(worker.threadId, 1, invocation())).status).toBe("waiting");
      const snapshots = yield* ProjectionSnapshotQuery;
      expect(
        Option.getOrThrow(yield* snapshots.getThreadShellById(worker.threadId)).hasPendingApprovals,
      ).toBe(true);
      yield* agents.cancel(worker.threadId, invocation());
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("returns the final saved response after checkpoint completion", () =>
    Effect.gen(function* () {
      const agents = yield* seed;
      const child = yield* agents.spawn(task(), invocation());
      yield* startSession(child.threadId, "codex");
      yield* command({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("response-delta"),
        threadId: child.threadId,
        messageId: MessageId.make("answer"),
        delta: "Verified result",
        turnId: TurnId.make(`turn:${child.threadId}`),
        createdAt: NOW,
      });
      yield* command({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("response"),
        threadId: child.threadId,
        messageId: MessageId.make("answer"),
        turnId: TurnId.make(`turn:${child.threadId}`),
        createdAt: NOW,
      });
      yield* command({
        type: "thread.session.set",
        commandId: CommandId.make("ready"),
        threadId: child.threadId,
        session: {
          threadId: child.threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: instance("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
        createdAt: NOW,
      });
      yield* command({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("checkpoint"),
        threadId: child.threadId,
        turnId: TurnId.make(`turn:${child.threadId}`),
        completedAt: NOW,
        checkpointRef: CheckpointRef.make("test-ref"),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        assistantMessageId: MessageId.make("answer"),
        createdAt: NOW,
      });
      const result = yield* awaitStatus(child.threadId, "completed");
      expect(result.output).toBe("Verified result");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("recovers persisted jobs without duplicating work after a restart", () =>
    Effect.gen(function* () {
      let id: ThreadId = root;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* seed;
          id = (yield* agents.spawn(task(), invocation())).threadId;
        }).pipe(Effect.provide(AgentDelegationLive)),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* AgentDelegation;
          const result = yield* agents.get(id, invocation());
          expect(result.status).toBe("interrupted");
          expect(result.error).toContain("not automatically rerun");
          expect((yield* agents.spawn(task(), invocation())).threadId).toBe(id);
          const snapshots = yield* ProjectionSnapshotQuery;
          const child = Option.getOrThrow(yield* snapshots.getThreadDetailById(id));
          expect(child.messages.filter((message) => message.role === "user")).toHaveLength(1);
        }).pipe(Effect.provide(AgentDelegationLive)),
      );
    }).pipe(Effect.provide(base)),
  );

  it.effect("fails closed on a future durable record version", () =>
    Effect.gen(function* () {
      const snapshots = yield* ProjectionSnapshotQuery;
      const seedOnly = yield* Effect.scoped(seed.pipe(Effect.provide(AgentDelegationLive)));
      void seedOnly;
      yield* command({
        type: "thread.activity.append",
        commandId: CommandId.make("future-record"),
        threadId: root,
        activity: {
          id: EventId.make("future-record"),
          kind: AGENT_DELEGATION_ACTIVITY_KIND,
          tone: "info",
          summary: "Future record",
          payload: { version: 99 },
          turnId: null,
          createdAt: NOW,
        },
        createdAt: NOW,
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* AgentDelegation;
          expect((yield* agents.models(invocation()).pipe(Effect.flip)).message).toContain(
            "version",
          );
          expect(Option.isSome(yield* snapshots.getThreadDetailById(root))).toBe(true);
        }).pipe(Effect.provide(AgentDelegationLive)),
      );
      expect(isDelegationRecord({ version: 99 })).toBe(false);
    }).pipe(Effect.provide(base)),
  );
});
