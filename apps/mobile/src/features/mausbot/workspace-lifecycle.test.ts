import { describe, expect, it } from "vite-plus/test";

import { WorkspaceLifecycle } from "./workspace-lifecycle";

function fixture(now = 1_000_000) {
  let time = now;
  let nextTimer = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let timedOut = 0;
  let renewals = 0;
  const lifecycle = new WorkspaceLifecycle(
    { onHandoffTimeout: () => timedOut++, onRefreshNeeded: () => renewals++ },
    {
      now: () => time,
      setTimeout: (callback, delay) => {
        const id = ++nextTimer;
        timers.set(id, { at: time + delay, callback });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (timer) => timers.delete(timer as unknown as number),
    },
  );
  const advance = (milliseconds: number) => {
    time += milliseconds;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= time) {
        timers.delete(id);
        timer.callback();
      }
    }
  };
  return {
    lifecycle,
    advance,
    timers,
    get timedOut() {
      return timedOut;
    },
    get renewals() {
      return renewals;
    },
  };
}

describe("workspace lifecycle", () => {
  it("discards an initial handoff that resolves after background and requests a fresh one", () => {
    const f = fixture();
    const initial = f.lifecycle.begin();
    expect(initial).toBe(1);
    f.lifecycle.background();
    expect(f.lifecycle.acceptIssue(initial!)).toBe(false);
    expect(f.lifecycle.acceptFailure(initial!)).toBe(false);
    f.advance(65_000);
    expect(f.timedOut).toBe(0);
    expect(f.lifecycle.foregrounded()).toBe(true);
    expect(f.lifecycle.begin()).toBe(3);
  });

  it("allows the second StrictMode effect setup to start after its cleanup", () => {
    const f = fixture();
    expect(f.lifecycle.activate()).toBe(true);
    expect(f.lifecycle.begin()).toBe(1);
    f.lifecycle.dispose();
    expect(f.lifecycle.activate()).toBe(true);
    expect(f.lifecycle.begin()).toBe(3);
  });

  it("keeps a valid browser session and draft route through a background resume", () => {
    const f = fixture();
    const handoff = f.lifecycle.begin()!;
    expect(f.lifecycle.acceptAuthenticated(handoff, new Date(1_300_000).toISOString())).toBe(true);
    f.lifecycle.background();
    expect(f.lifecycle.foregrounded()).toBe(false);
    expect(f.timers.size).toBe(1);
  });

  it("cancels renewal while backgrounded and ignores its late acknowledgement", () => {
    const f = fixture();
    const first = f.lifecycle.begin()!;
    f.lifecycle.acceptAuthenticated(first, new Date(1_121_000).toISOString());
    f.lifecycle.background();
    f.advance(61_000);
    expect(f.renewals).toBe(0);
    expect(f.lifecycle.acceptAuthenticated(first, new Date(1_500_000).toISOString())).toBe(false);
    expect(f.lifecycle.foregrounded()).toBe(true);
  });

  it("renews before expiry but makes expiry and rejected handoffs retryable", () => {
    const f = fixture();
    const first = f.lifecycle.begin()!;
    f.lifecycle.acceptAuthenticated(first, new Date(1_121_000).toISOString());
    f.advance(61_000);
    expect(f.renewals).toBe(1);
    const renewal = f.lifecycle.begin()!;
    expect(f.lifecycle.rejectHandoff(renewal)).toBe(true);
    expect(f.lifecycle.foregrounded()).toBe(true);
  });
});
