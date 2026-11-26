import type { ThreadId } from "@j1code/contracts";
import * as KeyedLock from "@j1code/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

export class ThreadCommandExecutor extends Context.Service<
  ThreadCommandExecutor,
  KeyedLock.KeyedLock<ThreadId> & {
    /**
     * One thread deletion plans and commits at a time: each decides what its deleted fork
     * sources keep for the forks still alive. Take it before any thread lock.
     */
    readonly withDeletionLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /** Serialize Home admission across thread IDs. Take it before any thread lock. */
    readonly withHomeAdmissionLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("@j1code/server/orchestration-v2/ThreadCommandExecutor") {}

export const make = Effect.gen(function* () {
  const deletion = yield* Semaphore.make(1);
  const homeAdmission = yield* Semaphore.make(1);
  return ThreadCommandExecutor.of({
    ...(yield* KeyedLock.make<ThreadId>()),
    withHomeAdmissionLock: Effect.fn("ThreadCommandExecutor.withHomeAdmissionLock")(
      <A, E, R>(effect: Effect.Effect<A, E, R>) => homeAdmission.withPermit(effect),
    ),
    withDeletionLock: Effect.fn("ThreadCommandExecutor.withDeletionLock")(function* <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) {
      return yield* deletion.withPermit(effect);
    }),
  });
});

export const layer = Layer.effect(ThreadCommandExecutor, make);
