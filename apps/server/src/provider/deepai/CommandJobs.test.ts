import { describe, expect, it, vi } from "vite-plus/test";
import { CommandJobs, type CommandJobClock } from "./CommandJobs.ts";

class FakeClock implements CommandJobClock {
  #now = 0;
  #timers: Array<{ at: number; resolve: () => void; reject: (reason: unknown) => void }> = [];

  now = () => this.#now;

  sleep(milliseconds: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const timer = { at: this.#now + milliseconds, resolve, reject };
      this.#timers.push(timer);
      signal.addEventListener(
        "abort",
        () => {
          this.#timers = this.#timers.filter((entry) => entry !== timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  advance(milliseconds: number) {
    this.#now += milliseconds;
    const due = this.#timers.filter((timer) => timer.at <= this.#now);
    this.#timers = this.#timers.filter((timer) => timer.at > this.#now);
    for (const timer of due) timer.resolve();
  }
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const session = (
  clock = new FakeClock(),
  options: Partial<ConstructorParameters<typeof CommandJobs>[0]> = {},
) => {
  const owner = new AbortController();
  return {
    clock,
    owner,
    jobs: new CommandJobs({
      signal: owner.signal,
      foregroundMs: 10,
      createId: (() => {
        let sequence = 0;
        return () => `job-${++sequence}`;
      })(),
      clock,
      ...options,
    }),
  };
};

describe("CommandJobs", () => {
  it("announces a background handoff before a racing completion receipt", async () => {
    const work = deferred<string>();
    const events: string[] = [];
    const { jobs, clock } = session(undefined, {
      onBackgrounded: () => {
        events.push("backgrounded");
        work.resolve("done at handoff");
      },
      onChange: (job) => {
        if (job.state === "completed") events.push("completed");
      },
    });
    const starting = jobs.start("racing", async () => work.promise);
    clock.advance(10);
    const handle = await starting;
    await jobs.wait(handle.id);
    expect(events).toEqual(["backgrounded", "completed"]);
  });
  it("returns a terminal result during the foreground budget", async () => {
    const { jobs } = session();
    const result = await jobs.start("quick", async (_signal, output) => {
      output("hello ");
      return { output: "world", exitCode: 0 };
    });

    expect(result).toMatchObject({
      id: "job-1",
      key: "quick",
      state: "completed",
      exit: "success",
      exitCode: 0,
      output: "hello world",
      backgrounded: false,
    });
  });

  it("preserves partial output and reports a nonzero command exit as failed", async () => {
    const { jobs } = session();
    const result = await jobs.start("bad-command", async (_signal, output) => {
      output("before failure\n");
      return { output: "after failure", exitCode: 17 };
    });

    expect(result).toMatchObject({
      state: "failed",
      exit: "error",
      exitCode: 17,
      output: "before failure\nafter failure",
      backgrounded: false,
    });
  });

  it("yields one running job and never starts the same key twice", async () => {
    const { clock, jobs } = session();
    const work = deferred<string>();
    const execute = vi.fn(async (_signal: AbortSignal, output: (chunk: string) => void) => {
      output("working");
      return work.promise;
    });
    const first = jobs.start("scan", execute);
    await Promise.resolve();
    clock.advance(10);
    const yielded = await first;
    const duplicate = await jobs.start("scan", execute);

    expect(yielded).toMatchObject({ state: "running", output: "working", backgrounded: true });
    expect(duplicate).toMatchObject({ id: yielded.id, state: "running", backgrounded: true });
    expect(execute).toHaveBeenCalledTimes(1);

    work.resolve(" done");
    expect(await jobs.wait(yielded.id)).toMatchObject({
      state: "completed",
      output: "working done",
      timedOut: false,
    });
  });

  it("uses one timed wait race instead of polling", async () => {
    const { clock, jobs } = session();
    const work = deferred<string>();
    const start = jobs.start("slow", async () => work.promise);
    await Promise.resolve();
    clock.advance(10);
    const running = await start;
    expect(running).toMatchObject({
      state: "running",
      elapsedMs: 10,
      outputChars: 0,
      msSinceOutput: 10,
    });

    const wait = jobs.wait(running.id, 5);
    await Promise.resolve();
    clock.advance(5);
    expect(await wait).toMatchObject({ state: "running", timedOut: true });

    work.resolve("finished");
    expect(await jobs.wait(running.id)).toMatchObject({
      state: "completed",
      output: "finished",
      timedOut: false,
    });
  });

  it("cancels idempotently and rejects ids from another session", async () => {
    const { clock, jobs } = session();
    const started = jobs.start(
      "cancel-me",
      (signal) =>
        new Promise<string>((_resolve, reject) =>
          signal.addEventListener("abort", reject, { once: true }),
        ),
    );
    await Promise.resolve();
    clock.advance(10);
    const running = await started;
    expect(jobs.cancel(running.id).state).toBe("running");
    expect(jobs.cancel(running.id).id).toBe(running.id);
    expect(await jobs.wait(running.id)).toMatchObject({ state: "cancelled", exit: "cancelled" });

    const other = session().jobs;
    expect(() => other.cancel(running.id)).toThrow("Unknown command job for this session.");
    await expect(other.wait(running.id)).rejects.toThrow("Unknown command job for this session.");
  });

  it("keeps a job running when its executor has not settled after cancellation", async () => {
    const { clock, jobs } = session();
    const work = deferred<string>();
    const start = jobs.start("ignores-abort", async () => work.promise);
    await Promise.resolve();
    clock.advance(10);
    const running = await start;

    expect(jobs.cancel(running.id)).toMatchObject({ state: "running", cancelRequested: true });
    const status = jobs.wait(running.id, 5);
    await Promise.resolve();
    clock.advance(5);
    expect(await status).toMatchObject({ state: "running", cancelRequested: true, timedOut: true });

    work.resolve("stopped after cleanup");
    expect(await jobs.wait(running.id)).toMatchObject({ state: "cancelled", exit: "cancelled" });
  });

  it("cancels active jobs without disposing the session", async () => {
    const { clock, jobs } = session();
    const work = deferred<string>();
    const start = jobs.start("first", async () => work.promise);
    await Promise.resolve();
    clock.advance(10);
    const running = await start;

    expect(jobs.cancelAll()).toEqual([
      expect.objectContaining({ id: running.id, cancelRequested: true }),
    ]);
    work.resolve("cleanup");
    await jobs.wait(running.id);
    expect(await jobs.start("next", async () => "next")).toMatchObject({ state: "completed" });
  });

  it("aborts every owned job when its session is disposed", async () => {
    const { clock, owner, jobs } = session();
    const aborted = vi.fn();
    const start = jobs.start(
      "owned",
      (signal) =>
        new Promise<string>((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted();
              reject(signal.reason);
            },
            { once: true },
          ),
        ),
    );
    await Promise.resolve();
    clock.advance(10);
    const running = await start;

    owner.abort();
    await jobs.dispose();
    expect(aborted).toHaveBeenCalledOnce();
    expect(await jobs.wait(running.id)).toMatchObject({ state: "cancelled" });
    await expect(jobs.start("after", async () => "no")).rejects.toThrow("disposed");
  });

  it("limits concurrent jobs and retains only bounded output", async () => {
    const { clock, jobs } = session(undefined, { maxConcurrent: 1, maxOutputChars: 4 });
    const work = deferred<string>();
    const start = jobs.start("first", async (_signal, output) => {
      output("abcdef");
      return work.promise;
    });
    await Promise.resolve();
    clock.advance(10);
    const running = await start;

    await expect(jobs.start("second", async () => "no")).rejects.toThrow("capacity");
    expect(running).toMatchObject({ output: "cdef", outputTruncated: true });
    work.resolve("!");
    expect(await jobs.wait(running.id)).toMatchObject({ state: "completed", output: "def!" });
  });

  it("waits for executor cleanup on every disposal call after owner abort", async () => {
    const { owner, jobs } = session();
    const cleanup = deferred<string>();
    void jobs.start("slow cleanup", async () => cleanup.promise);
    owner.abort();
    const finished = vi.fn();
    const stopping = jobs.dispose().then(finished);
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    cleanup.resolve("cleaned");
    await stopping;
    expect(finished).toHaveBeenCalledOnce();
  });

  it("rejects execution when the owner was already aborted", async () => {
    const owner = new AbortController();
    owner.abort();
    const jobs = new CommandJobs({ signal: owner.signal });
    const execute = vi.fn(async () => "should not run");
    await expect(jobs.start("late", execute)).rejects.toThrow("disposed");
    expect(execute).not.toHaveBeenCalled();
  });
});
