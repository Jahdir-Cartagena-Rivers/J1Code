import { Clock, Effect, Layer } from "effect";
import { ServerSettingsService } from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import { makeRoutineAdmission } from "./routineAdmission.ts";
import { makeRoutineScheduler } from "./routineScheduler.ts";

/** Runs within the server lifecycle; every sweep reads current bot settings. */
export const BotRoutineRuntimeLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const admit = yield* makeRoutineAdmission;
    const scheduler = yield* makeRoutineScheduler({
      profiles: settings.getSettings.pipe(
        Effect.map((value) => Object.values(value.bots)),
        Effect.mapError(String),
      ),
      admit: (bot, routine, occurrence) =>
        admit(bot, routine, occurrence).pipe(Effect.mapError(String)),
    });
    yield* forkParked(
      Effect.gen(function* () {
        yield* settings.ready;
        yield* scheduler.recover(yield* Clock.currentTimeMillis);
        return yield* Effect.forever(
          Effect.gen(function* () {
            yield* scheduler
              .sweep(yield* Clock.currentTimeMillis)
              .pipe(
                Effect.catchCause((cause) => Effect.logError("Bot routine sweep failed", cause)),
              );
            yield* Effect.sleep("30 seconds");
          }),
        );
      }).pipe(Effect.catchCause((cause) => Effect.logError("Bot routine runtime stopped", cause))),
    );
  }),
);
