import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2Subagent,
  type ServerProvider,
  type SpawnAgentInput,
} from "@j1code/contracts";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { registerBotExecutionContext } from "../mausbot/ExecutionContext.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { layerTest as settingsLayerTest } from "../serverSettings.ts";
import { AgentDelegation, AgentDelegationLive } from "./AgentDelegation.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const environmentId = EnvironmentId.make("local");
const lead = ThreadId.make("lead");
const childId = ThreadId.make("saved-worker");
const leadInstance = ProviderInstanceId.make("codex-personal");
const workerInstance = ProviderInstanceId.make("claude-work");
const projectId = ProjectId.make("project");
const runId = RunId.make("root-run");
const childRunId = RunId.make("worker-run");
const node = NodeId.make("root-node");
const childTaskId = NodeId.make("owned-task");
const approvalMode = { runtimeMode: "auto" as const, interactionMode: "plan" as const };
const at = liveThreadShell(lead).createdAt;
const leadShell = {
  ...liveThreadShell(lead, { ...approvalMode, activeRunId: runId }),
  projectId,
  providerInstanceId: leadInstance,
  modelSelection: { instanceId: leadInstance, model: "lead-model" },
};
const input: SpawnAgentInput = {
  requestId: "request-1",
  title: "Inspect",
  task: "Review the saved project.",
  modelSelection: { instanceId: workerInstance, model: "worker-model" },
};
const scope: McpInvocationScope = {
  environmentId,
  thread: { threadId: lead, providerSessionId: "credential", providerInstanceId: leadInstance },
  client: undefined,
  capabilities: new Set(["agents"]),
  requestNamespace: "native-test",
  issuedAt: 0,
};
const provider: ServerProvider = {
  instanceId: workerInstance,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-19T00:00:00.000Z",
  slashCommands: [],
  skills: [],
  models: [
    { slug: input.modelSelection.model, name: "Worker model", isCustom: false, capabilities: null },
  ],
};
type Delegation = Extract<OrchestrationV2ServerCommand, { type: "delegated_task.request" }>;
function fixture(flags: { disabled?: boolean; managed?: boolean; orphanReceipt?: boolean } = {}) {
  const commands: Delegation[] = [];
  const stops: ThreadId[] = [];
  const stopCommands: Array<
    Parameters<ThreadManagementService["Service"]["cancelDelegatedTask"]>[0]["command"]
  > = [];
  const receipts = new Map<string, ReadonlyArray<OrchestrationV2StoredEvent>>();
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>([[lead, leadShell]]);
  let task: OrchestrationV2Subagent | undefined;
  const earlierWorkers: OrchestrationV2Subagent[] = [];
  let childStatus: OrchestrationV2Run["status"] = "queued";
  let pendingInput = false;
  let watcher: Deferred.Deferred<void> | undefined;
  let changed: Deferred.Deferred<void> | undefined;
  const childRun = () =>
    ({
      id: childRunId,
      threadId: childId,
      status: childStatus,
      ordinal: 1,
    }) as OrchestrationV2Run;
  const stored = (event: unknown) => ({ sequence: 1, event }) as OrchestrationV2StoredEvent;
  const deps = Layer.mergeAll(
    Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(environmentId) }),
    Layer.mock(ProviderInstanceRegistry)({
      listInstances: Effect.succeed([
        {
          instanceId: workerInstance,
          enabled: true,
          snapshot: { getSnapshot: Effect.succeed(provider) },
        } as never,
      ]),
      listUnavailable: Effect.succeed([]),
      getInstance: (id) =>
        Effect.succeed(
          id === workerInstance
            ? ({
                instanceId: workerInstance,
                enabled: true,
                snapshot: { getSnapshot: Effect.succeed(provider) },
              } as never)
            : undefined,
        ),
    }),
    Layer.mock(EventSinkV2)({
      readByCommandId: ({ commandId }) =>
        Stream.suspend(() => Stream.fromIterable(receipts.get(commandId) ?? [])),
    }),
    settingsLayerTest(
      {},
      flags.managed
        ? {
            organization: "Managed",
            lockedSettings: [],
            limits: { maxRuntimeMode: "approval-required" },
          }
        : undefined,
    ),
    Layer.mock(ThreadManagementService)({
      getThreadShell: (id) => Effect.sync(() => shells.get(id) ?? null),
      listProjectThreads: () => Effect.succeed([]),
      isProviderInstanceEnabledForProject: () => Effect.succeed(!flags.disabled),
      hasReceipt: (id) => Effect.sync(() => flags.orphanReceipt || receipts.has(id)),
      getThreadRecords: (id) =>
        Effect.sync(
          () =>
            ({
              subagents: id === lead ? [...earlierWorkers, ...(task ? [task] : [])] : [],
              runs:
                id === lead
                  ? [
                      {
                        id: runId,
                        threadId: lead,
                        providerInstanceId: leadInstance,
                        rootNodeId: node,
                        status: "running",
                      },
                    ]
                  : id === childId
                    ? [childRun()]
                    : [],
              runtimeRequests:
                id === childId && pendingInput
                  ? [
                      {
                        nodeId: node,
                        kind: "user_input",
                        status: "pending",
                        responseCapability: { type: "live" },
                      },
                    ]
                  : [],
              contextTransfers:
                id === childId
                  ? [
                      {
                        type: "subagent_spawn",
                        sourceThreadId: lead,
                        targetThreadId: childId,
                        sourcePoint: { runId },
                        targetRunId: childRunId,
                      },
                    ]
                  : [],
              nodes: id === childId ? [{ id: node, runId: childRunId }] : [],
              messages:
                id === childId
                  ? [
                      {
                        id: MessageId.make("partial"),
                        role: "assistant",
                        runId: childRunId,
                        text: "Saved partial response",
                      },
                      {
                        id: MessageId.make("foreign"),
                        role: "assistant",
                        runId: RunId.make("other"),
                        text: "Unrelated response",
                      },
                    ]
                  : [],
            }) as never,
        ),
      dispatch: (command) =>
        Effect.gen(function* () {
          if (command.type !== "delegated_task.request")
            return yield* Effect.die("Wrong command type.");
          expect(yield* DispatchModeLimit).toEqual(approvalMode);
          expect(command.parentRunId).toBe(runId);
          expect(command.parentNodeId).toBe(node);
          const previous = receipts.get(command.commandId);
          if (previous) return { sequence: 1, storedEvents: previous };
          commands.push(command);
          shells.set(childId, {
            ...leadShell,
            id: childId,
            title: "Worker",
            modelSelection: command.modelSelection,
            providerInstanceId: workerInstance,
            activeRunId: null,
            status: "queued",
            lineage: { parentThreadId: lead, relationshipToParent: "subagent", rootThreadId: lead },
            forkedFrom: { type: "node", nodeId: childTaskId },
          });
          task = {
            id: childTaskId,
            threadId: lead,
            runId,
            parentNodeId: node,
            origin: "app_owned",
            createdBy: "agent",
            driver: provider.driver,
            providerInstanceId: workerInstance,
            providerThreadId: null,
            childThreadId: childId,
            nativeTaskRef: null,
            prompt: command.task,
            title: command.title ?? null,
            model: command.modelSelection.model,
            modelSelection: command.modelSelection,
            status: "running",
            result: null,
            startedAt: at,
            completedAt: null,
            updatedAt: at,
            ...(command.timeoutSeconds === undefined
              ? {}
              : {
                  deadlineTimeoutSeconds: command.timeoutSeconds,
                  deadlineAt: DateTime.add(at, { seconds: command.timeoutSeconds }),
                }),
          };
          const records = [stored({ type: "subagent.updated", threadId: lead, payload: task })];
          receipts.set(command.commandId, records);
          return { sequence: 1, storedEvents: records };
        }),
      getThreadEventSequence: () => Effect.succeed(1),
      streamStoredEventsFrom: ({ threadId }: { readonly threadId?: ThreadId } = {}) =>
        threadId === childId && watcher && changed
          ? Stream.fromEffect(
              Deferred.succeed(watcher, undefined).pipe(
                Effect.andThen(Deferred.await(changed)),
                Effect.as(stored({ type: "run.updated", threadId: childId })),
              ),
            )
          : Stream.empty,
      cancelDelegatedTask: (request) =>
        Effect.sync(() => {
          expect(request.parentThreadId).toBe(lead);
          expect(request.taskId).toBe(childTaskId);
          stops.push(request.command.threadId);
          stopCommands.push(request.command);
          if (task) task = { ...task, status: "cancelled" };
        }),
    }),
  );
  const run = <A, E>(f: (service: AgentDelegation["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      return yield* f(yield* AgentDelegation);
    }).pipe(Effect.provide(AgentDelegationLive.pipe(Layer.provide(deps))));
  return {
    run,
    commands,
    stops,
    stopCommands,
    shells,
    addEarlierWorkers(count: number, status: "running" | "completed") {
      for (let i = 0; i < count; i++) {
        const id = ThreadId.make("earlier-" + i);
        const taskId = NodeId.make("earlier-task-" + i);
        shells.set(id, {
          ...leadShell,
          id,
          lineage: { parentThreadId: lead, relationshipToParent: "subagent", rootThreadId: lead },
          forkedFrom: { type: "node", nodeId: taskId },
        });
        earlierWorkers.push({
          id: taskId,
          childThreadId: id,
          threadId: lead,
          runId,
          origin: "app_owned",
          status,
        } as OrchestrationV2Subagent);
      }
    },
    childStatus(status: OrchestrationV2Run["status"], inputPending = false) {
      childStatus = status;
      pendingInput = inputPending;
    },
    terminal(status: "completed" | "failed", result: string) {
      if (!task) throw new Error("No worker.");
      task = { ...task, status, result };
    },
    deadlineStop(status: "running" | "interrupted") {
      if (!task?.deadlineAt) throw new Error("No timed worker.");
      task = { ...task, status, deadlineCancellationAt: task.deadlineAt };
    },
    wireWait(nextWatcher: Deferred.Deferred<void>, nextChanged: Deferred.Deferred<void>) {
      watcher = nextWatcher;
      changed = nextChanged;
    },
  };
}

it.effect("lists and starts the exact configured worker account under current V2 modes", () =>
  Effect.gen(function* () {
    const f = fixture();
    expect((yield* f.run((service) => service.models(scope))).providers).toMatchObject([
      {
        instanceId: workerInstance,
        enabled: true,
        available: true,
        models: [{ model: "worker-model" }],
      },
    ]);
    const spawned = yield* f.run((service) => service.spawn(input, scope));
    expect(spawned).toMatchObject({
      threadId: childId,
      parentThreadId: lead,
      status: "queued",
      modelSelection: input.modelSelection,
    });
    expect(f.commands[0]).toMatchObject({
      type: "delegated_task.request",
      parentThreadId: lead,
      completionWake: "always",
      ...approvalMode,
      modelSelection: input.modelSelection,
    });
    expect(f.commands[0]).not.toHaveProperty("workspaceStrategy");
    expect(f.commands[0]?.commandId).toBe(
      "j1-agent:spawn:091aa6a46eaf9ee1cb9a394a3241f31bd8b2a1f3f74b0caa747612e10f0f467d",
    );
    expect(spawned).not.toHaveProperty("deadlineAt");
  }),
);

it.effect(
  "replays the durable receipt after acquiring a fresh service and rejects changed payload",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.run((service) => service.spawn(input, scope));
      expect((yield* f.run((service) => service.spawn(input, scope))).threadId).toBe(childId);
      yield* f
        .run((service) => service.spawn({ ...input, task: "Different" }, scope))
        .pipe(Effect.flip);
      yield* f
        .run((service) => service.spawn({ ...input, title: "Different" }, scope))
        .pipe(Effect.flip);
      yield* f
        .run((service) =>
          service.spawn(
            {
              ...input,
              modelSelection: { ...input.modelSelection, options: [] },
            },
            scope,
          ),
        )
        .pipe(Effect.flip);
      expect(f.commands).toHaveLength(1);
    }),
);

it.effect(
  "keeps one deadline across replay and reports timeout only after interruption settles",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const timed = { ...input, timeoutSeconds: 30 };
      const fresh = yield* f.run((service) => service.spawn(timed, scope));
      expect(fresh.deadlineAt).toBe(DateTime.formatIso(DateTime.add(at, { seconds: 30 })));
      expect(f.commands[0]).toMatchObject({ timeoutSeconds: 30 });
      expect(yield* f.run((service) => service.spawn(timed, scope))).toEqual(fresh);
      yield* f
        .run((service) => service.spawn({ ...timed, timeoutSeconds: 31 }, scope))
        .pipe(Effect.flip);
      yield* f.run((service) => service.spawn(input, scope)).pipe(Effect.flip);
      expect(f.commands).toHaveLength(1);
      f.deadlineStop("running");
      expect((yield* f.run((service) => service.spawn(timed, scope))).status).toBe("queued");
      f.deadlineStop("interrupted");
      expect((yield* f.run((service) => service.spawn(timed, scope))).status).toBe("timed-out");
      f.terminal("completed", "Already finished");
      expect((yield* f.run((service) => service.spawn(timed, scope))).status).toBe("completed");
    }),
);

it.effect(
  "rejects orphan receipts, unavailable models and managed escalation before dispatch",
  () =>
    Effect.gen(function* () {
      for (const [f, task] of [
        [fixture({ orphanReceipt: true }), input],
        [fixture({ disabled: true }), input],
        [fixture({ managed: true }), input],
        [fixture(), { ...input, modelSelection: { ...input.modelSelection, model: "unknown" } }],
      ] as const) {
        yield* f.run((service) => service.spawn(task, scope)).pipe(Effect.flip);
        expect(f.commands).toEqual([]);
      }
    }),
);

it.effect("counts persisted active and per-lead-run budgets", () =>
  Effect.gen(function* () {
    const active = fixture();
    active.addEarlierWorkers(8, "running");
    expect(
      (yield* active.run((service) => service.spawn(input, scope)).pipe(Effect.flip)).message,
    ).toContain("Active worker limit");
    const total = fixture();
    total.addEarlierWorkers(32, "completed");
    expect(
      (yield* total.run((service) => service.spawn(input, scope)).pipe(Effect.flip)).message,
    ).toContain("budget");
    expect(active.commands).toEqual([]);
    expect(total.commands).toEqual([]);
  }),
);

it.effect(
  "refuses alternate speakers and direct bot access before reading or mutating workers",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const client = { sessionId: "outside", label: "Outside", access: "full-access" as const };
      for (const caller of [
        { ...scope, thread: undefined, client },
        { ...scope, client },
        { ...scope, capabilities: new Set<never>() },
        { ...scope, environmentId: EnvironmentId.make("foreign") },
        { ...scope, thread: { ...scope.thread!, providerInstanceId: workerInstance } },
      ]) {
        yield* f.run((service) => service.spawn(input, caller)).pipe(Effect.flip);
      }
      for (const restrictedTools of [false, true]) {
        const dispose = registerBotExecutionContext(lead, {
          restrictedTools,
          prompt: "",
          tools: [],
          call: async () => undefined,
        });
        try {
          yield* f.run((service) => service.spawn(input, scope)).pipe(Effect.flip);
        } finally {
          dispose();
        }
      }
      expect(f.commands).toEqual([]);
      yield* f.run((service) => service.spawn(input, scope));
      const foreign = ThreadId.make("foreign");
      f.shells.set(foreign, {
        ...leadShell,
        id: foreign,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: foreign,
        },
      });
      const wrongOwner = { ...scope, thread: { ...scope.thread!, threadId: foreign } };
      yield* f.run((service) => service.get(childId, wrongOwner)).pipe(Effect.flip);
      yield* f.run((service) => service.cancel(childId, wrongOwner)).pipe(Effect.flip);
      expect(f.stops).toEqual([]);
    }),
);

it.effect(
  "reports saved input and terminal receipts rather than assuming a finished turn completed the task",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.run((service) => service.spawn(input, scope));
      f.childStatus("waiting", true);
      const waiting = yield* f.run((service) => service.wait(childId, 10, scope));
      expect(waiting).toMatchObject({ status: "waiting", output: "Saved partial response" });
      f.childStatus("completed");
      expect((yield* f.run((service) => service.get(childId, scope))).status).toBe("running");
      f.terminal("failed", "Provider rejected the request.");
      expect(yield* f.run((service) => service.get(childId, scope))).toMatchObject({
        status: "failed",
        error: "Provider rejected the request.",
      });
    }),
);

it.effect("wakes from a stored event and rereads provider ownership before returning", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* f.run((service) => service.spawn(input, scope));
    const watching = yield* Deferred.make<void>();
    const changed = yield* Deferred.make<void>();
    f.wireWait(watching, changed);
    const result = yield* f
      .run((service) => service.wait(childId, 30, scope))
      .pipe(Effect.flip, Effect.forkScoped);
    yield* Deferred.await(watching);
    f.shells.set(lead, { ...leadShell, activeRunId: null });
    f.childStatus("running");
    yield* Deferred.succeed(changed, undefined);
    expect((yield* Fiber.join(result)).message).toContain("active native conversation");
  }).pipe(Effect.scoped),
);

it.effect("checks the worker ceiling before stop and reports the recorded cancellation", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* f.run((service) => service.spawn(input, scope));
    const child = f.shells.get(childId)!;
    f.shells.set(childId, { ...child, runtimeMode: "full-access" });
    yield* f.run((service) => service.cancel(childId, scope)).pipe(Effect.flip);
    expect(f.stops).toEqual([]);
    f.shells.set(childId, child);
    expect((yield* f.run((service) => service.cancel(childId, scope))).status).toBe("cancelled");
    expect(f.stops).toEqual([childId]);
    expect(f.stopCommands[0]?.commandId).toBe(
      "j1-agent:cancel:dff9cf74b9cfd4355790cf0996ff10edf5c445c440e7a22077fa8a8997624438",
    );
    expect((yield* f.run((service) => service.cancel(childId, scope))).status).toBe("cancelled");
    expect(f.stops).toEqual([childId]);
  }),
);

it.effect.each(["spawn", "cancel"] as const)(
  "refuses %s when ownership is lost during the command digest",
  (operation) =>
    Effect.gen(function* () {
      const f = fixture();
      if (operation === "cancel") yield* f.run((service) => service.spawn(input, scope));
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(crypto.subtle, "digest").mockImplementationOnce((algorithm, data) => {
            f.shells.set(lead, { ...leadShell, activeRunId: null });
            return digest(algorithm, data);
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const denied = yield* f
        .run((service) =>
          operation === "spawn" ? service.spawn(input, scope) : service.cancel(childId, scope),
        )
        .pipe(Effect.flip);
      expect(denied.message).toContain("active native conversation");
      expect(f.commands).toHaveLength(operation === "spawn" ? 0 : 1);
      expect(f.stops).toEqual([]);
    }).pipe(Effect.scoped),
);
