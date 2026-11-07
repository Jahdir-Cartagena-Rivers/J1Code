import type { BotRoutineSchedule } from "@t3tools/contracts";

/** Latest due occurrence only: do not run an unbounded backlog after downtime. */
export function latestRoutineOccurrence(schedule: BotRoutineSchedule, now: number): number | null {
  if (!Number.isFinite(now)) return null;
  if (schedule.type === "once") {
    const at = Date.parse(schedule.at);
    return Number.isFinite(at) && at <= now ? at : null;
  }
  const anchor = Date.parse(schedule.anchorAt);
  const period = schedule.everyMinutes * 60_000;
  if (!Number.isFinite(anchor) || !Number.isSafeInteger(period) || period <= 0 || anchor > now)
    return null;
  return anchor + Math.floor((now - anchor) / period) * period;
}

/** Each occurrence has a stable identity for durable claiming across restarts. */
export function routineOccurrenceKey(botId: string, routineId: string, at: number): string {
  return JSON.stringify([botId, routineId, at]);
}
