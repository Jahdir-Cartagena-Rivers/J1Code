import {
  AGENT_DELEGATION_ACTIVITY_KIND,
  AGENT_DELEGATION_MAX_ACTIVE,
  AGENT_DELEGATION_MAX_DEPTH,
  AGENT_DELEGATION_MAX_TOTAL,
  AgentDelegationError,
  AgentDelegationRecord,
  type AgentDelegationResult,
  type AgentDelegationStatus,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  SpawnAgentInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import { type McpInvocationScope } from "./McpInvocationContext.ts";

const active = (status: AgentDelegationStatus) =>
  status === "starting" || status === "running" || status === "waiting";
const failure = (message: string) => new AgentDelegationError({ message });
const wrapFailure = (cause: Cause.Cause<unknown>) => failure(Cause.pretty(cause).slice(0, 2000));
const OUTPUT_LIMIT = 24_000;
const decodeRecord = Schema.decodeUnknownEffect(AgentDelegationRecord);
const encodeSpawn = Schema.encodeEffect(Schema.fromJsonString(SpawnAgentInput));

interface Job {
  record: AgentDelegationRecord;
  changed: Deferred.Deferred<void>;
  timer?: Fiber.Fiber<void, never> | undefined;
}

export class AgentDelegation extends Context.Service<
  AgentDelegation,
  {
    readonly models: (invocation: McpInvocationScope) => Effect.Effect<
      {
        providers: ReadonlyArray<{
          instanceId: string;
          driver: string;
          name: string;
          enabled: boolean;
          available: boolean;
          authStatus: string;
          models: ReadonlyArray<{ model: string; name: string }>;
        }>;
        limits: { maxDepth: number; maxActivePerLead: number; maxWorkersPerTurn: number };
      },
      AgentDelegationError
    >;
    readonly spawn: (
      input: SpawnAgentInput,
      invocation: McpInvocationScope,
    ) => Effect.Effect<AgentDelegationResult, AgentDelegationError>;
    readonly get: (
      threadId: ThreadId,
      invocation: McpInvocationScope,
    ) => Effect.Effect<AgentDelegationResult, AgentDelegationError>;
    readonly list: (
      invocation: McpInvocationScope,
    ) => Effect.Effect<ReadonlyArray<AgentDelegationResult>, AgentDelegationError>;
    readonly wait: (
      threadId: ThreadId,
      seconds: number,
      invocation: McpInvocationScope,
    ) => Effect.Effect<AgentDelegationResult, AgentDelegationError>;
    readonly cancel: (
      threadId: ThreadId,
      invocation: McpInvocationScope,
    ) => Effect.Effect<AgentDelegationResult, AgentDelegationError>;
  }
>()("t3/mcp/AgentDelegation") {}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const providers = yield* ProviderService;
  const registry = yield* ProviderRegistry;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Scope.Scope;
  const mutex = yield* Semaphore.make(1);
  const jobs = new Map<ThreadId, Job>();
  const blockedParents = new Set<ThreadId>();
  const ready = yield* Deferred.make<void, AgentDelegationError>();
  const events = yield* engine.subscribeDomainEvents;
  const timestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const dispatch = (command: OrchestrationCommand) => engine.dispatch(command);

  const append = Effect.fn("AgentDelegation.append")(function* (
    threadId: ThreadId,
    kind: string,
    summary: string,
    payload: unknown,
    tone: "info" | "error" = "info",
  ) {
    const id = yield* uuid;
    const now = yield* timestamp;
    yield* dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`delegation:${id}`),
      threadId,
      createdAt: now,
      activity: {
        id: EventId.make(id),
        kind,
        summary,
        payload,
        tone,
        turnId: null,
        createdAt: now,
      },
    });
  });

  const persist = Effect.fn("AgentDelegation.persist")(function* (job: Job, initial = false) {
    const record = job.record;
    // The child retains its linkage even if its lead is archived or deleted.
    const child = yield* snapshots.getThreadShellById(record.threadId);
    if (Option.isSome(child))
      yield* append(
        record.threadId,
        AGENT_DELEGATION_ACTIVITY_KIND,
        `Worker ${record.status}: ${record.title}`,
        record,
      );
    const parent = yield* snapshots.getThreadShellById(record.parentThreadId);
    if (Option.isNone(parent)) return;
    yield* append(
      record.parentThreadId,
      AGENT_DELEGATION_ACTIVITY_KIND,
      `Worker ${record.status}: ${record.title}`,
      record,
    );
    yield* append(
      record.parentThreadId,
      initial ? "task.started" : "task.updated",
      `Worker ${record.status}: ${record.title}`,
      {
        taskId: record.threadId,
        agentKind: "agent",
        title: record.title,
        role: "Delegated worker",
        model: record.modelSelection.model,
        status:
          record.status === "timed-out"
            ? "failed"
            : record.status === "starting"
              ? "pending"
              : record.status,
        error: record.error,
        detail: record.error ?? `Open worker chat: ${record.title}`,
      },
      record.error ? "error" : "info",
    );
  });

  const change = Effect.fn("AgentDelegation.change")(function* (
    job: Job,
    status: AgentDelegationStatus,
    error: string | null = null,
  ) {
    if (job.record.status === status && job.record.error === error) return;
    if (!active(job.record.status)) return;
    job.record = { ...job.record, status, error, updatedAt: yield* timestamp };
    yield* persist(job);
    const previous = job.changed;
    job.changed = yield* Deferred.make<void>();
    yield* Deferred.succeed(previous, undefined);
    if (!active(status) && job.timer) yield* Fiber.interrupt(job.timer);
  });

  const stopTree = Effect.fn("AgentDelegation.stopTree")(function* (
    threadId: ThreadId,
    status: "cancelled" | "timed-out" | "interrupted",
    reason: string,
  ): Effect.fn.Return<void, OrchestrationDispatchError | ProjectionRepositoryError> {
    blockedParents.add(threadId);
    for (const child of jobs.values()) {
      if (child.record.parentThreadId === threadId && active(child.record.status)) {
        yield* stopTree(child.record.threadId, status, reason).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Could not persist a descendant stop", { cause }),
          ),
        );
      }
    }
    const job = jobs.get(threadId);
    if (!job || !active(job.record.status)) return;
    // Persist the stop before enqueueing it so a delayed turn cannot resurrect the worker.
    yield* change(job, status, reason).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const child = yield* snapshots.getThreadShellById(threadId);
          if (Option.isSome(child)) {
            yield* dispatch({
              type: "thread.session.stop",
              commandId: CommandId.make(`delegation-stop:${yield* uuid}`),
              threadId,
              createdAt: yield* timestamp,
            });
          } else {
            yield* providers.stopSession({ threadId });
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Worker stop could not be queued; stopping its session directly", {
              cause,
            }).pipe(
              Effect.andThen(
                providers.stopSession({ threadId }).pipe(Effect.ignore({ log: true })),
              ),
            ),
          ),
        ),
      ),
    );
  });

  const startTimer = Effect.fn("AgentDelegation.startTimer")(function* (job: Job) {
    const delay = Math.max(0, Date.parse(job.record.deadlineAt) - (yield* Clock.currentTimeMillis));
    // Clear this handle before taking the lock; change must never interrupt its own timer.
    job.timer = yield* Effect.sleep(delay).pipe(
      Effect.andThen(
        Effect.sync(() => {
          job.timer = undefined;
        }),
      ),
      Effect.andThen(
        mutex.withPermits(1)(
          stopTree(job.record.threadId, "timed-out", "Worker deadline exceeded."),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logError("Could not stop expired delegated worker", { cause }),
      ),
      Effect.forkIn(scope),
    );
  });

  const result = Effect.fn("AgentDelegation.result")(function* (
    job: Job,
  ): Effect.fn.Return<AgentDelegationResult, AgentDelegationError> {
    const detail = yield* snapshots
      .getThreadDetailById(job.record.threadId)
      .pipe(Effect.catchCause((cause) => Effect.fail(wrapFailure(cause))));
    const text = Option.isSome(detail)
      ? detail.value.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.text)
          .join("\n\n")
      : "";
    return {
      threadId: job.record.threadId,
      parentThreadId: job.record.parentThreadId,
      title: job.record.title,
      modelSelection: job.record.modelSelection,
      status: job.record.status,
      deadlineAt: job.record.deadlineAt,
      output: text.slice(-OUTPUT_LIMIT),
      outputTruncated: text.length > OUTPUT_LIMIT,
      error: job.record.error,
    };
  });

  const requireParent = Effect.fn("AgentDelegation.requireParent")(function* (
    invocation: McpInvocationScope,
  ) {
    const parent = yield* snapshots.getThreadShellById(invocation.threadId);
    if (
      Option.isNone(parent) ||
      parent.value.archivedAt !== null ||
      blockedParents.has(invocation.threadId)
    ) {
      return yield* failure("The lead chat is unavailable or stopped.");
    }
    const session = parent.value.session;
    if (
      !session ||
      session.providerInstanceId !== invocation.providerInstanceId ||
      (session.status !== "ready" && session.status !== "running")
    ) {
      return yield* failure("This credential is no longer bound to an active lead session.");
    }
    const job = jobs.get(invocation.threadId);
    if (job && !active(job.record.status)) return yield* failure("This worker has already ended.");
    return parent.value;
  });

  const owned = (invocation: McpInvocationScope, id: ThreadId) => {
    const job = jobs.get(id);
    return job &&
      (job.record.parentThreadId === invocation.threadId ||
        job.record.rootThreadId === invocation.threadId)
      ? job
      : undefined;
  };

  const reconcile = Effect.fn("AgentDelegation.reconcile")(function* (event: OrchestrationEvent) {
    if (!("threadId" in event.payload)) return;
    const id = event.payload.threadId;
    if (event.type === "thread.turn-start-requested" && !jobs.has(id)) blockedParents.delete(id);
    if (
      event.type === "thread.turn-interrupt-requested" ||
      event.type === "thread.session-stop-requested" ||
      event.type === "thread.deleted" ||
      event.type === "thread.archived"
    ) {
      yield* stopTree(id, "cancelled", "Lead or worker was stopped.");
      return;
    }
    const job = jobs.get(id);
    if (
      event.type === "thread.session-set" &&
      event.payload.session.status === "error" &&
      job &&
      active(job.record.status)
    ) {
      yield* change(job, "failed", event.payload.session.lastError ?? "Worker provider failed.");
      yield* stopTree(id, "interrupted", "Worker provider failed.");
      yield* dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make(`delegation-failed-stop:${yield* uuid}`),
        threadId: id,
        createdAt: yield* timestamp,
      });
      return;
    }
    if (
      event.type === "thread.session-set" &&
      ["stopped", "interrupted", "error"].includes(event.payload.session.status)
    ) {
      yield* stopTree(
        id,
        "interrupted",
        event.payload.session.lastError ?? "Lead or worker session ended.",
      );
      return;
    }
    if (!job || !active(job.record.status)) return;
    if (
      event.type !== "thread.session-set" &&
      event.type !== "thread.turn-diff-completed" &&
      event.type !== "thread.activity-appended"
    )
      return;
    if (
      event.type === "thread.activity-appended" &&
      (event.payload.activity.kind === AGENT_DELEGATION_ACTIVITY_KIND ||
        event.payload.activity.kind.startsWith("task."))
    )
      return;
    const child = yield* snapshots.getThreadShellById(id);
    if (Option.isNone(child)) return;
    const thread = child.value;
    if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
      yield* change(job, "failed", thread.session?.lastError ?? "Worker provider failed.");
    } else if (thread.session?.status === "interrupted" || thread.session?.status === "stopped") {
      yield* stopTree(id, "interrupted", "Worker session ended before its result was collected.");
    } else if (
      event.type === "thread.turn-diff-completed" &&
      thread.latestTurn?.state === "completed"
    ) {
      yield* change(job, "completed");
      // The saved chat remains available; an idle worker must not retain a provider process.
      yield* dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make(`delegation-complete-stop:${yield* uuid}`),
        threadId: id,
        createdAt: yield* timestamp,
      });
    } else if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
      yield* change(job, "waiting");
    } else if (thread.session?.status === "running") {
      yield* change(job, "running");
    }
  });

  const initialize = Effect.gen(function* () {
    const startup = yield* Effect.serviceOption(ServerRuntimeStartup);
    if (Option.isSome(startup)) yield* startup.value.awaitCommandReady;
    const records = yield* snapshots.listActivitiesByKind(AGENT_DELEGATION_ACTIVITY_KIND);
    for (const activity of records) {
      const record = yield* decodeRecord(activity.payload);
      const previous = jobs.get(record.threadId);
      if (!previous || record.updatedAt >= previous.record.updatedAt) {
        jobs.set(record.threadId, { record, changed: yield* Deferred.make<void>() });
      }
    }
    // Recovery never resends a task. A crash may have left real provider work running.
    for (const job of jobs.values()) {
      if (!active(job.record.status)) continue;
      const detail = yield* snapshots.getThreadDetailById(job.record.threadId);
      if (
        Option.isSome(detail) &&
        detail.value.latestTurn?.state === "completed" &&
        detail.value.checkpoints.some(
          (checkpoint) => checkpoint.turnId === detail.value.latestTurn?.turnId,
        )
      ) {
        yield* change(job, "completed");
      } else {
        yield* stopTree(
          job.record.threadId,
          "interrupted",
          "Server restarted. History preserved; this task was not automatically rerun.",
        );
      }
    }
    yield* Deferred.succeed(ready, undefined);
  }).pipe(Effect.catchCause((cause) => Deferred.fail(ready, wrapFailure(cause))));

  yield* initialize.pipe(Effect.forkIn(scope));
  yield* Stream.runForEach(events, (event) =>
    Deferred.await(ready).pipe(
      Effect.andThen(mutex.withPermits(1)(reconcile(event))),
      Effect.catchCause((cause) =>
        Effect.logError("Delegation lifecycle update failed", { cause }),
      ),
    ),
  ).pipe(Effect.forkIn(scope));

  const authorize = (invocation: McpInvocationScope) =>
    invocation.capabilities.has("agents")
      ? Deferred.await(ready)
      : Effect.fail(failure("This session has no agent delegation capability."));

  const inspect = Effect.fn("AgentDelegation.inspect")(
    function* (id: ThreadId, invocation: McpInvocationScope) {
      yield* authorize(invocation);
      const job = owned(invocation, id);
      if (!job) return yield* failure("This worker does not belong to your lead chat.");
      return yield* result(job);
    },
    Effect.catchCause((cause) => Effect.fail(wrapFailure(cause))),
  );

  return AgentDelegation.of({
    models: (invocation) =>
      authorize(invocation).pipe(
        Effect.andThen(registry.getProviders),
        Effect.map((list) => ({
          providers: list.map((provider) => ({
            instanceId: provider.instanceId,
            driver: provider.driver,
            name: provider.displayName ?? provider.driver,
            enabled: provider.enabled,
            available: provider.availability !== "unavailable" && provider.installed,
            authStatus: provider.auth.status,
            models: provider.models.map((model) => ({ model: model.slug, name: model.name })),
          })),
          limits: {
            maxDepth: AGENT_DELEGATION_MAX_DEPTH,
            maxActivePerLead: AGENT_DELEGATION_MAX_ACTIVE,
            maxWorkersPerTurn: AGENT_DELEGATION_MAX_TOTAL,
          },
        })),
      ),
    spawn: Effect.fn("AgentDelegation.spawn")(
      function* (input, invocation) {
        yield* authorize(invocation);
        return yield* mutex.withPermits(1)(
          Effect.gen(function* () {
            const parent: OrchestrationThreadShell = yield* requireParent(invocation);
            const parentJob = jobs.get(parent.id);
            const depth = (parentJob?.record.depth ?? 0) + 1;
            if (depth > AGENT_DELEGATION_MAX_DEPTH)
              return yield* failure("Worker delegation depth limit reached.");
            const rootThreadId = parentJob?.record.rootThreadId ?? parent.id;
            const rootTurnKey =
              parentJob?.record.rootTurnKey ??
              parent.latestTurn?.turnId ??
              parent.session?.activeTurnId ??
              invocation.providerSessionId;
            const encoded = yield* encodeSpawn(input);
            const fingerprintBytes = yield* crypto.digest(
              "SHA-256",
              new TextEncoder().encode(encoded),
            );
            const fingerprint = Buffer.from(fingerprintBytes).toString("hex");
            const existing = [...jobs.values()].find(
              (job) =>
                job.record.parentThreadId === parent.id && job.record.requestId === input.requestId,
            );
            if (existing) {
              if (existing.record.fingerprint !== fingerprint)
                return yield* failure("This requestId was already used for a different task.");
              return yield* result(existing);
            }
            const family = [...jobs.values()].filter(
              (job) => job.record.rootThreadId === rootThreadId,
            );
            if (
              family.filter((job) => active(job.record.status)).length >=
                AGENT_DELEGATION_MAX_ACTIVE ||
              [...jobs.values()].filter((job) => active(job.record.status)).length >= 16
            ) {
              return yield* failure(
                "Active worker limit reached. Wait for or cancel an existing worker.",
              );
            }
            if (
              family.filter((job) => job.record.rootTurnKey === rootTurnKey).length >=
              AGENT_DELEGATION_MAX_TOTAL
            )
              return yield* failure("Worker budget for this lead turn is exhausted.");
            const available = (yield* registry.getProviders).find(
              (provider) => provider.instanceId === input.modelSelection.instanceId,
            );
            if (
              !available ||
              !available.enabled ||
              !available.installed ||
              available.availability === "unavailable"
            )
              return yield* failure("That provider instance is not enabled and available.");
            if (!available.models.some((model) => model.slug === input.modelSelection.model))
              return yield* failure(
                "Unknown model slug. Use list_agent_models to select a configured model.",
              );
            const routing = yield* providers.getInstanceInfo(input.modelSelection.instanceId);
            if (!routing.enabled) return yield* failure("That provider instance is disabled.");
            const id = ThreadId.make(`j1-agent:${yield* uuid}`);
            const now = yield* timestamp;
            const deadline = Math.min(
              Date.parse(now) + (input.timeoutSeconds ?? 600) * 1000,
              parentJob ? Date.parse(parentJob.record.deadlineAt) : Infinity,
            );
            const record: AgentDelegationRecord = {
              version: 1,
              parentThreadId: parent.id,
              rootThreadId,
              rootTurnKey,
              threadId: id,
              requestId: input.requestId,
              fingerprint,
              title: input.title,
              modelSelection: input.modelSelection,
              depth,
              status: "starting",
              createdAt: now,
              deadlineAt: DateTime.formatIso(DateTime.makeUnsafe(deadline)),
              updatedAt: now,
              error: null,
            };
            yield* dispatch({
              type: "thread.create",
              commandId: CommandId.make(`delegation-create:${id}`),
              threadId: id,
              projectId: parent.projectId,
              title: `Worker: ${input.title}`,
              modelSelection: input.modelSelection,
              runtimeMode: parent.runtimeMode,
              interactionMode: "default",
              branch: parent.branch,
              worktreePath: parent.worktreePath,
              createdAt: now,
            });
            const job: Job = { record, changed: yield* Deferred.make<void>() };
            jobs.set(id, job);
            yield* Effect.gen(function* () {
              yield* persist(job, true);
              yield* dispatch({
                type: "thread.turn.start",
                commandId: CommandId.make(`delegation-start:${id}`),
                threadId: id,
                message: {
                  messageId: MessageId.make(`delegation-task:${id}`),
                  role: "user",
                  attachments: [],
                  text: `You are a delegated worker for lead chat ${parent.id}. Your task is below. Work only within its scope, respect project instructions and return your findings, changes, validation and limitations. You share the lead's workspace; coordinate file ownership before parallel edits. Do not claim verification you did not perform.\n\n${input.task}`,
                },
                modelSelection: input.modelSelection,
                runtimeMode: parent.runtimeMode,
                interactionMode: "default",
                createdAt: now,
              });
              yield* startTimer(job);
            }).pipe(
              Effect.catchCause((cause) =>
                change(job, "failed", Cause.pretty(cause).slice(0, 2000)),
              ),
            );
            return yield* result(job);
          }),
        );
      },
      Effect.catchCause((cause) => Effect.fail(wrapFailure(cause))),
    ),
    get: inspect,
    list: (invocation) =>
      Effect.gen(function* () {
        yield* authorize(invocation);
        return yield* Effect.forEach(
          [...jobs.keys()].filter((id) => owned(invocation, id)),
          (id) => result(jobs.get(id)!),
        );
      }),
    wait: Effect.fn("AgentDelegation.wait")(function* (id, seconds, invocation) {
      yield* authorize(invocation);
      const job = owned(invocation, id);
      if (!job) return yield* failure("This worker does not belong to your lead chat.");
      if (active(job.record.status) && job.record.status !== "waiting") {
        yield* Deferred.await(job.changed).pipe(
          Effect.timeoutOption(Math.min(60, Math.max(1, seconds)) * 1000),
        );
      }
      return yield* result(job);
    }),
    cancel: Effect.fn("AgentDelegation.cancel")(
      function* (id, invocation) {
        yield* authorize(invocation);
        const job = owned(invocation, id);
        if (!job) return yield* failure("This worker does not belong to your lead chat.");
        yield* mutex.withPermits(1)(stopTree(id, "cancelled", "Cancelled by the lead."));
        return yield* result(job);
      },
      Effect.catchCause((cause) => Effect.fail(wrapFailure(cause))),
    ),
  });
});

export const AgentDelegationLive = Layer.effect(AgentDelegation, make);
