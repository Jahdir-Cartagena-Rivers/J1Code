import { assert, it } from "@effect/vitest";
import {
  MessageId,
  type ModelSelection,
  type OrchestrationV2StrictSteerTarget,
  NodeId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@j1code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type * as ProviderAdapter from "@j1code/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

function makeProjection(input: {
  readonly now: DateTime.Utc;
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  readonly attemptId: RunAttemptId;
}): OrchestrationV2ThreadProjection {
  const runId = RunId.make("run:restart-session");
  const nodeId = NodeId.make("node:restart-session");
  return {
    thread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make("project:restart-session"),
      title: "Restart session",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/workspace",
      activeProviderThreadId: input.providerThread.id,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [
      {
        id: input.attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId: input.providerThread.id,
        providerTurnId: input.providerTurnId,
        reason: "initial",
        status: "superseded",
        startedAt: input.now,
        completedAt: input.now,
      },
    ],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [input.providerThread],
    providerTurns: [
      {
        id: input.providerTurnId,
        providerThreadId: input.providerThread.id,
        nodeId,
        runAttemptId: input.attemptId,
        nativeTurnRef: {
          driver,
          nativeId: "native-turn:restart-session",
          strength: "strong",
        },
        ordinal: 1,
        status: "running",
        startedAt: input.now,
        completedAt: null,
      },
    ],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: input.now,
  };
}

it.effect(
  "interrupts the historical session only for the exact committed restart replacement",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-session");
      const oldSessionId = ProviderSessionId.make("provider-session:restart-session:old");
      const replacementSessionId = ProviderSessionId.make(
        "provider-session:restart-session:replacement",
      );
      const unrelatedSessionId = ProviderSessionId.make(
        "provider-session:restart-session:unrelated",
      );
      const providerThreadId = ProviderThreadId.make("provider-thread:restart-session");
      const providerTurnId = ProviderTurnId.make("provider-turn:restart-session");
      const attemptId = RunAttemptId.make("run-attempt:restart-session");
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: replacementSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver,
          nativeId: "native-thread:restart-session",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const projection = yield* Ref.make(
        makeProjection({ now, threadId, providerThread, providerTurnId, attemptId }),
      );
      const interruptedThread = yield* Ref.make<OrchestrationV2ProviderThread | null>(null);
      const providerSession = {
        id: oldSessionId,
        driver,
        providerInstanceId,
        status: "running" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: providerInstanceId,
        driver,
        providerSessionId: oldSessionId,
        providerSession,
        events: Stream.empty,
        ensureThread: () => Effect.die("unused ensureThread"),
        resumeThread: () => Effect.die("unused resumeThread"),
        startTurn: () => Effect.die("unused startTurn"),
        steerTurn: () => Effect.die("unused steerTurn"),
        interruptTurn: ({ providerThread: target }) =>
          Effect.all(
            [
              Ref.set(interruptedThread, target),
              Ref.update(projection, (current) => ({
                ...current,
                providerTurns: current.providerTurns.map((turn) =>
                  turn.id === providerTurnId
                    ? { ...turn, status: "interrupted" as const, completedAt: now }
                    : turn,
                ),
              })),
            ],
            { discard: true },
          ),
        respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
        readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
        rollbackThread: () => Effect.die("unused rollbackThread"),
        forkThread: () => Effect.die("unused forkThread"),
      };
      const layerProjection = Layer.succeed(
        ProjectionStore.ProjectionStoreV2,
        ProjectionStore.ProjectionStoreV2.of({
          apply: () => Effect.void,
          getLimitRecoveryCandidates: () => Effect.die("unused getLimitRecoveryCandidates"),
          getLimitRecoveryWakeAt: () => Effect.die("unused getLimitRecoveryWakeAt"),
          getOpenRemoteDelegatedTasks: Effect.die("unused getOpenRemoteDelegatedTasks"),
          getAgentAwarenessSnapshot: () => Effect.die("unused awareness snapshot"),
          getShellSnapshot: () => Effect.die("unused getShellSnapshot"),
          listActiveSubagentThreadIds: () => Effect.die("unused listActiveSubagentThreadIds"),
          listSavedWorkerDescendants: () => Effect.die("unused listSavedWorkerDescendants"),
          listThreadArchiveCohort: () => Effect.die("unused listThreadArchiveCohort"),
          hasUndeletedListedProjectThread: () =>
            Effect.die("unused hasUndeletedListedProjectThread"),
          countThreads: () => Effect.die("unused countThreads"),
          listActiveShellIndex: () => Effect.die("unused listActiveShellIndex"),
          listActiveThreads: () => Effect.die("unused listActiveThreads"),
          listOlderSettledThreads: () => Effect.die("unused listOlderSettledThreads"),
          readShellSnapshot: () => Effect.die("unused readShellSnapshot"),
          getThreadShell: () => Effect.die("unused getThreadShell"),
          getThreadTitles: () => Effect.die("unused getThreadTitles"),
          getThreadLinkMetadata: () => Effect.die("unused getThreadLinkMetadata"),
          findGuestShareThreadId: () => Effect.die("unused findGuestShareThreadId"),
          getThread: () => Ref.get(projection).pipe(Effect.map((state) => state.thread)),
          getSettlementCandidates: () => Effect.die("unused getSettlementCandidates"),
          getThreadsWithPullRequests: () => Effect.die("unused getThreadsWithPullRequests"),
          getThreadWorktreePaths: () => Effect.die("unused getThreadWorktreePaths"),
          getThreadProjection: () => Effect.die("control effects must not load transcript"),
          getTurnStartContext: () => Effect.die("unused"),
          getTurnStartHistory: () => Effect.die("unused"),
          getRuntimeRecoveryProjection: () => Effect.die("unused getRuntimeRecoveryProjection"),
          getPlan: () => Effect.die("unused"),
          hasUnpairedRunInterruptRequest: () => Effect.die("unused interrupt read"),
          hasRunInterruptRequest: () => Effect.die("unused stop read"),
          getRunProviderRecords: () => Effect.die("unused run provider read"),
          getThreadAttachmentIds: () => Effect.die("Unused attachment lookup"),
          searchThread: () => Effect.die("unused"),
          searchThreadStream: () => Stream.empty,
          getThreadHistoryPage: () => Effect.die("unused"),
          getTimelinePage: () => Effect.die("Unused timeline read"),
          getMessageCount: () => Effect.die("unused message count"),
          getTranscriptByteFloor: () => Effect.die("unused transcript byte floor"),
          hasPendingDelegatedCompletion: () => Effect.die("unused hasPendingDelegatedCompletion"),
          getSubagentCount: () => Effect.die("unused subagent count"),
          listAppOwnedChildThreadIds: () => Effect.die("unused listAppOwnedChildThreadIds"),
          getNextTurnItemOrdinal: () => Effect.die("unused ordinal read"),
          getTurnItem: () => Effect.die("unused turn item read"),
          getMessagesById: () => Effect.die("unused getMessagesById"),
          getThreadRecords: () => Effect.die("unused record read"),
          getRuntimeRequest: () => Effect.die("unused getRuntimeRequest"),
          getRunningTurnContext: () => Effect.die("unused getRunningTurnContext"),
          getThreadProviderContext: () => Effect.die("unused getThreadProviderContext"),
          getRuntimeResponseContext: () => Effect.die("unused getRuntimeResponseContext"),
          getPendingNativeUserInputs: () => Effect.die("unused getPendingNativeUserInputs"),
          getProviderControlContext: (_threadId, target) =>
            Ref.get(projection).pipe(
              Effect.map((current) => ({
                providerThread: current.providerThreads.find(
                  (thread) => thread.id === target.providerThreadId,
                ),
                providerTurn: current.providerTurns.find(
                  (turn) => turn.id === target.providerTurnId,
                ),
                attempt: current.attempts.find((attempt) => attempt.id === target.attemptId),
                message: undefined,
                run: undefined,
              })),
            ),
          getCheckpointContext: () => Effect.die("not used"),
          getCheckpointRollbackContext: () => Effect.die("unused rollback context"),
          getCheckpointCaptureContext: () => Effect.die("not used"),
          getRunMessage: () => Effect.die("not used"),
          getRun: () => Effect.die("not used"),
          isNodeStored: () => Effect.die("not used"),
          canStartQueuedRun: () => Effect.die("not used"),
          getHeldQueuedRuns: () => Effect.die("not used"),
          getRecoveryThreadIds: () => Effect.die("unused getRecoveryThreadIds"),
          getUnreadableThreadIds: () => Effect.die("unused getUnreadableThreadIds"),
          getThreadSnapshot: () => Effect.die("unused getThreadSnapshot"),
          getThreadSnapshotWindow: () => Effect.die("unused getThreadSnapshotWindow"),
          getPullRequestSnapshot: () => Effect.die("unused getPullRequestSnapshot"),
        }),
      );
      const layerSessionManager = Layer.succeed(
        ProviderSessionManager.ProviderSessionManagerV2,
        ProviderSessionManager.ProviderSessionManagerV2.of({
          shutdown: Effect.void,
          open: () => Effect.die("unused open"),
          get: (providerSessionId) =>
            Effect.succeed(
              providerSessionId === oldSessionId ? Option.some(runtime) : Option.none(),
            ),
          isLive: (providerSessionId) => Effect.succeed(providerSessionId === oldSessionId),
          close: () => Effect.void,
          closeInstance: () => Effect.void,
          release: () => Effect.void,
          detach: () => Effect.void,
          otherWorkingThreads: () => Effect.succeed([]),
          releaseUnlessBusy: () => Effect.succeed(true),
          subscribePromptSuggestion: () => Stream.empty,
        }),
      );
      const layerControl = ProviderTurnControlService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            layerProjection,
            layerSessionManager,
            Layer.mock(EventSink.EventSinkV2)({}),
          ),
        ),
      );

      const [ordinaryInterrupt, unrelatedRestart] = yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        const ordinary = yield* Effect.exit(
          control.interrupt({
            threadId,
            providerSessionId: oldSessionId,
            providerThreadId,
            providerTurnId,
          }),
        );
        const unrelated = yield* Effect.exit(
          control.interruptAndAwaitTerminal({
            threadId,
            providerSessionId: oldSessionId,
            replacementProviderSessionId: unrelatedSessionId,
            providerThreadId,
            providerTurnId,
            interruptedAttemptId: attemptId,
          }),
        );
        return [ordinary, unrelated] as const;
      }).pipe(Effect.provide(layerControl));

      assert.isTrue(Exit.isFailure(ordinaryInterrupt));
      assert.isTrue(Exit.isFailure(unrelatedRestart));
      assert.isNull(yield* Ref.get(interruptedThread));

      yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        yield* control.interruptAndAwaitTerminal({
          threadId,
          providerSessionId: oldSessionId,
          replacementProviderSessionId: replacementSessionId,
          providerThreadId,
          providerTurnId,
          interruptedAttemptId: attemptId,
        });
      }).pipe(Effect.provide(layerControl));

      const interrupted = yield* Ref.get(interruptedThread);
      assert.isNotNull(interrupted);
      assert.equal(interrupted?.providerSessionId, oldSessionId);
      assert.equal(interrupted?.id, providerThreadId);
      assert.equal(interrupted?.nativeThreadRef?.nativeId, "native-thread:restart-session");
    }),
);

it.effect(
  "strict steering rechecks ownership, native identity and current policy before delivery",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:strict");
      const providerSessionId = ProviderSessionId.make("provider-session:strict");
      const providerThreadId = ProviderThreadId.make("provider-thread:strict");
      const providerTurnId = ProviderTurnId.make("provider-turn:strict");
      const attemptId = RunAttemptId.make("attempt:strict");
      const messageId = MessageId.make("message:strict");
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "native-thread:strict", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const base = makeProjection({ now, threadId, providerThread, providerTurnId, attemptId });
      const attempt = { ...base.attempts[0]!, status: "running" as const, completedAt: null };
      const turn = base.providerTurns[0]!;
      const policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy = {
        runtimeMode: base.thread.runtimeMode,
        interactionMode: base.thread.interactionMode,
        cwd: base.thread.worktreePath,
      };
      const target: OrchestrationV2StrictSteerTarget = {
        projectId: base.thread.projectId,
        runId: attempt.runId,
        attemptId,
        providerInstanceId,
        providerSessionId,
        providerThreadId,
        providerTurnId,
        nativeThreadId: "native-thread:strict",
        nativeTurnId: "native-turn:restart-session",
        runtimeMode: policy.runtimeMode,
        interactionMode: policy.interactionMode,
        policyFingerprint: ProviderTurnControlService.strictSteerFingerprint(policy),
      };
      const strictCommandFingerprint = "strict-command";
      const message = {
        id: messageId,
        threadId,
        runId: attempt.runId,
        nodeId: attempt.rootNodeId,
        role: "user" as const,
        text: "Strict message",
        attachments: [],
        createdBy: "user" as const,
        creationSource: "web" as const,
        streaming: false,
        createdAt: now,
        updatedAt: now,
        strictSteer: { target, commandFingerprint: strictCommandFingerprint },
      };
      const run = {
        id: attempt.runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: messageId,
        rootNodeId: attempt.rootNodeId,
        activeAttemptId: attemptId,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      const current = {
        ...base,
        attempts: [attempt],
        providerTurns: [turn],
        runs: [run],
        messages: [message],
      } satisfies OrchestrationV2ThreadProjection;
      const projection = yield* Ref.make<OrchestrationV2ThreadProjection>(current);
      const resolvedPolicy = yield* Ref.make(policy);
      const calls = yield* Ref.make(0);
      const providerSession: ProviderAdapter.ProviderAdapterV2SessionRuntime["providerSession"] = {
        id: providerSessionId,
        providerInstanceId,
        driver,
        status: "running",
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: providerInstanceId,
        driver,
        providerSessionId,
        providerSession,
        events: Stream.empty,
        ensureThread: () => Effect.die("must not create a provider thread"),
        resumeThread: () => Effect.die("must not resume a provider thread"),
        startTurn: () => Effect.die("must not start a provider turn"),
        steerTurn: () => Effect.die("must not use ordinary native steering"),
        strictSteering: {
          canSteer: () => Effect.succeed(true),
          steer: (input) => {
            assert.deepEqual(input.target, target);
            assert.equal(input.message.messageId, messageId);
            return Ref.update(calls, (count) => count + 1);
          },
        },
        interruptTurn: () => Effect.die("must not interrupt a provider turn"),
        respondToRuntimeRequest: () => Effect.die("unused"),
        readThreadSnapshot: () => Effect.die("unused"),
        rollbackThread: () => Effect.die("unused"),
        forkThread: () => Effect.die("unused"),
      };
      const runtimeRef = yield* Ref.make(runtime);
      const projectionLayer = Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getProviderControlContext: () =>
          Effect.succeed({ providerThread, providerTurn: turn, attempt, message, run }),
        getThreadRecords: () => Ref.get(projection),
        hasRunInterruptRequest: () => Effect.succeed(false),
      });
      const nativeLayer = ProviderTurnControlService.layerStrictNativeSteering.pipe(
        Layer.provide(projectionLayer),
      );
      const layer = ProviderTurnControlService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(EventSink.EventSinkV2)({}),
            projectionLayer,
            nativeLayer,
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: () => Ref.get(runtimeRef).pipe(Effect.asSome),
            }),
            Layer.succeed(RuntimePolicyV2, { resolve: () => Ref.get(resolvedPolicy) }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        const request = {
          threadId,
          providerSessionId,
          providerThreadId,
          providerTurnId,
          messageId,
          strictCommandFingerprint,
        };
        for (const candidate of [
          { ...current, runs: [{ ...run, status: "starting" as const }] },
          { ...current, providerTurns: [{ ...turn, status: "completed" as const }] },
          { ...current, providerTurns: [{ ...turn, nativeTurnRef: null }] },
          {
            ...current,
            providerThreads: [{ ...providerThread, appThreadId: ThreadId.make("foreign") }],
          },
          { ...current, thread: { ...base.thread, runtimeMode: "approval-required" as const } },
        ]) {
          yield* Ref.set(projection, candidate);
          assert.isTrue(Exit.isFailure(yield* Effect.exit(control.steer(request))));
        }
        yield* Ref.set(projection, current);
        yield* Ref.set(resolvedPolicy, { ...policy, cwd: "/changed" });
        assert.isTrue(Exit.isFailure(yield* Effect.exit(control.steer(request))));
        yield* Ref.set(resolvedPolicy, policy);
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              control.steer({
                ...request,
                strictCommandFingerprint: "wrong-command",
              }),
            ),
          ),
        );
        assert.equal(yield* Ref.get(calls), 0);
        yield* control.steer(request);
        assert.equal(yield* Ref.get(calls), 1);
        const { strictSteering: _strict, ...unsupportedRuntime } = runtime;
        yield* Ref.set(runtimeRef, unsupportedRuntime);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(control.steer(request))));
        assert.equal(yield* Ref.get(calls), 1);
        yield* Effect.gen(function* () {
          const native = yield* ProviderTurnControlService.StrictNativeSteeringV2;
          const input = { threadId, target, session: runtime, policy };
          assert.isTrue(yield* native.canSteer(input));
          assert.isFalse(yield* native.canSteer({ ...input, session: unsupportedRuntime }));
          yield* Ref.set(projection, { ...current, providerThreads: [] });
          assert.isFalse(yield* native.canSteer(input));
        }).pipe(Effect.provide(nativeLayer));
      }).pipe(Effect.provide(layer));
    }),
);
