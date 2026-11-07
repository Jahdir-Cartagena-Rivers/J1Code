import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import { BotRoutineSchedule } from "@t3tools/contracts";
import { latestRoutineOccurrence, routineOccurrenceKey } from "./routineSchedule.ts";
const decode = Schema.decodeUnknownSync(BotRoutineSchedule);
describe("bot routine timing", () => {
  it("runs a one-time occurrence only after its due time", () => {
    const schedule = decode({ type: "once", at: "2026-01-01T00:00:00Z" });
    const due = Date.parse("2026-01-01T00:00:00Z");
    expect(latestRoutineOccurrence(schedule, due - 1)).toBeNull();
    expect(latestRoutineOccurrence(schedule, due)).toBe(due);
  });
  it("finds one most-recent interval after downtime and stable unique claims", () => {
    const schedule = decode({
      type: "interval",
      anchorAt: "2026-01-01T00:00:00Z",
      everyMinutes: 10,
    });
    const anchor = Date.parse("2026-01-01T00:00:00Z");
    expect(latestRoutineOccurrence(schedule, anchor - 1)).toBeNull();
    expect(latestRoutineOccurrence(schedule, anchor + 3_690_000)).toBe(anchor + 3_600_000);
    expect(routineOccurrenceKey("a", "b", anchor)).not.toBe(
      routineOccurrenceKey("a:b", "", anchor),
    );
    expect(() => decode({ ...schedule, everyMinutes: 0 })).toThrow();
  });
});
