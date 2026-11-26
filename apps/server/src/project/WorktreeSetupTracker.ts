import type {
  ThreadId,
  WorktreeSetupSnapshot,
  WorktreeSetupStage,
  WorktreeSetupStageId,
  WorktreeSetupStageStatus,
} from "@j1code/contracts";
import {
  WORKTREE_SETUP_DETAIL_MAX_LENGTH,
  WORKTREE_SETUP_ERROR_MAX_LENGTH,
  WORKTREE_SETUP_STAGE_ORDER,
  WORKTREE_SETUP_TAIL_LINE_MAX_LENGTH,
} from "@j1code/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

export class WorktreeSetupTracker extends Context.Service<
  WorktreeSetupTracker,
  {
    readonly begin: (input: {
      readonly threadId: ThreadId;
      readonly branch: string | null;
      readonly baseRef: string | null;
      readonly stages: ReadonlyArray<WorktreeSetupStageId>;
      readonly fiber: Fiber.Fiber<unknown, unknown> | null;
    }) => Effect.Effect<void>;
    readonly update: (
      threadId: ThreadId,
      mutate: (snapshot: WorktreeSetupSnapshot) => WorktreeSetupSnapshot,
    ) => Effect.Effect<void>;
    readonly stage: (
      threadId: ThreadId,
      stageId: WorktreeSetupStageId,
      patch: Partial<Omit<WorktreeSetupStage, "id">>,
    ) => Effect.Effect<void>;
    readonly stageStatus: (
      threadId: ThreadId,
      stageId: WorktreeSetupStageId,
      status: WorktreeSetupStageStatus,
      detail?: string | null,
    ) => Effect.Effect<void>;
    readonly appendTail: (
      threadId: ThreadId,
      stageId: WorktreeSetupStageId,
      line: string,
    ) => Effect.Effect<void>;
    readonly finish: (
      threadId: ThreadId,
      phase: "done" | "failed" | "cancelled",
      error?: string | null,
    ) => Effect.Effect<WorktreeSetupSnapshot | null>;
    /** Claims the transition to agent release unless cancellation already claimed the setup. */
    readonly markUncancellable: (threadId: ThreadId) => Effect.Effect<boolean>;
    readonly cancel: (threadId: ThreadId) => Effect.Effect<boolean>;
    readonly get: (threadId: ThreadId) => Effect.Effect<WorktreeSetupSnapshot | null>;
    readonly stream: (threadId: ThreadId) => Stream.Stream<WorktreeSetupSnapshot | null>;
  }
>()("@j1code/server/project/WorktreeSetupTracker") {}

const TAIL_LINE_LIMIT = 4;

function clampText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}\u2026`;
}

const clampDetail = (detail: string | null): string | null =>
  detail === null ? null : clampText(detail, WORKTREE_SETUP_DETAIL_MAX_LENGTH);
const FINISHED_RETENTION = "30 seconds";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

interface TrackedSetup {
  readonly snapshot: WorktreeSetupSnapshot;
  readonly fiber: Fiber.Fiber<unknown, unknown> | null;
}

function emptyStage(id: WorktreeSetupStageId): WorktreeSetupStage {
  return {
    id,
    status: "pending",
    startedAt: null,
    endedAt: null,
    percent: null,
    detail: null,
    tail: [],
  };
}

export const make = Effect.gen(function* () {
  const setups = yield* Ref.make(new Map<ThreadId, TrackedSetup>());
  const changes = yield* PubSub.unbounded<{
    readonly threadId: ThreadId;
    readonly snapshot: WorktreeSetupSnapshot | null;
  }>();
  const retentionFibers = new Map<ThreadId, Fiber.Fiber<void, never>>();
  // Keep sequences increasing across setups so existing subscribers accept the next setup's first snapshot.
  const lastSequenceByThread = new Map<ThreadId, number>();

  const publish = (threadId: ThreadId, snapshot: WorktreeSetupSnapshot | null) =>
    PubSub.publish(changes, { threadId, snapshot }).pipe(Effect.asVoid);

  const modify = (
    threadId: ThreadId,
    mutate: (tracked: TrackedSetup) => TrackedSetup,
  ): Effect.Effect<WorktreeSetupSnapshot | null> =>
    Ref.modify(setups, (current) => {
      const existing = current.get(threadId);
      if (!existing || existing.snapshot.phase !== "running") return [null, current] as const;
      const nextTracked = mutate(existing);
      const nextSnapshot = {
        ...nextTracked.snapshot,
        sequence: existing.snapshot.sequence + 1,
      };
      lastSequenceByThread.set(threadId, nextSnapshot.sequence);
      const next = new Map(current);
      next.set(threadId, { ...nextTracked, snapshot: nextSnapshot });
      return [nextSnapshot, next] as const;
    }).pipe(Effect.tap((snapshot) => (snapshot ? publish(threadId, snapshot) : Effect.void)));

  const clearRetention = (threadId: ThreadId) => {
    const fiber = retentionFibers.get(threadId);
    retentionFibers.delete(threadId);
    return fiber ? Fiber.interrupt(fiber).pipe(Effect.ignore) : Effect.void;
  };

  const remove = (threadId: ThreadId, finished: WorktreeSetupSnapshot) =>
    Ref.modify(setups, (current) => {
      if (current.get(threadId)?.snapshot !== finished) return [false, current] as const;
      const next = new Map(current);
      next.delete(threadId);
      lastSequenceByThread.delete(threadId);
      return [true, next] as const;
    }).pipe(Effect.flatMap((removed) => removed ? publish(threadId, null) : Effect.void));

  const begin: WorktreeSetupTracker["Service"]["begin"] = Effect.fn("WorktreeSetupTracker.begin")(
    function* (input) {
      yield* clearRetention(input.threadId);
      const startedAt = yield* nowIso;
      const ordered = WORKTREE_SETUP_STAGE_ORDER.filter((id) => input.stages.includes(id));
      const snapshot: WorktreeSetupSnapshot = {
        threadId: input.threadId,
        phase: "running",
        startedAt,
        endedAt: null,
        branch: input.branch,
        baseRef: input.baseRef,
        worktreePath: null,
        setupScript: null,
        stages: ordered.map(emptyStage),
        error: null,
        sequence: (lastSequenceByThread.get(input.threadId) ?? -1) + 1,
      };
      lastSequenceByThread.set(input.threadId, snapshot.sequence);
      yield* Ref.update(setups, (current) => {
        const next = new Map(current);
        next.set(input.threadId, { snapshot, fiber: input.fiber });
        return next;
      });
      yield* publish(input.threadId, snapshot);
    },
  );

  const update: WorktreeSetupTracker["Service"]["update"] = (threadId, mutate) =>
    modify(threadId, (tracked) => ({ ...tracked, snapshot: mutate(tracked.snapshot) })).pipe(
      Effect.asVoid,
    );

  const stage: WorktreeSetupTracker["Service"]["stage"] = (threadId, stageId, patch) =>
    update(threadId, (snapshot) => ({
      ...snapshot,
      stages: snapshot.stages.map((entry) =>
        entry.id === stageId
          ? {
              ...entry,
              ...patch,
              ...(patch.detail === undefined ? {} : { detail: clampDetail(patch.detail ?? null) }),
            }
          : entry,
      ),
    }));

  const stageStatus: WorktreeSetupTracker["Service"]["stageStatus"] = (
    threadId,
    stageId,
    status,
    detail,
  ) =>
    nowIso.pipe(
      Effect.flatMap((at) =>
        update(threadId, (snapshot) => ({
          ...snapshot,
          stages: snapshot.stages.map((entry) => {
            if (entry.id !== stageId) return entry;
            const startedAt = entry.startedAt ?? (status === "pending" ? null : at);
            const endedAt =
              status === "running" || status === "pending" ? null : (entry.endedAt ?? at);
            return {
              ...entry,
              status,
              startedAt,
              endedAt,
              ...(detail === undefined ? {} : { detail: clampDetail(detail ?? null) }),
            };
          }),
        })),
      ),
    );

  const appendTail: WorktreeSetupTracker["Service"]["appendTail"] = (threadId, stageId, line) =>
    update(threadId, (snapshot) => ({
      ...snapshot,
      stages: snapshot.stages.map((entry) =>
        entry.id === stageId
          ? {
              ...entry,
              tail: [...entry.tail, clampText(line, WORKTREE_SETUP_TAIL_LINE_MAX_LENGTH)].slice(
                -TAIL_LINE_LIMIT,
              ),
            }
          : entry,
      ),
    }));

  const finish: WorktreeSetupTracker["Service"]["finish"] = Effect.fn(
    "WorktreeSetupTracker.finish",
  )(function* (threadId, phase, error) {
    const endedAt = yield* nowIso;
    const snapshot = yield* modify(threadId, (tracked) => ({
      fiber: null,
      snapshot: {
        ...tracked.snapshot,
        phase,
        endedAt,
        error:
          error === undefined || error === null
            ? null
            : clampText(error, WORKTREE_SETUP_ERROR_MAX_LENGTH),
        stages: tracked.snapshot.stages.map((entry) =>
          entry.status === "running"
            ? {
                ...entry,
                status: phase === "done" ? "done" : phase === "cancelled" ? "skipped" : "failed",
                endedAt,
              }
            : entry,
        ),
      },
    }));
    if (!snapshot) return null;
    const fiber = yield* remove(threadId, snapshot).pipe(
      Effect.delay(FINISHED_RETENTION),
      Effect.ensuring(
        Effect.sync(() => {
          if (retentionFibers.get(threadId) === fiber) retentionFibers.delete(threadId);
        }),
      ),
      Effect.forkDetach,
    );
    yield* Ref.get(setups).pipe(
      Effect.flatMap((current) =>
        current.get(threadId)?.snapshot === snapshot
          ? Effect.sync(() => { retentionFibers.set(threadId, fiber); })
          : Fiber.interrupt(fiber),
      ),
    );
    return snapshot;
  });

  const takeSetupFiber = (threadId: ThreadId) =>
    Ref.modify(setups, (current) => {
      const existing = current.get(threadId);
      if (existing?.snapshot.phase !== "running" || existing.fiber === null) {
        return [null, current] as const;
      }
      const next = new Map(current);
      next.set(threadId, { ...existing, fiber: null });
      return [existing.fiber, next] as const;
    });

  const markUncancellable: WorktreeSetupTracker["Service"]["markUncancellable"] = (threadId) =>
    takeSetupFiber(threadId).pipe(Effect.map((fiber) => fiber !== null));

  const cancel: WorktreeSetupTracker["Service"]["cancel"] = Effect.fn(
    "WorktreeSetupTracker.cancel",
  )(function* (threadId) {
    const fiber = yield* takeSetupFiber(threadId);
    if (fiber === null) return false;
    yield* Fiber.interrupt(fiber);
    return true;
  }, Effect.uninterruptible);

  const get: WorktreeSetupTracker["Service"]["get"] = (threadId) =>
    Ref.get(setups).pipe(Effect.map((current) => current.get(threadId)?.snapshot ?? null));

  // One-slot sliding mailboxes bound slow WebSockets to the newest setup snapshot.
  const stream: WorktreeSetupTracker["Service"]["stream"] = (threadId) =>
    Stream.callback<WorktreeSetupSnapshot | null>(
      (mailbox) =>
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const initial = yield* get(threadId);
          // The initial snapshot already includes queued changes; drop them to avoid stale replay.
          let lastSequence = initial?.sequence ?? -1;
          Queue.offerUnsafe(mailbox, initial);
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.runForEach((change) =>
              Effect.sync(() => {
                if (change.threadId !== threadId) return;
                if (change.snapshot !== null && change.snapshot.sequence <= lastSequence) return;
                lastSequence = change.snapshot?.sequence ?? -1;
                Queue.offerUnsafe(mailbox, change.snapshot);
              }),
            ),
            Effect.forkScoped,
          );
        }),
      { bufferSize: 1, strategy: "sliding" },
    );

  return WorktreeSetupTracker.of({
    begin,
    update,
    stage,
    stageStatus,
    appendTail,
    finish,
    markUncancellable,
    cancel,
    get,
    stream,
  });
});

export const layer = Layer.effect(WorktreeSetupTracker, make);
