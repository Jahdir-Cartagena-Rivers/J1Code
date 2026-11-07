import type { BotProfile, BotRoutine } from "@t3tools/contracts";
import { DateTime, Effect } from "effect";
import { makeRoutineRuns } from "./routineRuns.ts";
import { latestRoutineOccurrence } from "./routineSchedule.ts";

/** A persisted claim is an admission attempt, not proof that the bot completed work. */
export const makeRoutineScheduler = (input: {
  readonly profiles: Effect.Effect<ReadonlyArray<BotProfile>, string>;
  readonly admit: (
    bot: BotProfile,
    routine: BotRoutine,
    occurrence: number,
  ) => Effect.Effect<void, string>;
}) =>
  Effect.gen(function* () {
    const runs = yield* makeRoutineRuns;
    const sweep = (now: number) =>
      Effect.gen(function* () {
        const profiles = yield* input.profiles;
        const timestamp = DateTime.formatIso(DateTime.makeUnsafe(now));
        for (const bot of profiles) {
          if (bot.archived) continue;
          for (const routine of bot.routines ?? []) {
            if (!routine.enabled) continue;
            const occurrence = latestRoutineOccurrence(routine.schedule, now);
            if (
              occurrence === null ||
              !(yield* runs.claim(bot.id, routine.id, occurrence, timestamp))
            )
              continue;
            const refreshed = yield* input.profiles.pipe(Effect.result);
            if (refreshed._tag === "Failure") {
              yield* runs.release(bot.id, routine.id, occurrence);
              return yield* Effect.fail(refreshed.failure);
            }
            const current = refreshed.success.find((candidate) => candidate.id === bot.id);
            const latest = current?.routines?.find((candidate) => candidate.id === routine.id);
            if (
              !current ||
              current.archived ||
              !latest?.enabled ||
              latest.name !== routine.name ||
              latest.prompt !== routine.prompt ||
              latest.schedule.type !== routine.schedule.type ||
              (latest.schedule.type === "once" &&
                routine.schedule.type === "once" &&
                latest.schedule.at !== routine.schedule.at) ||
              (latest.schedule.type === "interval" &&
                routine.schedule.type === "interval" &&
                (latest.schedule.anchorAt !== routine.schedule.anchorAt ||
                  latest.schedule.everyMinutes !== routine.schedule.everyMinutes))
            ) {
              yield* runs.settle(
                bot.id,
                routine.id,
                occurrence,
                "failed",
                timestamp,
                "Routine changed before admission.",
              );
              continue;
            }
            const admitted = yield* input.admit(current, latest, occurrence).pipe(Effect.result);
            yield* runs.settle(
              bot.id,
              routine.id,
              occurrence,
              admitted._tag === "Success" ? "admitted" : "uncertain",
              timestamp,
              admitted._tag === "Success" ? null : "Admission outcome unknown.",
            );
          }
        }
      });
    return {
      sweep,
      recover: (now: number) => runs.recover(DateTime.formatIso(DateTime.makeUnsafe(now))),
    };
  });
