import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeRoutineRuns } from "./routineRuns.ts";

it.effect("claims an occurrence once and never automatically reclaims uncertain work", () =>
  Effect.gen(function* () {
    const store = yield* makeRoutineRuns;
    const now = "2026-01-01T00:00:00Z";
    const claims = yield* Effect.all(
      [store.claim("bot", "r", 42, now), store.claim("bot", "r", 42, now)],
      { concurrency: "unbounded" },
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    yield* store.recover(now);
    expect(yield* store.claim("bot", "r", 42, now)).toBe(false);
    expect(yield* store.settle("bot", "r", 42, "admitted", now, null)).toBe(false);
    expect(yield* store.claim("bot", "r", 43, now)).toBe(true);
    expect(yield* store.settle("bot", "r", 43, "admitted", now, null)).toBe(true);
    expect(yield* store.settle("bot", "r", 43, "failed", now, null)).toBe(false);
    expect((yield* store.listForBot("bot")).map((run) => run.status)).toEqual([
      "admitted",
      "uncertain",
    ]);
    expect(yield* store.listForBot("other")).toEqual([]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
