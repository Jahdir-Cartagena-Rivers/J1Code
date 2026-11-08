// @effect-diagnostics globalDate:off - Fixed ISO timestamps exercise the activity database's native representation.
import { describe, expect, it } from "vite-plus/test";
import { summarizeActivity, type ActivityTiming } from "./agent-run-report.ts";

const event = (
  id: string,
  seconds: number,
  kind: string,
  durationMs: number | null = null,
): ActivityTiming => ({
  kind,
  createdAt: new Date(seconds * 1000).toISOString(),
  callId: id,
  itemType: "command_execution",
  tool: null,
  durationMs,
  status: "completed",
});
describe("activity timing report", () => {
  it("merges overlapping lifetimes instead of adding them to elapsed time", () => {
    const report = summarizeActivity([
      event("server", 0, "tool.started"),
      event("build", 2, "tool.started"),
      event("build", 4, "tool.completed", 2000),
      event("server", 10, "tool.completed", 10000),
    ]);
    expect(report.activitySpanMs).toBe(10000);
    expect(report.observedToolLifetimeUnionMs).toBe(10000);
    expect(report.tools[0]).toMatchObject({ calls: 2, recordedMs: 12000 });
  });
  it("does not invent a start for incomplete history and preserves gaps", () => {
    const report = summarizeActivity([
      event("one", 0, "tool.started"),
      event("one", 2, "tool.completed"),
      event("two", 8, "tool.started"),
      event("two", 10, "tool.completed"),
      event("unknown", 12, "tool.completed", 50000),
    ]);
    expect(report.observedToolLifetimeUnionMs).toBe(4000);
    expect(report.completedToolCalls).toBe(3);
    expect(summarizeActivity([]).activitySpanMs).toBe(0);
  });
});
