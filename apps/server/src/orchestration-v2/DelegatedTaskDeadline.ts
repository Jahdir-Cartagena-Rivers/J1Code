import { CommandId, type OrchestrationV2Subagent } from "@j1code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as DueHint from "../scheduling/DueHint.ts";
import { Scheduler } from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { listDelegatedTaskDeadlines } from "./ProjectionStore.ts";

export function deadlineStop(task: OrchestrationV2Subagent, now: DateTime.Utc) {
  const { deadlineAt, childThreadId } = task;
  if (deadlineAt === undefined || childThreadId === null ||
      DateTime.toEpochMillis(deadlineAt) > DateTime.toEpochMillis(now)) return undefined;
  return {
    parentThreadId: task.threadId,
    taskId: task.id,
    expectedDeadlineAt: deadlineAt,
    command: {
      type: "thread.stop",
      commandId: CommandId.make(`deadline:${task.id}:${DateTime.toEpochMillis(deadlineAt)}`),
      threadId: childThreadId,
      reason: "Delegated worker deadline expired.",
      stopDelegatedTasks: false,
    },
    // Each descendant has its own inherited deadline. The same durable scan validates each
    // separately so expiry cannot also Stop a settled child's later unrelated work.
    stopDescendants: () => Effect.void,
  } as const;
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler;
    const orchestrator = yield* OrchestratorV2;
    const due = DueHint.make();
    yield* forkParked(Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
      if (event.type === "subagent.updated" || event.type === "run.updated") {
        return due.invalidate;
      }
      return Effect.void;
    }));
    yield* scheduler.register("delegated-task-deadline", Effect.gen(function* () {
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      if (yield* due.isIdle(nowMs)) return;
      const version = yield* due.version;
      let next = Infinity;
      for (const task of yield* listDelegatedTaskDeadlines) {
        const request = deadlineStop(task, now);
        if (request === undefined) {
          if (task.deadlineAt !== undefined) {
            next = Math.min(next, DateTime.toEpochMillis(task.deadlineAt));
          }
          continue;
        }
        // Give a failed or deferred cancellation a chance to settle without spinning.
        next = Math.min(next, nowMs + 5_000);
        yield* orchestrator.cancelDelegatedTask(request).pipe(
          Effect.catch((cause) => Effect.logWarning("orchestration-v2.delegation-deadline.stop-failed", {
            taskId: task.id,
            threadId: task.childThreadId,
            cause,
          })),
        );
      }
      yield* due.record(version, next, nowMs);
    }));
  }),
);
