// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off - Node subprocess callbacks own timeout cleanup independently of Effect fibers.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeTimers from "node:timers";
import * as NodeChildProcess from "node:child_process";

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;

/** One process owns one provider session's browser storage and page state. */
export class LightpandaProcess {
  readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  private buffer = "";
  private stderr = "";
  private sequence = 0;
  private closed = false;
  private readonly stopped: Promise<void>;
  get isClosed() {
    return this.closed;
  }
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof NodeTimers.setTimeout>;
    }
  >();

  constructor(executable: string, args: readonly string[] = ["mcp"]) {
    this.child = NodeChildProcess.spawn(executable, [...args], {
      shell: false,
      windowsHide: true,
      stdio: "pipe",
      env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "1" },
    });
    this.stopped = new Promise((resolve) => {
      this.child.once("exit", () => resolve());
      this.child.once("error", () => resolve());
    });
    this.child.stdin.on("error", (error) => this.close(error));
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-2000);
    });
    this.child.on("error", (error) => this.close(error));
    this.child.on("exit", (code) =>
      this.close(new Error(`Lightpanda exited (${code ?? "signal"}). ${this.stderr}`)),
    );
  }

  private receive(chunk: string) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) {
      this.close(new Error("Lightpanda response exceeded 4 MiB."));
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const response: unknown = JSON.parse(line);
        if (
          typeof response !== "object" ||
          response === null ||
          !("jsonrpc" in response) ||
          response.jsonrpc !== "2.0"
        ) {
          this.close(new Error("Malformed Lightpanda JSON-RPC response."));
          return;
        }
        if (
          typeof response !== "object" ||
          response === null ||
          !("id" in response) ||
          typeof response.id !== "number"
        )
          continue;
        const request = this.pending.get(response.id);
        if (!request) continue;
        this.pending.delete(response.id);
        NodeTimers.clearTimeout(request.timer);
        if ("error" in response)
          request.reject(new Error(`Lightpanda RPC failed: ${JSON.stringify(response.error)}`));
        else if ("result" in response) request.resolve(response.result);
        else request.reject(new Error("Malformed Lightpanda RPC response."));
      } catch {
        this.close(new Error("Malformed Lightpanda JSON-RPC output."));
        return;
      }
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Lightpanda session is closed."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = NodeTimers.setTimeout(
        () => this.close(new Error(`Lightpanda ${method} timed out; browser session closed.`)),
        REQUEST_TIMEOUT_MS,
      );
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        (error) => {
          if (error) this.close(error);
        },
      );
    });
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "J1 Code", version: "1" },
    });
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
  }

  /** EOF lets the native engine atomically save its cookie jar before exit. */
  async shutdown(): Promise<void> {
    if (this.closed) return this.stopped;
    if (this.pending.size > 0) {
      this.close();
      return this.stopped;
    }
    this.closed = true;
    this.child.stdin.end();
    const timer = NodeTimers.setTimeout(() => this.child.kill(), 3_000);
    timer.unref();
    try {
      await this.stopped;
    } finally {
      NodeTimers.clearTimeout(timer);
    }
  }

  close(error = new Error("Lightpanda session closed.")) {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      NodeTimers.clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.child.stdin.destroy();
    this.child.kill(); // Only the child captured at spawn belongs to this session.
  }
}

/** Bounds native processes and reclaims idle browser memory without sharing storage. */
export class LightpandaPool {
  private readonly createProcess: (executable: string, id: string) => LightpandaProcess;
  private readonly forgetData: ((id: string) => Promise<void>) | undefined;
  private readonly retiring = new Map<string, Promise<void>>();
  constructor(
    createProcess: (executable: string, id: string) => LightpandaProcess = (executable) =>
      new LightpandaProcess(executable),
    forgetData?: (id: string) => Promise<void>,
  ) {
    this.createProcess = createProcess;
    this.forgetData = forgetData;
  }
  private readonly sessions = new Map<
    string,
    {
      executable: string;
      process: LightpandaProcess;
      ready: Promise<void>;
      tail: Promise<unknown>;
      threadId?: string;
      idle: ReturnType<typeof NodeTimers.setTimeout>;
    }
  >();
  close(id: string) {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    NodeTimers.clearTimeout(session.idle);
    const stopped = session.process.shutdown();
    this.retiring.set(id, stopped);
    void stopped.finally(() => {
      if (this.retiring.get(id) === stopped) this.retiring.delete(id);
    });
    return true;
  }
  /** Clearing must finish after save and before another process can reload the profile. */
  async forget(id: string) {
    this.close(id);
    const prior = this.retiring.get(id);
    const cleared = Promise.resolve(prior).then(() => this.forgetData?.(id));
    this.retiring.set(id, cleared);
    try {
      await cleared;
    } finally {
      if (this.retiring.get(id) === cleared) this.retiring.delete(id);
    }
  }
  async closeAll() {
    for (const id of this.sessions.keys()) this.close(id);
    await Promise.all(this.retiring.values());
  }
  hasThread(threadId: string) {
    return [...this.sessions.values()].some(
      (session) => session.threadId === threadId && !session.process.isClosed,
    );
  }
  async openThread(threadId: string, executable: string) {
    const retiring = this.retiring.get(`bot-thread:${threadId}`);
    if (retiring) await retiring;
    if (this.hasThread(threadId)) return;
    await this.request(
      `bot-thread:${threadId}`,
      executable,
      "tools/call",
      { name: "goto", arguments: { url: "about:blank", waitUntil: "domcontentloaded" } },
      undefined,
      threadId,
    );
  }
  /** Viewer reads must attach to a live session, never silently create another page. */
  requestExisting(id: string, method: string, params: unknown, signal?: AbortSignal) {
    const session = this.sessions.get(id);
    if (!session || session.process.isClosed) {
      if (session) this.close(id);
      return Promise.reject(new Error("The bot browser is not running."));
    }
    return this.request(id, session.executable, method, params, signal);
  }
  /** Thread identity comes from authenticated MCP scope, never from a page or tool argument. */
  requestForThread(threadId: string, method: string, params: unknown, signal?: AbortSignal) {
    const matches = [...this.sessions].filter(([, session]) => session.threadId === threadId);
    if (matches.length !== 1)
      return Promise.reject(
        new Error(
          matches.length === 0
            ? "The bot browser is not running."
            : "More than one browser session belongs to this conversation.",
        ),
      );
    return this.requestExisting(matches[0]![0], method, params, signal);
  }
  async request(
    id: string,
    executable: string,
    method: string,
    params: unknown,
    signal?: AbortSignal,
    threadId?: string,
  ): Promise<unknown> {
    if (!executable.trim())
      throw new Error("Configure the native Lightpanda executable in Integrations settings first.");
    if (signal?.aborted) throw new Error("Background browser request cancelled.");
    const retiring = this.retiring.get(id);
    if (retiring) await retiring;
    let session = this.sessions.get(id);
    if (session?.process.isClosed) {
      this.close(id);
      await this.retiring.get(id);
      return this.request(id, executable, method, params, signal, threadId);
    }
    if (session?.threadId && threadId && session.threadId !== threadId)
      throw new Error("Browser session belongs to another conversation.");
    if (session && session.executable !== executable) {
      this.close(id);
      await this.retiring.get(id);
      return this.request(id, executable, method, params, signal, threadId);
    }
    if (!session) {
      if (this.sessions.size >= 8)
        throw new Error(
          "Eight background browser sessions are active. Close one before opening another.",
        );
      const process = this.createProcess(executable, id);
      const idle = NodeTimers.setTimeout(() => this.close(id), 180_000);
      idle.unref();
      session = { executable, process, ready: process.initialize(), tail: Promise.resolve(), idle };
      this.sessions.set(id, session);
    }
    if (threadId) session.threadId = threadId;
    NodeTimers.clearTimeout(session.idle);
    const abort = () => {
      if (this.sessions.get(id) === session) this.close(id);
    };
    signal?.addEventListener("abort", abort, { once: true });
    const owner = session;
    const operation = owner.tail
      .catch(() => undefined)
      .then(async () => {
        if (this.sessions.get(id) !== owner || signal?.aborted)
          throw new Error("Background browser session closed before the operation started.");
        await owner.ready;
        return owner.process.request(method, params);
      });
    owner.tail = operation;
    try {
      return await operation;
    } catch (error) {
      if (this.sessions.get(id) === session) this.close(id);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (this.sessions.get(id) === session && session.tail === operation) {
        session.idle = NodeTimers.setTimeout(() => this.close(id), 180_000);
        session.idle.unref();
      }
    }
  }
}

/** Only authenticated bot identities opt into persistent cookies; guests stay ephemeral. */
export function persistentLightpandaPool(directory: string) {
  const persistent = (id: string) =>
    (id.startsWith("mausbot:") && !id.startsWith("mausbot:guest:")) || id.startsWith("bot-thread:");
  const cookieFile = (id: string) =>
    NodePath.join(directory, NodeCrypto.createHash("sha256").update(id).digest("hex") + ".json");
  return new LightpandaPool(
    (executable, id) => {
      if (!persistent(id)) return new LightpandaProcess(executable);
      NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = cookieFile(id);
      let exists = false;
      try {
        const stat = NodeFS.lstatSync(file);
        if (!stat.isFile() || stat.size > MAX_FRAME_BYTES)
          throw new Error("Invalid saved browser cookies.");
        const cookies: unknown = JSON.parse(NodeFS.readFileSync(file, "utf8"));
        if (
          !Array.isArray(cookies) ||
          !cookies.every(
            (cookie: unknown) =>
              cookie !== null &&
              typeof cookie === "object" &&
              "name" in cookie &&
              typeof cookie.name === "string" &&
              "value" in cookie &&
              typeof cookie.value === "string" &&
              "domain" in cookie &&
              typeof cookie.domain === "string",
          )
        )
          throw new Error("Invalid saved browser cookies.");
        exists = true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
          throw new Error(
            "Saved browser cookies could not be read; the existing profile was preserved.",
            { cause: error },
          );
      }
      return new LightpandaProcess(executable, [
        "mcp",
        ...(exists ? ["--cookie", file] : []),
        "--cookie-jar",
        file,
      ]);
    },
    async (id) => {
      if (persistent(id)) await NodeFS.promises.rm(cookieFile(id), { force: true });
    },
  );
}
