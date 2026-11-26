import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId, EventId, MessageId, NodeId, ProjectId, ProviderDriverKind, ProviderInstanceId,
  ProviderSessionId, ProviderThreadId, ProviderTurnId, RunAttemptId, RunId, ThreadId,
  type OrchestrationV2AppThread, type OrchestrationV2DomainEvent, type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn, type OrchestrationV2Run, type OrchestrationV2RunAttempt,
} from "@j1code/contracts";
import * as IdAllocator from "@j1code/provider-core/server/IdAllocator";
import type { ProviderAdapterV2RuntimePolicy, ProviderAdapterV2SessionRuntime } from "@j1code/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { CheckpointServiceV2 } from "../orchestration-v2/CheckpointService.ts";
import * as CommandPolicy from "../orchestration-v2/CommandPolicy.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ContextHandoffService from "../orchestration-v2/ContextHandoffService.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { ProviderAdapterRegistryV2 } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { ProviderSwitchServiceV2 } from "../orchestration-v2/ProviderSwitchService.ts";
import { layerStrictNativeSteering } from "../orchestration-v2/ProviderTurnControlService.ts";
import { RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";
import * as ThreadForkService from "../orchestration-v2/ThreadForkService.ts";
import {
  prepareV2StrictDelivery,
  reconcileV2StrictDelivery,
  submitV2StrictDelivery,
  type AdmittedStrictRouteAttempt,
  type WithLockedStrictRouteAdmission,
} from "./v2StrictDelivery.ts";

const threadId = ThreadId.make("strict-thread");
const projectId = ProjectId.make("strict-project");
const runId = RunId.make("strict-run");
const attemptId = RunAttemptId.make("strict-run-attempt");
const rootNodeId = NodeId.make("strict-root-node");
const providerThreadId = ProviderThreadId.make("strict-provider-thread");
const providerTurnId = ProviderTurnId.make("strict-provider-turn");
const providerSessionId = ProviderSessionId.make("strict-session");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5" };
const policy = {
  runtimeMode: "approval-required", interactionMode: "default", cwd: "/workspace",
} satisfies ProviderAdapterV2RuntimePolicy;
const environmentId = EnvironmentId.make("strict-environment");
const admitted: AdmittedStrictRouteAttempt = {
  requestId: "strict-route",
  attemptId: "claimed-delivery",
  source: { environmentId, threadId: ThreadId.make("strict-origin") },
  destination: { environmentId, threadId, projectId, runId, providerInstanceId: instanceId,
    runtimeMode: policy.runtimeMode, interactionMode: policy.interactionMode },
  ceiling: policy,
  text: "Steer the admitted run",
  attachments: [],
};

const makeTestLayer = Effect.fn("strictDeliveryTest.makeLayer")(function* () {
  const now = yield* DateTime.now;
  const runtimePolicy = yield* Ref.make<ProviderAdapterV2RuntimePolicy>(policy);
  const supported = yield* Ref.make(true);
  const runtime: ProviderAdapterV2SessionRuntime = {
    instanceId, driver, providerSessionId,
    providerSession: {
      id: providerSessionId, driver, providerInstanceId: instanceId, status: "running",
      cwd: "/workspace", model: modelSelection.model, capabilities: CodexProviderCapabilitiesV2,
      createdAt: now, updatedAt: now, lastError: null,
    },
    events: Stream.empty,
    ensureThread: () => Effect.die("must not create a thread"),
    resumeThread: () => Effect.die("must not resume a thread"),
    startTurn: () => Effect.die("must not start a turn"),
    interruptTurn: () => Effect.die("must not interrupt a turn"),
    steerTurn: () => Effect.die("must not use ordinary steering"),
    strictSteering: {
      canSteer: () => Ref.get(supported),
      steer: () => Effect.die("no worker should run in this fixture"),
    },
    respondToRuntimeRequest: () => Effect.die("unused"),
    readThreadSnapshot: () => Effect.die("unused"),
    rollbackThread: () => Effect.die("unused"),
    forkThread: () => Effect.die("unused"),
  };
  const stores = Layer.mergeAll(
    ProjectionStore.layer, ProjectStore.layer, EventStore.layer, CommandReceiptStore.layer,
    EffectOutbox.layer,
  );
  const layer = Orchestrator.layer.pipe(
    Layer.provide(layerStrictNativeSteering),
    Layer.provideMerge(Layer.mergeAll(
      ServerSettings.layerTest({}), IdAllocator.layer, CommandPolicy.layer, ThreadForkService.layer,
      Layer.mock(CheckpointServiceV2)({}), Layer.mock(ProviderAdapterRegistryV2)({}),
      Layer.mock(ProviderSessionManagerV2)({ get: () => Effect.succeedSome(runtime) }),
      Layer.mock(ProviderSwitchServiceV2)({}),
      Layer.succeed(RuntimePolicyV2, { resolve: () => Ref.get(runtimePolicy) }),
      ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer)),
    )),
    Layer.provideMerge(EventSink.layer),
    Layer.provideMerge(stores),
    Layer.provide(Sqlite.layerMemory),
    Layer.provide(NodeServices.layer),
  );
  return { layer, runtimePolicy, supported };
});

const seed = Effect.fn("strictDeliveryTest.seed")(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const thread: OrchestrationV2AppThread = {
    id: threadId, projectId, title: "Strict", createdBy: "user", creationSource: "web",
    providerInstanceId: instanceId, modelSelection,
    runtimeMode: policy.runtimeMode, interactionMode: policy.interactionMode, branch: null,
    worktreePath: "/workspace", activeProviderThreadId: providerThreadId,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null, createdAt: now, updatedAt: now, archivedAt: null, deletedAt: null,
    settledOverride: null, settledAt: null, snoozedUntil: null, snoozedAt: null, lastVisitedAt: null,
  };
  const run: OrchestrationV2Run = {
    id: runId, threadId, ordinal: 1, providerInstanceId: instanceId, modelSelection,
    providerThreadId, userMessageId: MessageId.make("first-message"), rootNodeId,
    activeAttemptId: attemptId, status: "running", requestedAt: now, startedAt: now,
    completedAt: null, checkpointId: null, contextHandoffId: null,
  };
  const attempt: OrchestrationV2RunAttempt = {
    id: attemptId, runId, attemptOrdinal: 1, rootNodeId, providerInstanceId: instanceId,
    providerThreadId, providerTurnId, reason: "initial", status: "running",
    startedAt: now, completedAt: null,
  };
  const providerThread: OrchestrationV2ProviderThread = {
    id: providerThreadId, driver, providerInstanceId: instanceId, providerSessionId,
    appThreadId: threadId, ownerNodeId: null,
    nativeThreadRef: { driver, strength: "strong", nativeId: "native-thread" },
    nativeConversationHeadRef: null, status: "active", firstRunOrdinal: 1, lastRunOrdinal: 1,
    handoffIds: [], forkedFrom: null, createdAt: now, updatedAt: now,
  };
  const providerTurn: OrchestrationV2ProviderTurn = {
    id: providerTurnId, providerThreadId, nodeId: rootNodeId, runAttemptId: attemptId,
    nativeTurnRef: { driver, strength: "strong", nativeId: "native-turn" },
    ordinal: 1, status: "running", startedAt: now, completedAt: null,
  };
  const base = { threadId, occurredAt: now, providerInstanceId: instanceId };
  yield* sink.write({
    events: [
      { ...base, id: EventId.make("strict-thread-created"), type: "thread.created", payload: thread },
      { ...base, id: EventId.make("strict-provider-thread"), type: "provider-thread.updated", payload: providerThread },
      { ...base, id: EventId.make("strict-run-created"), type: "run.created", runId, payload: run },
      { ...base, id: EventId.make("strict-attempt-created"), type: "run-attempt.created", runId, payload: attempt },
      { ...base, id: EventId.make("strict-provider-turn"), type: "provider-turn.updated", runId, payload: providerTurn },
    ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>,
  });
  return { sink, base, run, providerTurn };
});

const allow: WithLockedStrictRouteAdmission<never, never> = (delivery, submitOnce) =>
  submitOnce(delivery.attempt.ceiling);

it.effect("fails closed on an unowned, stale, unsteerable or policy-shifted route", () =>
  Effect.gen(function* () {
    const { layer, runtimePolicy, supported } = yield* makeTestLayer();
    yield* Effect.gen(function* () {
      const { sink, base, providerTurn } = yield* seed();
      const prepared = yield* prepareV2StrictDelivery(admitted);
      if (prepared.status !== "prepared") return yield* Effect.die("Expected current native target");
      const { delivery } = prepared;
      assert.equal(delivery.command.target.providerTurnId, providerTurnId);
      assert.equal(delivery.command.target.nativeTurnId, "native-turn");
      assert.deepEqual(
        yield* prepareV2StrictDelivery({ ...admitted, destination: { ...admitted.destination,
          projectId: ProjectId.make("foreign"),
        } }),
        { status: "rejected", reason: "target" },
      );
      assert.deepEqual(
        yield* submitV2StrictDelivery(delivery, () => Effect.succeed({ status: "rejected", reason: "admission" })),
        { status: "rejected", reason: "admission" },
      );
      assert.deepEqual(
        yield* submitV2StrictDelivery(delivery, (_prepared, submitOnce) =>
          submitOnce({ ...policy, interactionMode: "plan" })),
        { status: "rejected", reason: "target" },
      );
      yield* Ref.set(runtimePolicy, { ...policy, cwd: "/changed" });
      assert.deepEqual(yield* submitV2StrictDelivery(delivery, allow), { status: "rejected", reason: "target" });
      yield* Ref.set(runtimePolicy, policy);
      yield* Ref.set(supported, false);
      assert.deepEqual(yield* submitV2StrictDelivery(delivery, allow), { status: "rejected", reason: "target" });
      yield* Ref.set(supported, true);
      yield* sink.write({ events: [{
        ...base, id: EventId.make("strict-target-completed"), type: "provider-turn.updated",
        payload: { ...providerTurn, status: "completed", completedAt: base.occurredAt },
      }] });
      assert.deepEqual(yield* submitV2StrictDelivery(delivery, allow), { status: "rejected", reason: "target" });
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      assert.deepEqual(yield* outbox.listByCommandId(delivery.command.commandId), []);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each(["delivered", "failed", "cancelled"] as const)(
  "reconciles correlated strict delivery as %s with the real outbox",
  (terminal) => Effect.gen(function* () {
    const { layer } = yield* makeTestLayer();
    yield* Effect.gen(function* () {
      yield* seed();
      const prepared = yield* prepareV2StrictDelivery(admitted);
      if (prepared.status !== "prepared") return yield* Effect.die("Expected current native target");
      const { delivery } = prepared;
      assert.deepEqual(yield* reconcileV2StrictDelivery(delivery), { status: "uncertain", reason: "absent" });
      const pending = yield* submitV2StrictDelivery(delivery, allow);
      if (pending.status !== "admitted") return yield* Effect.die("Expected one committed native effect");
      assert.deepEqual(yield* reconcileV2StrictDelivery(delivery), pending);
      assert.deepEqual(yield* submitV2StrictDelivery(delivery, allow), pending);
      const changed = {
        attempt: { ...admitted, text: "Different text" },
        command: { ...delivery.command, text: "Different text" },
      };
      assert.deepEqual(yield* submitV2StrictDelivery(changed, allow), { status: "rejected", reason: "changed-intent" });

      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const [effect] = yield* outbox.listByCommandId(delivery.command.commandId);
      assert.equal(effect?.id, pending.effectId);
      assert.deepEqual(effect?.request, {
        type: "provider-turn.steer", providerSessionId, providerThreadId, providerTurnId,
        messageId: delivery.command.messageId,
      });
      const workerId = "strict-fixture-worker";
      const claimed = yield* outbox.claimNext({ workerId });
      assert.equal(Option.getOrUndefined(claimed)?.id, pending.effectId);
      assert.deepEqual(yield* reconcileV2StrictDelivery(delivery), pending);
      if (terminal === "delivered") {
        assert.isTrue(yield* outbox.succeed({ effectId: pending.effectId, workerId }));
      } else if (terminal === "failed") {
        assert.isTrue(yield* outbox.fail({ effectId: pending.effectId, workerId, error: "declined" }));
      } else {
        yield* outbox.reconcileAfterProcessLoss;
      }
      assert.deepEqual(yield* reconcileV2StrictDelivery(delivery), {
        status: terminal, effectId: pending.effectId,
      });
      assert.deepEqual(yield* submitV2StrictDelivery(delivery, allow), {
        status: terminal, effectId: pending.effectId,
      });
      const orchestration = yield* Orchestrator.OrchestratorV2;
      const { runs } = yield* orchestration.getThreadRecords(threadId, ["runs"]);
      assert.deepEqual(runs.map((run) => run.id), [runId]);
    }).pipe(Effect.provide(layer));
  }),
);
