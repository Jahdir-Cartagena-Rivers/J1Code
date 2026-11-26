import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@j1code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import type * as ProviderAdapter from "@j1code/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { deadlineStop } from "./DelegatedTaskDeadline.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for deadline admission"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProviderReplayHarness.layerWithRegistry(
    { name: "delegation-deadline" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const seedLiveParent = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(`thread:${name}`);
    const runId = RunId.make(`run:${name}`);
    const rootNodeId = NodeId.make(`node:${name}:root`);
    const providerThreadId = ProviderThreadId.make(`provider-thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:create:${name}`),
      threadId,
      projectId: ProjectId.make("project:delegation-deadline"),
      title: "Parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    yield* sink.write({
      commandId: CommandId.make(`command:seed:${name}`),
      events: [
        {
          id: EventId.make(`event:seed-provider-thread:${name}`),
          type: "provider-thread.updated",
          threadId,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: instanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: rootNodeId,
            nativeThreadRef: { driver, nativeId: `native:${name}`, strength: "strong" },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`event:seed-node:${name}`),
          type: "node.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: rootNodeId,
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId,
            kind: "root_turn",
            status: "running",
            countsForRun: true,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        {
          id: EventId.make(`event:seed-run:${name}`),
          type: "run.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`message:seed-user:${name}`),
            rootNodeId,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
    return { threadId, runId, rootNodeId };
  });

it.layer(layerTest)("durable delegated task deadlines", (it) => {
  it.effect("stamps once, narrows nested admission, and gates overdue start after rereading storage", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const parent = yield* seedLiveParent("lead");
      const now = yield* DateTime.now;
      const request = {
        type: "delegated_task.request",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make("command:timed-worker"),
        parentThreadId: parent.threadId,
        parentRunId: parent.runId,
        parentNodeId: parent.rootNodeId,
        task: "Perform bounded work",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        timeoutSeconds: 30,
        createdAt: DateTime.add(now, { days: 1 }),
      } as const;
      yield* orchestrator.dispatch(request);
      const [worker] = yield* ProjectionStore.listDelegatedTaskDeadlines;
      assert.isDefined(worker?.deadlineAt);
      assert.isNotNull(worker.childThreadId);
      assert.equal(DateTime.toEpochMillis(worker.deadlineAt!), DateTime.toEpochMillis(now) + 30_000);
      const childId = worker.childThreadId!;
      const child = yield* orchestrator.getThreadProjection(childId);
      const run = child.runs[0]!;
      assert.isNotNull(run.rootNodeId);
      assert.isTrue(yield* orchestrator.delegatedTaskStartAllowed(childId, run.id));
      yield* orchestrator.dispatch(request);
      yield* orchestrator.dispatch({ ...request, timeoutSeconds: 31 }).pipe(Effect.flip);
      yield* orchestrator.dispatch({ ...request, task: "Different payload" }).pipe(Effect.flip);

      yield* sink.write({
        commandId: CommandId.make("command:test-worker-running"),
        events: [{
          id: EventId.make("event:test-worker-running"),
          type: "run.updated",
          threadId: childId,
          runId: run.id,
          nodeId: run.rootNodeId!,
          occurredAt: now,
          payload: { ...run, status: "running", startedAt: now },
        }],
      });
      yield* orchestrator.dispatch({
        ...request,
        commandId: CommandId.make("command:nested-worker"),
        parentThreadId: childId,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        timeoutSeconds: 60,
      });
      const timers = yield* ProjectionStore.listDelegatedTaskDeadlines;
      const nested = timers.find((task) => task.threadId === childId)!;
      assert.equal(DateTime.toEpochMillis(nested.deadlineAt!), DateTime.toEpochMillis(worker.deadlineAt!));
      yield* TestClock.adjust("30 seconds");
      // Recovery starts from the projection, with no task-local timer or remembered request.
      const recovered = (yield* ProjectionStore.listDelegatedTaskDeadlines)
        .find((task) => task.id === worker.id)!;
      const expiry = deadlineStop(recovered, yield* DateTime.now);
      assert.equal(expiry?.taskId, worker.id);
      assert.isFalse(yield* orchestrator.delegatedTaskStartAllowed(childId, run.id));
      assert.isTrue(yield* orchestrator.delegatedTaskStartAllowed(parent.threadId, parent.runId));

      yield* sink.write({
        commandId: CommandId.make("command:test-worker-finished"),
        events: [{
          id: EventId.make("event:test-worker-finished"),
          type: "subagent.updated",
          threadId: parent.threadId,
          occurredAt: yield* DateTime.now,
          payload: { ...worker, status: "completed", result: "already finished" },
        }],
      });
      assert.isFalse((yield* ProjectionStore.listDelegatedTaskDeadlines).some(({id}) => id === worker.id));
      yield* orchestrator.cancelDelegatedTask(expiry!);
      const saved = (yield* orchestrator.getThreadProjection(parent.threadId)).subagents[0]!;
      assert.equal(saved.status, "completed");
      assert.isUndefined(saved.deadlineCancellationAt);
    }),
  );
  it.effect("refuses settled owned work before its deadline while the lead stays eligible", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const parent = yield* seedLiveParent("settled-before-deadline");
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make("command:settled-worker"),
        parentThreadId: parent.threadId,
        parentRunId: parent.runId,
        parentNodeId: parent.rootNodeId,
        task: "Work may finish before the deadline",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        timeoutSeconds: 30,
      });
      const worker = (yield* ProjectionStore.listDelegatedTaskDeadlines)
        .find(({ threadId }) => threadId === parent.threadId)!;
      const childId = worker.childThreadId!;
      const run = (yield* orchestrator.getThreadProjection(childId)).runs[0]!;
      assert.isTrue(yield* orchestrator.delegatedTaskStartAllowed(childId, run.id));
      yield* sink.write({
        commandId: CommandId.make("command:mark-settled-owner-child-running"),
        events: [{
          id: EventId.make("event:mark-settled-owner-child-running"),
          type: "run.updated",
          threadId: childId,
          runId: run.id,
          occurredAt: yield* DateTime.now,
          payload: { ...run, status: "running" },
        }],
      });
      for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) {
        yield* sink.write({
          commandId: CommandId.make(`command:settled-worker:${status}`),
          events: [{
            id: EventId.make(`event:settled-worker:${status}`),
            type: "subagent.updated",
            threadId: parent.threadId,
            occurredAt: yield* DateTime.now,
            payload: { ...worker, status },
          }],
        });
        assert.isFalse(yield* orchestrator.delegatedTaskStartAllowed(childId, run.id));
        assert.isTrue(yield* orchestrator.delegatedTaskStartAllowed(parent.threadId, parent.runId));
        const rejection = yield* orchestrator.dispatch({
          type: "delegated_task.request",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: CommandId.make(`command:nested-owner-test:${status}`),
          parentThreadId: childId,
          parentRunId: run.id,
          parentNodeId: run.rootNodeId!,
          task: "Must have a live original owner",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
        }).pipe(Effect.flip);
        assert.include(String(rejection), "original parent task");
      }
    }),
  );
  it.effect("cancels the exact pre-start attempt after recovery and leaves the lead running", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const parent = yield* seedLiveParent("stops");
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make("command:deadline-stops"),
        parentThreadId: parent.threadId,
        parentRunId: parent.runId,
        parentNodeId: parent.rootNodeId,
        task: "Expire before provider handoff",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        timeoutSeconds: 30,
      });
      yield* TestClock.adjust("30 seconds");
      const recovered = (yield* ProjectionStore.listDelegatedTaskDeadlines)
        .find(({ threadId }) => threadId === parent.threadId)!;
      const request = deadlineStop(recovered, yield* DateTime.now)!;
      const read = () => orchestrator.getThreadProjection(request.command.threadId);
      const initial = (yield* read()).runs[0]!;
      assert.isFalse(yield* orchestrator.delegatedTaskStartAllowed(request.command.threadId, initial.id));
      yield* orchestrator.cancelDelegatedTask({
        ...request,
        expectedDeadlineAt: DateTime.add(recovered.deadlineAt!, { seconds: 1 }),
      });
      assert.equal((yield* read()).runs[0]!.status, initial.status);
      yield* orchestrator.cancelDelegatedTask(request);
      yield* orchestrator.cancelDelegatedTask(request);
      const stopped = yield* read();
      assert.lengthOf(stopped.runs, 1);
      assert.include(["cancelled", "interrupted"], stopped.runs[0]!.status);
      const lead = yield* orchestrator.getThreadProjection(parent.threadId);
      assert.equal(lead.runs[0]!.status, "running");
      assert.equal(lead.subagents[0]!.cancelledRunId, initial.id);
      assert.isDefined(lead.subagents[0]!.deadlineCancellationAt);
    }),
  );
  for (const state of ["waiting", "completed"] as const) {
    it.effect(`settles overdue ${state} work with no live provider turn`, () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const parent = yield* seedLiveParent(`deadline-recover-${state}`);
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: CommandId.make(`command:deadline-recover-${state}`),
          parentThreadId: parent.threadId,
          parentRunId: parent.runId,
          parentNodeId: parent.rootNodeId,
          task: "Recover only before the deadline",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          timeoutSeconds: 30,
        });
        const task = (yield* ProjectionStore.listDelegatedTaskDeadlines)
          .find(({ threadId }) => threadId === parent.threadId)!;
        const childId = task.childThreadId!;
        const child = yield* orchestrator.getThreadProjection(childId);
        const run = child.runs[0]!;
        const attempt = child.attempts.find(({id}) => id === run.activeAttemptId)!;
        const now = yield* DateTime.now;
        yield* sink.writeWithEffects({
          events: [
            {
              id: EventId.make(`event:finish-native-attempt-${state}`),
              type: "run-attempt.updated",
              threadId: childId,
              runId: run.id,
              occurredAt: now,
              payload: { ...attempt, status: "completed", completedAt: now },
            },
            {
              id: EventId.make(`event:finish-native-turn-${state}`),
              type: "run.updated",
              threadId: childId,
              runId: run.id,
              occurredAt: now,
              payload: { ...run, status: state, completedAt: now },
            },
          ],
          effects: state === "waiting" ? [] : [{
            id: `effect:restart-continuation:${run.id}`,
            commandId: CommandId.make(`command:recover-${state}`),
            threadId: childId,
            availableAt: DateTime.add(now, { minutes: 5 }),
            request: { type: "provider-runtime.continue", sourceRunId: run.id },
          }],
        });
        yield* TestClock.adjust("30 seconds");
        const expiry = deadlineStop(task, yield* DateTime.now)!;
        yield* orchestrator.cancelDelegatedTask(expiry);
        const savedChild = yield* orchestrator.getThreadProjection(childId);
        assert.equal(savedChild.runs[0]!.status, state === "waiting" ? "interrupted" : "completed");
        const savedTask = (yield* orchestrator.getThreadProjection(parent.threadId)).subagents[0]!;
        assert.equal(savedTask.status, "interrupted");
        assert.equal(savedTask.cancelledRunId, run.id);
        assert.isDefined(savedTask.deadlineCancellationAt);
        assert.isFalse(yield* orchestrator.delegatedTaskStartAllowed(childId, run.id));
      }),
    );
  }
});
