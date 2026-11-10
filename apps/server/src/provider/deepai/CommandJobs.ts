import * as NodePerfHooks from "node:perf_hooks";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";

export type CommandJobState = "running" | "completed" | "failed" | "cancelled";

export type CommandJobExit = "success" | "error" | "cancelled";

export type CommandJobExecutionResult =
  | string
  | {
      output: string;
      exitCode?: number;
    };

export type CommandJobResult = {
  id: string;
  key: string;
  state: CommandJobState;
  exit?: CommandJobExit;
  exitCode?: number;
  error?: string;
  output: string;
  outputTruncated: boolean;
  cancelRequested: boolean;
  elapsedMs: number;
  outputChars: number;
  msSinceOutput: number;
};

export type CommandJobStartResult = CommandJobResult & {
  backgrounded: boolean;
};

export type CommandJobWaitResult = CommandJobResult & {
  timedOut: boolean;
};

export type CommandJobClock = {
  now: () => number;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export type CommandJobsOptions = {
  signal: AbortSignal;
  foregroundMs?: number;
  maxConcurrent?: number;
  maxOutputChars?: number;
  maxRetained?: number;
  clock?: CommandJobClock;
  createId?: () => string;
  onChange?: (result: CommandJobResult) => void;
  onBackgrounded?: (result: CommandJobResult) => void;
};

type Job = {
  id: string;
  key: string;
  controller: AbortController;
  state: CommandJobState;
  exit?: CommandJobExit;
  exitCode?: number;
  error?: string;
  output: string;
  outputTruncated: boolean;
  cancelRequested: boolean;
  startedAt: number;
  lastOutputAt?: number;
  outputChars: number;
  done: Promise<void>;
};

const systemClock: CommandJobClock = {
  now: () => NodePerfHooks.performance.now(),
  sleep: (milliseconds, signal) => Effect.runPromise(Effect.sleep(milliseconds), { signal }),
};

const isTerminal = (state: CommandJobState) => state !== "running";

/**
 * Session-local ownership for a single Pi bash execution. It deliberately
 * receives an executor instead of starting a shell itself, so policy and Pi's
 * existing tool boundary remain the only place that can create a process.
 */
export class CommandJobs {
  readonly #jobs = new Map<string, Job>();
  readonly #keys = new Map<string, Job>();
  readonly #foregroundMs: number;
  readonly #maxConcurrent: number;
  readonly #maxOutputChars: number;
  readonly #maxRetained: number;
  readonly #clock: CommandJobClock;
  readonly #createId: () => string;
  readonly #onChange: ((result: CommandJobResult) => void) | undefined;
  readonly #onBackgrounded: ((result: CommandJobResult) => void) | undefined;
  #disposed = false;
  #disposal: Promise<void> | undefined;

  constructor(options: CommandJobsOptions) {
    this.#foregroundMs = options.foregroundMs ?? 10_000;
    this.#maxConcurrent = options.maxConcurrent ?? 4;
    this.#maxOutputChars = options.maxOutputChars ?? 16_000;
    this.#maxRetained = options.maxRetained ?? 32;
    this.#clock = options.clock ?? systemClock;
    this.#createId = options.createId ?? (() => NodeCrypto.randomUUID());
    this.#onChange = options.onChange;
    this.#onBackgrounded = options.onBackgrounded;
    options.signal.addEventListener("abort", () => void this.dispose(), { once: true });
    if (options.signal.aborted) void this.dispose();
  }

  async start(
    key: string,
    execute: (
      signal: AbortSignal,
      onOutput: (chunk: string) => void,
    ) => Promise<CommandJobExecutionResult>,
  ): Promise<CommandJobStartResult> {
    this.#assertAvailable();
    const existing = this.#keys.get(key);
    if (existing?.state === "running") {
      return this.#startResult(existing, true);
    }
    if (this.#runningCount() >= this.#maxConcurrent) {
      throw new Error("Command job capacity reached for this session.");
    }

    const controller = new AbortController();
    const completion = Promise.withResolvers<void>();
    const job: Job = {
      id: this.#createId(),
      key,
      controller,
      state: "running",
      output: "",
      outputTruncated: false,
      cancelRequested: false,
      startedAt: this.#clock.now(),
      outputChars: 0,
      done: completion.promise,
    };
    this.#jobs.set(job.id, job);
    this.#keys.set(key, job);
    this.#emit(job);
    void this.#run(job, execute).then(completion.resolve, completion.reject);

    const timer = new AbortController();
    const completed = await Promise.race([
      job.done.then(() => true),
      this.#clock.sleep(this.#foregroundMs, timer.signal).then(
        () => false,
        () => true,
      ),
    ]);
    timer.abort();
    return this.#startResult(job, !completed);
  }

  async wait(id: string, timeoutMs = this.#foregroundMs): Promise<CommandJobWaitResult> {
    const job = this.#job(id);
    if (isTerminal(job.state)) return { ...this.#snapshot(job), timedOut: false };

    const timer = new AbortController();
    const completed = await Promise.race([
      job.done.then(() => true),
      this.#clock.sleep(timeoutMs, timer.signal).then(
        () => false,
        () => true,
      ),
    ]);
    timer.abort();
    return { ...this.#snapshot(job), timedOut: !completed };
  }

  cancel(id: string): CommandJobResult {
    const job = this.#job(id);
    if (job.state === "running") {
      job.cancelRequested = true;
      job.controller.abort();
      this.#emit(job);
    }
    return this.#snapshot(job);
  }

  cancelAll(): CommandJobResult[] {
    return [...this.#jobs.values()]
      .filter((job) => job.state === "running")
      .map((job) => this.cancel(job.id));
  }

  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposed = true;
    this.cancelAll();
    this.#disposal = Promise.allSettled([...this.#jobs.values()].map((job) => job.done)).then(
      () => {},
    );
    return this.#disposal;
  }

  #assertAvailable() {
    if (this.#disposed) throw new Error("Command jobs session is disposed.");
  }

  #job(id: string) {
    const job = this.#jobs.get(id);
    if (!job) throw new Error("Unknown command job for this session.");
    return job;
  }

  #runningCount() {
    return [...this.#jobs.values()].filter((job) => job.state === "running").length;
  }

  async #run(
    job: Job,
    execute: (
      signal: AbortSignal,
      onOutput: (chunk: string) => void,
    ) => Promise<CommandJobExecutionResult>,
  ) {
    try {
      const result = await execute(job.controller.signal, (chunk) => this.#append(job, chunk));
      if (job.controller.signal.aborted) {
        job.state = "cancelled";
        job.exit = "cancelled";
        this.#emit(job);
        return;
      }
      const normalized = typeof result === "string" ? { output: result } : result;
      this.#append(job, normalized.output);
      if (normalized.exitCode !== undefined) job.exitCode = normalized.exitCode;
      if (normalized.exitCode !== undefined && normalized.exitCode !== 0) {
        job.state = "failed";
        job.exit = "error";
      } else {
        job.state = "completed";
        job.exit = "success";
      }
      this.#emit(job);
    } catch (error) {
      job.state = job.controller.signal.aborted ? "cancelled" : "failed";
      job.exit = job.controller.signal.aborted ? "cancelled" : "error";
      if (!job.controller.signal.aborted && error instanceof Error && error.message) {
        job.error = error.message.slice(-2_000);
      }
      this.#emit(job);
    } finally {
      if (this.#keys.get(job.key) === job) this.#keys.delete(job.key);
      this.#prune();
    }
  }

  #append(job: Job, chunk: string) {
    if (!chunk) return;
    job.outputChars += chunk.length;
    job.lastOutputAt = this.#clock.now();
    const combined = job.output + chunk;
    if (combined.length <= this.#maxOutputChars) {
      job.output = combined;
      this.#emit(job);
      return;
    }
    job.output = combined.slice(-this.#maxOutputChars);
    job.outputTruncated = true;
    this.#emit(job);
  }

  #snapshot(job: Job): CommandJobResult {
    return {
      id: job.id,
      key: job.key,
      state: job.state,
      ...(job.exit ? { exit: job.exit } : {}),
      ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
      ...(job.error ? { error: job.error } : {}),
      output: job.output,
      outputTruncated: job.outputTruncated,
      cancelRequested: job.cancelRequested,
      elapsedMs: Math.max(0, this.#clock.now() - job.startedAt),
      outputChars: job.outputChars,
      msSinceOutput: Math.max(0, this.#clock.now() - (job.lastOutputAt ?? job.startedAt)),
    };
  }

  #startResult(job: Job, yielded: boolean): CommandJobStartResult {
    const result = { ...this.#snapshot(job), backgrounded: yielded && job.state === "running" };
    if (result.backgrounded) {
      try {
        // Announce before returning the handle: completion can race the caller's await.
        this.#onBackgrounded?.(result);
      } catch {
        // Presentation must not change execution ownership.
      }
    }
    return result;
  }

  #prune() {
    let retained = this.#jobs.size;
    for (const [id, job] of this.#jobs) {
      if (retained <= this.#maxRetained) return;
      if (!isTerminal(job.state)) continue;
      this.#jobs.delete(id);
      retained -= 1;
    }
  }

  #emit(job: Job) {
    try {
      this.#onChange?.(this.#snapshot(job));
    } catch {
      // A presentation listener must not alter execution ownership or cleanup.
    }
  }
}
