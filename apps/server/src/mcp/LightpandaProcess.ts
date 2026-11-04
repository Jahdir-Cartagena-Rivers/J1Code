// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off - Node subprocess callbacks own timeout cleanup independently of Effect fibers.
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
  private readonly sessions = new Map<
    string,
    {
      executable: string;
      process: LightpandaProcess;
      ready: Promise<void>;
      idle: ReturnType<typeof NodeTimers.setTimeout>;
    }
  >();
  close(id: string) {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    NodeTimers.clearTimeout(session.idle);
    session.process.close();
    return true;
  }
  closeAll() {
    for (const id of this.sessions.keys()) this.close(id);
  }
  async request(
    id: string,
    executable: string,
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ) {
    if (!executable.trim())
      throw new Error("Configure the native Lightpanda executable in Integrations settings first.");
    if (signal?.aborted) throw new Error("Background browser request cancelled.");
    let session = this.sessions.get(id);
    if (session && session.executable !== executable) {
      this.close(id);
      session = undefined;
    }
    if (!session) {
      if (this.sessions.size >= 8)
        throw new Error(
          "Eight background browser sessions are active. Close one before opening another.",
        );
      const process = new LightpandaProcess(executable);
      const idle = NodeTimers.setTimeout(() => this.close(id), 180_000);
      idle.unref();
      session = { executable, process, ready: process.initialize(), idle };
      this.sessions.set(id, session);
    }
    NodeTimers.clearTimeout(session.idle);
    const abort = () => this.close(id);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await session.ready;
      return await session.process.request(method, params);
    } catch (error) {
      this.close(id);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (this.sessions.get(id) === session) {
        session.idle = NodeTimers.setTimeout(() => this.close(id), 180_000);
        session.idle.unref();
      }
    }
  }
}
