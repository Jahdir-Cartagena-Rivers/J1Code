import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  VcsProcessExitError,
  type OrchestrationV2ThreadProjection,
} from "@j1code/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlError from "effect/sql/SqlError";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";

const threadId = ThreadId.make("thread:effect-worker-restart");
const oldSessionId = ProviderSessionId.make("provider-session:effect-worker-restart:old");
const providerThreadId = ProviderThreadId.make("provider-thread:effect-worker-restart");
const providerTurnId = ProviderTurnId.make("provider-turn:effect-worker-restart");
const attemptId = RunAttemptId.make("run-attempt:effect-worker-restart");
const runId = RunId.make("run:effect-worker-restart");

function restartEffect(
  now: DateTime.Utc,
  sessionTransition: NonNullable<
    Extract<
      EffectOutbox.OrchestrationEffectV2["request"],
      { readonly type: "provider-turn.restart" }
    >["sessionTransition"]
  >,
): EffectOutbox.OrchestrationEffectV2 {
  const timestamp = DateTime.formatIso(now);
  return {
    id: `effect:restart:${sessionTransition.type}`,
    commandId: CommandId.make(`command:restart:${sessionTransition.type}`),
    threadId,
    request: {
      type: "provider-turn.restart",
      providerSessionId: oldSessionId,
      providerThreadId,
      providerTurnId,
      interruptedAttemptId: attemptId,
      runId,
      sessionTransition,
    },
    status: "running",
    attemptCount: 1,
    availableAt: timestamp,
    leaseOwner: "test-worker",
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    lastError: null,
  };
}

function steerFixtureProjection(
  id: ThreadId,
  now: DateTime.Utc,
): OrchestrationV2ThreadProjection {
  const instanceId = ProviderInstanceId.make("codex");
  return {
    thread: {
      id,
      projectId: ProjectId.make("project:effect-steer"),
      providerInstanceId: instanceId,
      title: "Steering",
      modelSelection: { instanceId, model: "gpt-5" },
      createdBy: "user",
      creationSource: "web",
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    attempts: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    messages: [],
    nodes: [],
    plans: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runs: [],
    runtimeRequests: [],
    subagents: [],
    turnItems: [],
    visibleTurnItems: [],
    updatedAt: now,
  };
}

function layerExecutorFor(input: {
  readonly events: Ref.Ref<ReadonlyArray<string>>;
  readonly cleanupThread?: ProjectionStore.ProjectionStoreV2Shape["getThread"];
  readonly attachmentIds?: ProjectionStore.ProjectionStoreV2Shape["getThreadAttachmentIds"];
  readonly cleanupAttachments?: (ids: ReadonlyArray<string>) => Effect.Effect<void>;
  readonly failFirstStart?: Ref.Ref<boolean>;
  readonly onStart?: ProviderTurnStartService.ProviderTurnStartServiceV2["Service"]["start"];
  readonly threads?: Partial<ThreadManagementService.ThreadManagementService["Service"]>;
  readonly continueAfterRestart?: boolean;
  readonly interrupt?: ProviderTurnControlService.ProviderTurnControlServiceV2Shape["interrupt"];
  readonly steer?: ProviderTurnControlService.ProviderTurnControlServiceV2Shape["steer"];
  readonly rollback?: CheckpointRollbackService.CheckpointRollbackServiceV2Shape["execute"];
  readonly respond?: RuntimeRequestService.RuntimeRequestServiceV2["Service"]["respond"];
}) {
  const record = (event: string) => Ref.update(input.events, (events) => [...events, event]);
  const layerDependencies = Layer.mergeAll(
    Layer.succeed(
      ProviderTurnControlService.ProviderTurnControlServiceV2,
      ProviderTurnControlService.ProviderTurnControlServiceV2.of({
        interrupt: input.interrupt ?? (() => Effect.void),
        steer: input.steer ?? (() => Effect.void),
        applyModelSelection: () => Effect.void,
        applyThreadTitle: () => Effect.void,
        interruptAndAwaitTerminal: (request) =>
          record(
            request.replacementProviderSessionId === undefined
              ? "interrupt"
              : `interrupt:${request.replacementProviderSessionId}`,
          ),
      }),
    ),
    Layer.succeed(
      ProviderSessionManager.ProviderSessionManagerV2,
      ProviderSessionManager.ProviderSessionManagerV2.of({
        shutdown: Effect.void,
        open: () => Effect.die("unused open"),
        get: () => Effect.succeedNone,
        isLive: () => Effect.succeed(false),
        close: () => Effect.void,
        closeInstance: () => Effect.void,
        release: () => record("release"),
        detach: () => record("detach"),
        otherWorkingThreads: () => Effect.succeed([]),
        releaseUnlessBusy: () => Effect.succeed(true),
        subscribePromptSuggestion: () => Stream.empty,
      }),
    ),
    Layer.succeed(
      ProviderTurnStartService.ProviderTurnStartServiceV2,
      ProviderTurnStartService.ProviderTurnStartServiceV2.of({
        failStartingRun: () => Effect.void,
        start: (request) =>
          Effect.gen(function* () {
            if (input.onStart !== undefined) yield* input.onStart(request);
            yield* record("start");
            if (
              input.failFirstStart !== undefined &&
              (yield* Ref.getAndSet(input.failFirstStart, false))
            ) {
              return yield* new ProviderTurnStartService.ProviderTurnStartError({
                runId,
                cause: "simulated first start failure",
              });
            }
          }),
      }),
    ),
    Layer.succeed(
      RunFinalizationService.RunFinalizationService,
      RunFinalizationService.RunFinalizationService.of({ finalize: () => Effect.void }),
    ),
    Layer.succeed(
      CheckpointRollbackService.CheckpointRollbackServiceV2,
      CheckpointRollbackService.CheckpointRollbackServiceV2.of({
        execute: input.rollback ?? (() => Effect.void),
      }),
    ),
    Layer.succeed(
      RuntimeRequestService.RuntimeRequestServiceV2,
      RuntimeRequestService.RuntimeRequestServiceV2.of({
        respond: input.respond ?? (() => Effect.void),
      }),
    ),
    Layer.succeed(
      ThreadTitleRegenerationService.ThreadTitleRegenerationService,
      ThreadTitleRegenerationService.ThreadTitleRegenerationService.of({
        execute: () => Effect.void,
      }),
    ),
  );
  return EffectWorker.layerExecutor.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerDependencies,
        Layer.mock(ThreadManagementService.ThreadManagementService)(input.threads ?? {}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          ...(input.cleanupThread === undefined ? {} : { getThread: input.cleanupThread }),
          ...(input.attachmentIds === undefined ? {} : { getThreadAttachmentIds: input.attachmentIds }),
          getThreadRecords: () => Effect.succeed({ runs: [] } as never),
          getMessagesById: () => Effect.succeed(new Map()),
        }),
        input.cleanupThread === undefined
          ? Layer.empty
          : Layer.succeed(ResourceCleanupService.ResourceCleanupService, {
              cleanupScheduledTasks: () => record("scheduled tasks"),
              cleanupTerminals: () => record("terminals"),
              cleanupDevices: () => record("devices"),
              cleanupPreviews: () => record("previews"),
              cleanupAttachments: input.cleanupAttachments ?? (() => record("attachments")),
            }),
        ServerSettings.layerTest(
          input.continueAfterRestart === true ? { continueThreadsAfterServerUpdate: true } : {},
        ),
      ),
    ),
  );
}

it.effect.each([
  "deleted", "recreated", "different-tombstone", "missing", "read-failed",
  "legacy-deleted", "legacy-newer-archived", "legacy-archived",
] as const)("guards delayed thread cleanup (%s)", (scenario) =>
  Effect.gen(function* () {
    const then = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
    const cut = DateTime.makeUnsafe("2026-01-01T00:01:00Z");
    const later = DateTime.makeUnsafe("2026-01-01T00:02:00Z");
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const current = steerFixtureProjection(threadId, then).thread;
    const deleted = scenario === "deleted" || scenario === "legacy-deleted";
    const newer = scenario === "recreated" || scenario === "different-tombstone" ||
      scenario === "legacy-newer-archived";
    const archived = scenario === "legacy-archived" || scenario === "legacy-newer-archived";
    const layer = layerExecutorFor({
      events,
      cleanupThread: () =>
        scenario === "missing"
          ? Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }))
          : scenario === "read-failed"
            ? Effect.fail(new ProjectionStore.ProjectionStoreReadError({ threadId, cause: "unavailable" }))
            : Effect.succeed({
                ...current,
                createdAt: newer ? later : then,
                deletedAt: deleted ? cut : scenario === "different-tombstone" ? later : null,
                archivedAt: archived ? later : null,
              }),
    });
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      const identity = scenario.startsWith("legacy-")
        ? {}
        : { deletedThreadCreatedAt: DateTime.formatIso(then) };
      const requests = [
        { type: "scheduled-tasks.cleanup", ...identity },
        { type: "terminal.cleanup", ...identity },
        { type: "preview.cleanup", ...identity },
        { type: "attachment.cleanup", attachmentIds: ["old-attachment"], ...identity },
      ] as const;
      for (const request of requests) {
        const result = yield* executor.execute({
          ...restartEffect(cut, { type: "detach" }),
          request,
        }, { willRetry: true }).pipe(Effect.exit);
        assert.equal(result._tag, scenario === "read-failed" ? "Failure" : "Success");
      }
      const cleaned = [...yield* Ref.get(events)].sort();
      assert.deepEqual(cleaned,
        deleted ? ["attachments", "devices", "previews", "scheduled tasks", "terminals"]
          : scenario === "legacy-archived" ? ["devices", "terminals"] : [],
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("cleans dismissed guest uploads on a live thread and keeps referenced files", () =>
  Effect.gen(function* () {
    const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = layerExecutorFor({
      events,
      cleanupThread: () => Effect.succeed(steerFixtureProjection(threadId, now).thread),
      attachmentIds: (id, options) => {
        assert.equal(id, threadId);
        assert.isTrue(options?.includeShownByLiveFork);
        return Effect.succeed(["still-referenced"]);
      },
      cleanupAttachments: (ids) => Ref.update(events, (current) => [...current, ...ids]),
    });
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      const commandId = CommandId.make("guest-dismissal");
      const effect = {
        ...restartEffect(now, { type: "detach" }),
        commandId,
        request: {
          type: "attachment.cleanup",
          attachmentIds: ["dismissed", "still-referenced"],
        },
      } as const;
      yield* executor.execute({
        ...effect,
        id: `effect:${commandId}:attachment.cleanup`,
      }, { willRetry: true });
      assert.deepEqual(yield* Ref.get(events), []);
      yield* executor.execute({
        ...effect,
        id: `effect:${commandId}:guest-attachment.cleanup`,
      }, { willRetry: true });
      assert.deepEqual(yield* Ref.get(events), ["dismissed"]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("passes the claimed lease only to routed idle starts and fences old restart effects", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Parameters<
      ProviderTurnStartService.ProviderTurnStartServiceV2["Service"]["start"]
    >[0]>>([]);
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = layerExecutorFor({
      events, onStart: (request) => Ref.update(calls, (list) => [...list, request]),
    });
    const normal = restartEffect(yield* DateTime.now, { type: "detach" });
    const idleRunId = RunId.make("run:route-idle:worker-test");
    const idle = {
      ...normal, id: "effect:idle", attemptCount: 1, leaseOwner: "claimed-worker",
      request: { type: "provider-turn.start", runId: idleRunId },
    } satisfies EffectOutbox.OrchestrationEffectV2;
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      yield* executor.execute(idle, { willRetry: true });
      yield* executor.execute({ ...idle, request: { type: "provider-turn.start", runId } }, { willRetry: true });
      if (normal.request.type !== "provider-turn.restart") return yield* Effect.die("expected restart fixture");
      yield* executor.execute({ ...normal, request: { ...normal.request, runId: idleRunId } });
      yield* executor.execute({ ...normal, request: { type: "provider-runtime.continue", sourceRunId: idleRunId } });
    }).pipe(Effect.provide(layer));
    assert.deepEqual(yield* Ref.get(calls), [
      {
        threadId: idle.threadId, runId: idleRunId, willRetry: false,
        workerClaim: { effectId: idle.id, leaseOwner: "claimed-worker", attemptCount: 1 },
      },
      { threadId: idle.threadId, runId, willRetry: true },
    ]);
    assert.deepEqual(yield* Ref.get(events), ["start", "start"]);
  }),
);

it.effect("fails a claimed routed idle effect without retrying it", () =>
  Effect.gen(function* () {
    const workerId = "worker-idle-once";
    const now = yield* DateTime.now;
    const idle = {
      ...restartEffect(now, { type: "detach" }),
      leaseOwner: workerId,
      attemptCount: 1,
      request: { type: "provider-turn.start", runId: RunId.make("run:route-idle:once") },
    } satisfies EffectOutbox.OrchestrationEffectV2;
    const failures = yield* Ref.make(0);
    const outbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeedSome(idle),
      get: () => Effect.succeedSome(idle),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      succeed: () => Effect.die("An uncertain start cannot succeed"),
      retry: () => Effect.die("A routed idle effect cannot retry"),
      fail: (input) => Effect.gen(function* () {
        assert.equal(input.effectId, idle.id);
        assert.equal(input.workerId, workerId);
        yield* Ref.update(failures, (count) => count + 1);
        return true;
      }),
    });
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const failFirstStart = yield* Ref.make(true);
    const layer = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(outbox, layerExecutorFor({ events, failFirstStart }))),
    );
    const worked = yield* Effect.gen(function* () {
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      return yield* worker.runOnce();
    }).pipe(Effect.provide(layer));
    assert.isTrue(worked);
    assert.equal(yield* Ref.get(failures), 1);
    assert.deepEqual(yield* Ref.get(events), ["start"]);
  }),
);

it.effect.each(["completed", "declined"] as const)(
  "keeps strict %s steering out of fallback while ordinary steering still dispatches",
  (reason) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const timestamp = DateTime.formatIso(now);
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const messageId = MessageId.make("message:effect-steer");
      const message = {
        id: messageId, runId, threadId, nodeId: null,
        role: "user" as const, text: "Message", attachments: [],
        createdBy: "user" as const, creationSource: "web" as const,
        streaming: false, createdAt: now, updatedAt: now,
      };
      const run = {
        id: runId, threadId, ordinal: 1, providerThreadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        userMessageId: messageId, rootNodeId: null, activeAttemptId: attemptId,
        status: "completed" as const, requestedAt: now, startedAt: now, completedAt: now,
        checkpointId: null, contextHandoffId: null,
      };
      const record = (event: string) => Ref.update(events, (all) => [...all, event]);
      const layer = layerExecutorFor({
        events,
        steer: (input) =>
          record(input.strictCommandFingerprint ?? "ordinary").pipe(
            Effect.andThen(new ProviderTurnControlService.ProviderTurnControlError({
              threadId, providerTurnId, operation: "steer",
              ...(reason === "completed" ? { turnCompleted: true } : { steerDeclined: true }),
            })),
          ),
        threads: {
          getThreadRecords: (id) => Effect.succeed({
            ...steerFixtureProjection(id, now),
            messages: [message],
            runs: [run],
          }),
          dispatch: (command) =>
            record(command.type === "message.dispatch" ? command.dispatchMode.type : command.type)
              .pipe(Effect.as({ sequence: 1, storedEvents: [] })),
        },
      });
      const ordinary: EffectOutbox.OrchestrationEffectV2 = {
        id: "effect:steer",
        commandId: CommandId.make("command:effect-steer"),
        threadId,
        request: {
          type: "provider-turn.steer",
          providerSessionId: oldSessionId,
          providerThreadId, providerTurnId, messageId,
        },
        status: "running", attemptCount: 1, availableAt: timestamp, leaseOwner: "test-worker",
        createdAt: timestamp, updatedAt: timestamp, completedAt: null, lastError: null,
      };
      yield* Effect.gen(function* () {
        const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
        const strict = {
          ...ordinary,
          id: `${ProviderTurnControlService.STRICT_STEER_EFFECT_PREFIX}fingerprint`,
        };
        assert.isTrue(Exit.isFailure(yield* Effect.exit(executor.execute(strict))));
        assert.isTrue(Exit.isFailure(yield* Effect.exit(executor.execute({ ...strict, attemptCount: 2 }))));
        assert.deepEqual(yield* Ref.get(events), ["fingerprint"]);
        yield* executor.execute(ordinary);
        assert.deepEqual(yield* Ref.get(events), [
          "fingerprint", "ordinary", reason === "completed" ? "start_immediately" : "queue_after_active",
        ]);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each([
  {
    name: "settles a stopped run when its adapter has already lost the native turn",
    unresponsive: false,
    dispatched: ["thread.background-work.settle"],
  },
  {
    name: "leaves the run running and flags the Stop when the provider never confirms it",
    unresponsive: true,
    dispatched: ["thread.interrupt.unresponsive"],
  },
])("$name", ({ unresponsive, dispatched }) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = layerExecutorFor({
      events,
      interrupt: () =>
        new ProviderTurnControlService.ProviderTurnControlError({
          threadId,
          operation: "interrupt",
          providerTurnId,
          ...(unresponsive ? { unresponsive } : {}),
          cause: unresponsive ? "Timed out." : "Provider turn is not active.",
        }),
      threads: {
        dispatch: (command) =>
          Ref.update(events, (current) => [...current, command.type]).pipe(
            Effect.as({ sequence: 1, storedEvents: [] }),
          ),
      },
    });
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      yield* executor.execute({
        ...restartEffect(now, { type: "detach" }),
        request: {
          type: "provider-turn.interrupt",
          providerSessionId: oldSessionId,
          providerThreadId,
          providerTurnId,
        },
      });
    }).pipe(Effect.provide(layer));
    assert.deepEqual(yield* Ref.get(events), dispatched);
  }),
);

const lockedIndexMessage =
  "Git's index is locked. Wait for other Git operations to finish, then try again.";
const rollbackCheckpointId = CheckpointId.make("checkpoint:effect-worker-rollback");
const rollbackScopeId = CheckpointScopeId.make("checkpoint-scope:effect-worker-rollback");
const restoreFailure = (detail: string) =>
  new CheckpointRollbackService.CheckpointRollbackExecutionError({
    reason: "unexpected-failure",
    threadId,
    providerThreadId,
    checkpointId: rollbackCheckpointId,
    cause: new CheckpointService.CheckpointRestoreError({
      scopeId: rollbackScopeId,
      checkpointId: rollbackCheckpointId,
      cause: new VcsProcessExitError({
        operation: "GitVcsDriverCore.restoreCheckpoint",
        command: "git",
        cwd: "/private/repo",
        exitCode: 128,
        detail,
        failureKind: "command-failed",
      }),
    }),
  });

it.effect.each([
  {
    name: "a held Git index lock",
    failure: restoreFailure(lockedIndexMessage),
    message: lockedIndexMessage,
  },
  {
    name: "raw Git output",
    failure: restoreFailure("error: could not clean /private/repo/secret.txt"),
    message: CheckpointRollbackService.ROLLBACK_FAILED_MESSAGE,
  },
])("reports a rollback blocked by $name only after the last attempt", ({ failure, message }) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const failures = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = layerExecutorFor({
      events: yield* Ref.make<ReadonlyArray<string>>([]),
      rollback: () => Effect.fail(failure),
      threads: {
        dispatch: (command) =>
          Ref.update(failures, (current) =>
            command.type === "checkpoint.rollback.fail" ? [...current, command.message] : current,
          ).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
      },
    });
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      const rollback: EffectOutbox.OrchestrationEffectV2 = {
        ...restartEffect(now, { type: "detach" }),
        request: {
          type: "provider-thread.rollback",
          providerThreadId,
          checkpointId: rollbackCheckpointId,
          scopeId: rollbackScopeId,
          restoreFiles: true,
        },
      };
      yield* Effect.flip(executor.execute(rollback, { willRetry: true }));
      assert.deepEqual(yield* Ref.get(failures), []);
      yield* Effect.flip(executor.execute(rollback, { willRetry: false }));
    }).pipe(Effect.provide(layer));
    assert.deepEqual(yield* Ref.get(failures), [message]);
  }),
);

it.effect("does not report an answer whose last delivery attempt is interrupted", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const reported = yield* Ref.make(0);
    const layer = layerExecutorFor({
      events: yield* Ref.make<ReadonlyArray<string>>([]),
      respond: () => Effect.interrupt,
      threads: {
        dispatch: (command) =>
          Ref.update(reported, (count) =>
            command.type === "runtime-request.delivery.fail" ? count + 1 : count,
          ).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
      },
    });
    const exit = yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      return yield* Effect.exit(
        executor.execute(
          {
            ...restartEffect(now, { type: "detach" }),
            request: {
              type: "runtime-request.respond",
              providerSessionId: oldSessionId,
              requestId: RuntimeRequestId.make("runtime-request:effect-worker-interrupted"),
              answers: { next: "Ship it" },
            },
          },
          { willRetry: false },
        ),
      );
    }).pipe(Effect.provide(layer));
    assert.isTrue(Exit.hasInterrupts(exit));
    assert.equal(yield* Ref.get(reported), 0);
  }),
);

it.effect("requeues a claim when a pre-execution worker check fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-pre-execution-failure";
    const workerId = "worker-pre-execution-failure";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-pre-execution-failure"),
      threadId: ThreadId.make("thread:worker-pre-execution-failure"),
      request: { type: "terminal.cleanup" },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const retries = yield* Ref.make<
      ReadonlyArray<{
        readonly effectId: string;
        readonly workerId: string;
        readonly error: string;
        readonly delayMs: number;
      }>
    >([]);
    const executionCount = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeedSome(claimedEffect),
      get: () =>
        Effect.fail(
          new EffectOutbox.EffectOutboxError({
            operation: "get",
            effectId,
            cause: "simulated cancellation-state read failure",
          }),
        ),
      retry: (input) =>
        Ref.update(retries, (existing) => [...existing, input]).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () => Ref.update(executionCount, (count) => count + 1),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce()),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.include(Cause.pretty(exit.cause), "simulated cancellation-state read failure");
    }
    assert.equal(yield* Ref.get(executionCount), 0);
    const retry = (yield* Ref.get(retries))[0];
    assert.isDefined(retry);
    assert.equal(retry.effectId, effectId);
    assert.equal(retry.workerId, workerId);
    assert.equal(retry.delayMs, 0);
    assert.include(retry.error, "simulated cancellation-state read failure");
  }),
);

it.effect("keeps requeueing a failed claim while the database is locked", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-requeue-lock-timeout";
    const workerId = "worker-requeue-lock-timeout";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-requeue-lock-timeout"),
      threadId,
      request: { type: "provider-runtime.continue", sourceRunId: runId },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const lockedWrites = yield* Ref.make(3);
    const requeued = yield* Ref.make(false);
    const firstLockTimeout = yield* Deferred.make<void>();
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeedSome(claimedEffect),
      get: () => Effect.succeedSome(claimedEffect),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      retry: () =>
        Effect.gen(function* () {
          if ((yield* Ref.getAndUpdate(lockedWrites, (count) => count - 1)) > 0) {
            yield* Deferred.succeed(firstLockTimeout, undefined);
            return yield* new EffectOutbox.EffectOutboxError({
              operation: "retry",
              effectId,
              cause: new SqlError.SqlError({
                reason: new SqlError.LockTimeoutError({ cause: null }),
              }),
            });
          }
          yield* Ref.set(requeued, true);
          return true;
        }),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () =>
          Effect.fail(
            new EffectWorker.OrchestrationEffectExecutionError({
              effectId,
              effectType: "provider-runtime.continue",
              cause: "simulated database is locked",
            }),
          ),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const workerFiber = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce()),
      Effect.provide(layerWorker),
      Effect.forkChild,
    );
    yield* Deferred.await(firstLockTimeout);
    yield* TestClock.adjust(Duration.millis(99));
    assert.isFalse(yield* Ref.get(requeued));
    yield* TestClock.adjust(Duration.seconds(1));
    yield* Effect.exit(Fiber.join(workerFiber));

    assert.isTrue(yield* Ref.get(requeued));
  }),
);

it.effect.each([
  { name: "requeue", request: { type: "provider-runtime.continue", sourceRunId: runId } },
  { name: "terminalize", request: { type: "provider-turn.start", runId } },
] as const)("interrupts $name settlement retries when the worker shuts down", ({ request }) =>
  Effect.gen(function* () {
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      ...restartEffect(yield* DateTime.now, { type: "detach" }),
      request,
    };
    const settlementStarted = yield* Deferred.make<void>();
    const releaseLock = yield* Ref.make(false);
    const lockedWrite = Effect.gen(function* () {
      yield* Deferred.succeed(settlementStarted, undefined);
      // An in-flight database write can finish its own wait before noticing shutdown.
      yield* Effect.sleep(Duration.millis(1));
      if (yield* Ref.get(releaseLock)) return true;
      return yield* new EffectOutbox.EffectOutboxError({
        operation: "settlement",
        effectId: claimedEffect.id,
        cause: new SqlError.SqlError({ reason: new SqlError.LockTimeoutError({ cause: null }) }),
      });
    });
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeedSome(claimedEffect),
      get: () => Effect.succeedSome(claimedEffect),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      succeed: () => Effect.fail(new EffectOutbox.EffectOutboxError({ operation: "succeed" })),
      retry: () => lockedWrite,
      fail: () => lockedWrite,
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({ execute: () => Effect.void }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId: "test-worker" }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const daemon = yield* EffectWorker.runDaemonWithOptions({ concurrency: 1 }).pipe(
      Effect.provide(layerWorker),
      Effect.forkChild,
    );
    yield* Deferred.await(settlementStarted);
    const shutdown = yield* Fiber.interrupt(daemon).pipe(
      Effect.timeoutOption(Duration.millis(100)),
      Effect.forkChild,
    );
    yield* TestClock.adjust(Duration.millis(100));
    const stopped = yield* Fiber.join(shutdown);
    yield* Ref.set(releaseLock, true);
    yield* TestClock.adjust(Duration.seconds(1));
    yield* Fiber.await(daemon);
    assert.isTrue(Option.isSome(stopped));
  }),
);

it.effect("arms cancellation before the durable pre-execution check", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-cancellation-registration-race";
    const workerId = "worker-cancellation-registration-race";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-cancellation-registration-race"),
      threadId: ThreadId.make("thread:worker-cancellation-registration-race"),
      request: { type: "terminal.cleanup" },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const signal = yield* Deferred.make<void>();
    let cancellationArmed = false;
    const executionCount = yield* Ref.make(0);
    const settlementCount = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeedSome(claimedEffect),
      awaitCancellation: () => {
        cancellationArmed = true;
        return Deferred.await(signal);
      },
      get: () =>
        Effect.gen(function* () {
          if (cancellationArmed) {
            yield* Deferred.succeed(signal, undefined);
          }
          return Option.some(claimedEffect);
        }),
      clearCancellation: () => Effect.void,
      succeed: () => Ref.update(settlementCount, (count) => count + 1).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () =>
          Effect.yieldNow.pipe(Effect.andThen(Ref.update(executionCount, (count) => count + 1))),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce()),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    if (Exit.isFailure(exit)) {
      assert.fail(Cause.pretty(exit.cause));
    }
    assert.equal(yield* Ref.get(executionCount), 0);
    assert.equal(yield* Ref.get(settlementCount), 0);
  }),
);

it.effect("terminalizes a process-bound claim when success settlement fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-process-bound-settlement-failure";
    const workerId = "worker-process-bound-settlement-failure";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-process-bound-settlement-failure"),
      threadId: ThreadId.make("thread:worker-process-bound-settlement-failure"),
      request: {
        type: "provider-turn.start",
        runId: RunId.make("run:worker-process-bound-settlement-failure"),
      },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const retries = yield* Ref.make(0);
    const terminalErrors = yield* Ref.make<ReadonlyArray<string>>([]);
    const executionCount = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeedSome(claimedEffect),
      get: () => Effect.succeedSome(claimedEffect),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      succeed: () =>
        Effect.fail(
          new EffectOutbox.EffectOutboxError({
            operation: "succeed",
            effectId,
            cause: "simulated success settlement failure",
          }),
        ),
      retry: () => Ref.update(retries, (count) => count + 1).pipe(Effect.as(true)),
      fail: ({ error }) =>
        Ref.update(terminalErrors, (existing) => [...existing, error]).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () => Ref.update(executionCount, (count) => count + 1),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce()),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    assert.equal(yield* Ref.get(executionCount), 1);
    assert.equal(yield* Ref.get(retries), 0);
    const terminalError = (yield* Ref.get(terminalErrors))[0];
    assert.isDefined(terminalError);
    assert.include(terminalError, "after execution started");
    assert.include(terminalError, "simulated success settlement failure");
  }),
);

it.effect("settles a delegated child once its restart continuation fails for good", () =>
  Effect.gen(function* () {
    const timestamp = DateTime.formatIso(yield* DateTime.now);
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const recovered = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const layer = layerExecutorFor({
      events,
      continueAfterRestart: true,
      threads: {
        getThreadRecords: () => Effect.fail(new Error("provider instance removed") as never),
        recoverDelegatedTask: (childThreadId) =>
          Ref.update(recovered, (ids) => [...ids, childThreadId]),
      },
    });
    const effect: EffectOutbox.OrchestrationEffectV2 = {
      id: `effect:restart-continuation:${runId}`,
      commandId: CommandId.make("command:restart-continuation-failure"),
      threadId,
      request: { type: "provider-runtime.continue", sourceRunId: runId },
      status: "running",
      attemptCount: 1,
      availableAt: timestamp,
      leaseOwner: "test-worker",
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      lastError: null,
    };
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(executor.execute(effect, { willRetry: true }))),
      );
      assert.deepEqual(yield* Ref.get(recovered), []);
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(executor.execute(effect, { willRetry: false }))),
      );
      assert.deepEqual(yield* Ref.get(recovered), [threadId]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each(["confirmed", "unconfirmed", "failed"] as const)(
  "a native subagent stop only repairs %s provider evidence",
  (outcome) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const layer = layerExecutorFor({
        events,
        interrupt: (input) => {
          assert.equal(input.subagent?.nativeTaskId, "native-task");
          return Ref.update(events, (current) => [...current, "stop-child"]).pipe(
            Effect.andThen(
              outcome === "failed"
                ? new ProviderTurnControlService.ProviderTurnControlError({
                    threadId,
                    providerTurnId,
                    operation: "interrupt",
                    cause: "SDK stop failed",
                  })
                : Effect.succeed(
                    outcome === "confirmed"
                      ? {
                          status: "cancelled" as const,
                          completedAt: now,
                          result: "Stopped by Claude",
                        }
                      : undefined,
                  ),
            ),
          );
        },
        threads: {
          dispatch: (command) => {
            assert.equal(command.type, "thread.background-work.settle");
            if (command.type === "thread.background-work.settle") {
              assert.equal(command.subagent?.id, "subagent");
              assert.deepEqual(command.subagent?.outcome, {
                status: "cancelled",
                completedAt: now,
                result: "Stopped by Claude",
              });
            }
            return Ref.update(events, (current) => [...current, "settle-child"]).pipe(
              Effect.as({ sequence: 1, storedEvents: [] }),
            );
          },
        },
      });
      const execution = yield* Effect.gen(function* () {
        const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
        yield* executor.execute({
          ...restartEffect(now, { type: "detach" }),
          request: {
            type: "provider-turn.interrupt",
            providerSessionId: oldSessionId,
            providerThreadId,
            providerTurnId,
            subagent: { id: NodeId.make("subagent"), nativeTaskId: "native-task" },
          },
        });
      }).pipe(Effect.provide(layer), Effect.exit);
      assert.equal(Exit.isFailure(execution), outcome === "failed");
      assert.deepEqual(
        yield* Ref.get(events),
        outcome === "confirmed" ? ["stop-child", "settle-child"] : ["stop-child"],
      );
    }),
);

it.effect.each([3, 4])(
  "enforces process-loss count %s after 22 minutes through the executor",
  (processLossCount) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const instanceId = ProviderInstanceId.make("codex");
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const layer = layerExecutorFor({
        events,
        continueAfterRestart: true,
        threads: {
          getThreadRecords: () =>
            Effect.succeed({
              thread: {
                id: threadId,
                projectId: ProjectId.make("project:executor-recovery"),
                providerInstanceId: instanceId,
                archivedAt: null,
                deletedAt: null,
                lineage: { parentThreadId: null, relationshipToParent: null },
              },
              runs: [
                {
                  id: runId,
                  providerInstanceId: instanceId,
                  status: "cancelled",
                  requestedAt: DateTime.subtract(now, { minutes: 22 }),
                  completedAt: now,
                  ordinal: 1,
                },
              ],
              messages: [],
              providerTurns: [],
              runtimeRequests: [],
              turnItems: [],
              attempts: [],
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: () =>
            Ref.update(events, (entries) => [...entries, "dispatch"]).pipe(Effect.as({} as never)),
          recoverDelegatedTask: () =>
            Ref.update(events, (entries) => [...entries, "recover-child"]),
        },
      });
      yield* Effect.gen(function* () {
        const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
        yield* executor.execute({
          ...restartEffect(now, { type: "detach" }),
          request: { type: "provider-runtime.continue", sourceRunId: runId, processLossCount },
        });
      }).pipe(Effect.provide(layer));
      assert.deepEqual(
        yield* Ref.get(events),
        processLossCount > 3 ? ["recover-child"] : ["dispatch", "recover-child"],
      );
    }),
);
