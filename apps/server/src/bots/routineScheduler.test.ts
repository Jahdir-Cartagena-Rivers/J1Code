import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { BotProfile } from "@t3tools/contracts";
import { expect } from "vite-plus/test";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeRoutineScheduler } from "./routineScheduler.ts";

const decode = Schema.decodeUnknownSync(BotProfile);
const bot = decode({
  id: "bot",
  name: "Bot",
  description: "",
  instructions: "",
  projectId: null,
  modelSelection: { instanceId: "codex", model: "model" },
  pinned: false,
  archived: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  routines: [
    {
      id: "daily",
      name: "Routine",
      prompt: "Do the work",
      enabled: true,
      schedule: { type: "interval", anchorAt: "2026-01-01T00:00:00Z", everyMinutes: 60 },
    },
  ],
});

it.effect("admits each scheduled occurrence once and skips disabled or archived bots", () =>
  Effect.gen(function* () {
    const calls: number[] = [];
    let profiles = [bot];
    const scheduler = yield* makeRoutineScheduler({
      profiles: Effect.sync(() => profiles),
      admit: (_bot, _routine, at) =>
        Effect.sync(() => {
          calls.push(at);
        }),
    });
    const at = Date.parse("2026-01-01T02:01:00Z");
    yield* scheduler.recover(at);
    yield* Effect.all([scheduler.sweep(at), scheduler.sweep(at)], { concurrency: "unbounded" });
    expect(calls).toEqual([Date.parse("2026-01-01T02:00:00Z")]);
    profiles = [{ ...bot, archived: true }];
    yield* scheduler.sweep(at + 3600000);
    expect(calls).toHaveLength(1);
    profiles = [{ ...bot, routines: [{ ...bot.routines![0]!, enabled: false }] }];
    yield* scheduler.sweep(at + 3600000);
    expect(calls).toHaveLength(1);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("does not replay an occurrence if provider admission is uncertain", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const scheduler = yield* makeRoutineScheduler({
      profiles: Effect.succeed([bot]),
      admit: () =>
        Effect.sync(() => {
          attempts++;
        }).pipe(Effect.andThen(Effect.fail("lost response"))),
    });
    const now = Date.parse("2026-01-01T02:00:00Z");
    yield* scheduler.sweep(now);
    yield* scheduler.sweep(now);
    expect(attempts).toBe(1);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("does not start a routine disabled after its occurrence was claimed", () =>
  Effect.gen(function* () {
    let reads = 0;
    let attempts = 0;
    const scheduler = yield* makeRoutineScheduler({
      profiles: Effect.sync(() =>
        ++reads === 1 ? [bot] : [{ ...bot, routines: [{ ...bot.routines![0]!, enabled: false }] }],
      ),
      admit: () =>
        Effect.sync(() => {
          attempts++;
        }),
    });
    yield* scheduler.sweep(Date.parse("2026-01-01T02:00:00Z"));
    expect(attempts).toBe(0);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("retries after a settings read fails before provider admission", () =>
  Effect.gen(function* () {
    let reads = 0;
    let attempts = 0;
    const scheduler = yield* makeRoutineScheduler({
      profiles: Effect.suspend(() =>
        ++reads === 2 ? Effect.fail("settings unavailable") : Effect.succeed([bot]),
      ),
      admit: () =>
        Effect.sync(() => {
          attempts++;
        }),
    });
    const now = Date.parse("2026-01-01T02:00:00Z");
    expect((yield* scheduler.sweep(now).pipe(Effect.result))._tag).toBe("Failure");
    expect(attempts).toBe(0);
    yield* scheduler.sweep(now);
    yield* scheduler.sweep(now);
    expect(attempts).toBe(1);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
