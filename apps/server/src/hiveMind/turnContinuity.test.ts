import { describe, it, expect } from "@effect/vitest";
import { TurnContinuity } from "./turnContinuity.ts";
describe("turn memory ownership", () => {
  it("does not let an old admission finalizer erase a new session's pending outcome", () => {
    const turns = new TurnContinuity<string, { type: string }>();
    const old = turns.begin("chat", "provider");
    turns.forget("chat", "provider");
    const fresh = turns.begin("chat", "provider");
    old();
    turns.receive("chat", "provider", "new", { type: "turn.completed" });
    expect(turns.accept("chat", "provider", "new", "fresh-brain")[0]?.memory).toBe("fresh-brain");
    fresh();
  });
  it("captures an early terminal against its accepted turn without consuming the next turn's memory", () => {
    const turns = new TurnContinuity<string, { type: string }>();
    const done = turns.begin("chat", "provider-a");
    expect(turns.receive("chat", "provider-a", "fast", { type: "turn.completed" })).toEqual([]);
    expect(turns.accept("chat", "provider-a", "fast", "brain-a")).toEqual([
      { memory: "brain-a", outcome: { type: "turn.completed" } },
    ]);
    done();
    turns.accept("chat", "provider-a", "next", "brain-b");
    expect(turns.receive("chat", "provider-a", "fast", { type: "turn.completed" })).toEqual([]);
    expect(turns.receive("chat", "provider-a", "next", { type: "turn.completed" })[0]?.memory).toBe(
      "brain-b",
    );
  });
  it("keeps provider instances and rejected admissions separate; transient errors do not clear an active turn", () => {
    const turns = new TurnContinuity<string, { type: string }>();
    turns.accept("chat", "provider-a", "same-id", "a");
    turns.accept("chat", "provider-b", "same-id", "b");
    const reject = turns.begin("chat", "provider-a");
    turns.receive("chat", "provider-a", "unaccepted", { type: "turn.aborted" });
    reject();
    expect(turns.accept("chat", "provider-a", "unaccepted", "new")).toEqual([]);
    expect(
      turns.receive("chat", "provider-a", "same-id", { type: "runtime.error" })[0]?.memory,
    ).toBe("a");
    expect(
      turns.receive("chat", "provider-a", "same-id", { type: "turn.completed" })[0]?.memory,
    ).toBe("a");
    expect(
      turns.receive("chat", "provider-b", "same-id", { type: "turn.completed" })[0]?.memory,
    ).toBe("b");
  });
});
