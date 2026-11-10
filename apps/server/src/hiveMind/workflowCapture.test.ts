import { describe, expect, it } from "@effect/vitest";
import { WorkflowCapture, workflowSummary } from "./workflowCapture.ts";
import { TurnContinuity } from "./turnContinuity.ts";

describe("automatic workflow capture", () => {
  it("retains streamed methods and replaces the completed item without duplicating it", () => {
    const capture = new WorkflowCapture();
    capture.append("chat", "codex", "1", "Preserve original. ", "m1");
    capture.append("chat", "codex", "1", "Use transparent layers.", "m1");
    capture.append(
      "chat",
      "codex",
      "1",
      "Preserve original. Use transparent layers. Verified output.",
      "m1",
      true,
    );
    const summary = workflowSummary(
      "Fix the workflow",
      capture.take("chat", "codex", "1"),
      "turn.completed",
      "1",
    );
    expect(summary).toContain("Use transparent layers. Verified output.");
    expect(summary.match(/Preserve original/g)).toHaveLength(1);
    expect(summary).toContain("Agent evidence");
    expect(capture.take("chat", "codex", "1")).toBe("");
  });
  it("captures before admission returns, without capturing an unrelated provider or rejected turn", () => {
    const turns = new TurnContinuity<string, { type: string; output: string }>();
    const end = turns.begin("chat", "a");
    expect(turns.tracks("chat", "a", "early")).toBe(true);
    expect(turns.tracks("chat", "b", "early")).toBe(false);
    turns.receive("chat", "a", "early", { type: "turn.completed", output: "Method verified" });
    expect(turns.accept("chat", "a", "early", "memory")[0]?.outcome.output).toBe("Method verified");
    end();
    expect(turns.tracks("chat", "a", "rejected")).toBe(false);
  });
  it("isolates turns and sessions, bounds output and marks missing or truncated excerpts", () => {
    const capture = new WorkflowCapture();
    capture.append("chat", "a", "1", "old".repeat(10000), "m1");
    capture.append("chat", "b", "1", "Neighbor works", "m1", true);
    const summary = workflowSummary("request", capture.take("chat", "a", "1"), "turn.aborted", "1");
    expect(summary.length).toBeLessThanOrEqual(4000);
    expect(summary).toContain("[Earlier output omitted]");
    expect(summary).toContain("turn.aborted");
    capture.forget("chat", "a");
    expect(capture.take("chat", "b", "1")).toBe("Neighbor works");
    expect(workflowSummary("request", "", "turn.completed", "2")).toContain(
      "No assistant output captured",
    );
  });
});
