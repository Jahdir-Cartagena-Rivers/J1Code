// @effect-diagnostics nodeBuiltinImport:off - This boundary owns a native child and its loopback connection.
// @effect-diagnostics globalTimers:off - Node child/socket callbacks clear their own deadlines outside Effect fibers.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as NodeTimers from "node:timers";
import * as NodeStream from "node:stream";
import * as NodeModule from "node:module";
import type {
  MausbotApprovalModeInput,
  ConversationQuery,
  ExternalRouteDelivery,
  ExternalRouteReceiptKey,
} from "@t3tools/contracts";
import { startMausbotComputer } from "./NativeComputer.ts";
import { mausbotChildEnvironment } from "./ChildEnvironment.ts";

export interface MausbotRuntimeOptions {
  readonly platform: NodeJS.Platform;
  readonly memory?: (input: unknown, current: () => boolean) => Promise<unknown>;
  readonly conversationCall?: (input: unknown, current: () => boolean) => Promise<unknown>;
  readonly resources: string;
  readonly dataDir: string;
  readonly executable?: string;
  readonly lightpandaExecutablePath?: string;
}
interface PrivatePort {
  postMessage(message: unknown): void;
}
interface ApprovalCoordinator {
  request(port: PrivatePort, botId: string, mode: string, options?: object): Promise<unknown>;
  receive(port: PrivatePort, message: unknown): boolean;
  rejectProcess(port: PrivatePort): void;
}

async function availablePort() {
  const server = NodeNet.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("Could not allocate runtime port.");
  return address.port;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Owns only its captured child and a J1-local data directory, never the installed Mausbot profile. */
export class MausbotRuntime {
  private readonly options: MausbotRuntimeOptions;
  private child: NodeChildProcess.ChildProcess | undefined;
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private computer: Awaited<ReturnType<typeof startMausbotComputer>> | undefined;
  private token: string | undefined;
  private origin: string | undefined;
  private browserExecutable: string;
  private appliedBrowserExecutable: string | undefined;
  private approvals: ApprovalCoordinator | undefined;
  private privatePort: PrivatePort | undefined;

  constructor(options: MausbotRuntimeOptions) {
    this.options = options;
    this.browserExecutable = options.lightpandaExecutablePath ?? "";
  }

  get running() {
    return this.child !== undefined && this.token !== undefined;
  }
  /** Conversation and routing operations use owned-process IPC, never the browser proxy. */
  async conversation(
    input:
      | ConversationQuery
      | { action: "routeDeliver"; delivery: ExternalRouteDelivery }
      | { action: "routeDeliveryStatus"; key: ExternalRouteReceiptKey },
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.start();
    const child = this.child;
    if (!child?.connected || signal?.aborted)
      throw new Error("Conversation runtime is unavailable.");
    if (this.conversationReads >= 8) throw new Error("Too many conversation reads are open.");
    this.conversationReads++;
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const requestId = NodeCrypto.randomUUID();
        const timer = NodeTimers.setTimeout(
          () => finish(new Error("Conversation read timed out.")),
          15_000,
        );
        const received = (message: unknown) => {
          if (
            !object(message) ||
            message.type !== "j1:conversation-result" ||
            message.requestId !== requestId
          )
            return;
          if (this.child !== child || !child.connected)
            return finish(new Error("Conversation runtime disconnected."));
          finish(
            typeof message.error === "string" ? new Error(message.error) : undefined,
            message.value,
          );
        };
        const ended = () => finish(new Error("Conversation runtime disconnected."));
        const aborted = () => finish(new Error("Conversation read cancelled."));
        const finish = (error?: Error, value?: unknown) => {
          NodeTimers.clearTimeout(timer);
          child.off("message", received);
          child.off("exit", ended);
          child.off("disconnect", ended);
          signal?.removeEventListener("abort", aborted);
          if (error) reject(error);
          else resolve(value);
        };
        child.on("message", received);
        child.once("exit", ended);
        child.once("disconnect", ended);
        signal?.addEventListener("abort", aborted, { once: true });
        if (signal?.aborted) return aborted();
        child.send({ type: "j1:conversation-query", requestId, input }, (error) => {
          if (error) finish(error);
        });
      });
    } finally {
      this.conversationReads--;
    }
  }
  private conversationReads = 0;
  async setApprovalMode(input: MausbotApprovalModeInput) {
    await this.start();
    if (!this.privatePort) throw new Error("The assistant runtime is not connected.");
    if (!this.approvals) {
      const module = NodeModule.createRequire(import.meta.url)(
        NodePath.join(
          this.options.resources,
          "native/host-adapters/electron/approval-trusted-mode.cjs",
        ),
      ) as {
        createTrustedApprovalModeCoordinator(options: {
          randomId: () => string;
        }): ApprovalCoordinator;
      };
      this.approvals = module.createTrustedApprovalModeCoordinator({
        randomId: NodeCrypto.randomUUID,
      });
    }
    return this.approvals.request(this.privatePort, input.botId, input.mode, input.options);
  }
  async setBrowserExecutablePath(executable: string) {
    this.browserExecutable = executable;
    const child = this.child;
    if (!child?.connected || !this.running) return;
    if (this.appliedBrowserExecutable === executable) return;
    const requestId = NodeCrypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = NodeTimers.setTimeout(
        () => finish(new Error("The assistant browser did not apply its new setting.")),
        5_000,
      );
      const received = (message: unknown) => {
        if (
          object(message) &&
          message.type === "j1:browser-applied" &&
          message.requestId === requestId
        )
          finish();
      };
      const exited = () =>
        finish(new Error("The assistant runtime stopped before applying its browser setting."));
      const finish = (error?: Error) => {
        NodeTimers.clearTimeout(timer);
        child.off("message", received);
        child.off("exit", exited);
        if (error) reject(error);
        else resolve();
      };
      child.on("message", received);
      child.once("exit", exited);
      child.send({ type: "j1:browser", executable, requestId }, (error) => {
        if (error) finish(error);
      });
    });
    if (this.child === child) this.appliedBrowserExecutable = executable;
  }

  start(): Promise<void> {
    if (this.stopping) return this.stopping.then(() => this.start());
    if (this.starting) return this.starting;
    if (this.running) return Promise.resolve();
    if (this.child)
      return Promise.reject(new Error("The previous assistant runtime has not stopped."));
    this.starting = this.launch().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async launch() {
    const entry = NodePath.join(this.options.resources, "server", "index.js");
    await NodeFSP.access(entry);
    try {
      await NodeFSP.access(NodePath.join(this.options.resources, "server", "enterprise"));
      throw new Error("The J1 runtime must not contain enterprise code.");
    } catch (error) {
      if (!object(error) || error.code !== "ENOENT") throw error;
    }
    await NodeFSP.mkdir(this.options.dataDir, { recursive: true });
    const port = await availablePort();
    const webhookPort = await availablePort();
    if (port === webhookPort) throw new Error("Runtime ports collided. Try starting again.");
    const owner = NodeCrypto.randomBytes(32).toString("base64url");
    const origin = `http://127.0.0.1:${port}`;
    const child = NodeChildProcess.spawn(this.options.executable ?? process.execPath, [entry], {
      cwd: this.options.resources,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: {
        ...mausbotChildEnvironment(),
        ELECTRON_RUN_AS_NODE: "1",
        OMB_PORT: String(port),
        OMB_WEBHOOK_PORT: String(webhookPort),
        OMB_DATA_DIR: this.options.dataDir,
        OMB_STATIC_DIR: NodePath.join(this.options.resources, "ui"),
        OMB_LOOPBACK_TRUST: "service",
        OMB_CLI_OWNER_STDIN: "1",
        OMB_DESKTOP_PARENT: "0",
        OMB_DEV_TRUST_LOCAL_BROWSER: "0",
        J1_MAUSBOT_MANAGED: "1",
        J1_MAUSBOT_LIGHTPANDA_PATH: this.browserExecutable,
      },
    });
    const { stdin, stdout, stderr } = child;
    if (!stdin || !stdout || !stderr) {
      child.kill();
      throw new Error("Could not open the managed runtime pipes.");
    }
    this.child = child;
    const privatePort: PrivatePort = {
      postMessage: (message) => {
        if (!child.connected || this.child !== child)
          throw new Error("The assistant runtime is disconnected.");
        child.send(message as NodeChildProcess.Serializable, (error) => {
          if (error) this.approvals?.rejectProcess(privatePort);
        });
      },
    };
    this.privatePort = privatePort;
    const memoryRequests = new Map<string, { cancelled: boolean }>();
    child.on("message", (message) => {
      this.approvals?.receive(privatePort, message);
      if (
        object(message) &&
        (message.type === "j1:hive-cancel" || message.type === "j1:conversation-host-cancel") &&
        typeof message.requestId === "string"
      ) {
        const request = memoryRequests.get(message.requestId);
        if (request) request.cancelled = true;
        return;
      }
      if (
        !object(message) ||
        (message.type !== "j1:hive-request" && message.type !== "j1:conversation-host-request") ||
        typeof message.requestId !== "string" ||
        message.requestId.length > 100
      )
        return;
      const hostConversation = message.type === "j1:conversation-host-request";
      const replyType = hostConversation ? "j1:conversation-host-result" : "j1:hive-result";
      const operation = { cancelled: false };
      const current = () => this.child === child && child.connected && !operation.cancelled;
      if (memoryRequests.size >= 8 || memoryRequests.has(message.requestId)) {
        if (current())
          child.send({
            type: replyType,
            requestId: message.requestId,
            error: "Too many memory requests are open.",
          });
        return;
      }
      memoryRequests.set(message.requestId, operation);
      Promise.resolve()
        .then(() => {
          const handle = hostConversation ? this.options.conversationCall : this.options.memory;
          if (!handle || !current()) throw new Error("The J1 host is unavailable.");
          return handle(message.input, current);
        })
        .then(
          (value) => {
            if (current()) child.send({ type: replyType, requestId: message.requestId, value });
          },
          () => {
            if (current())
              child.send({
                type: replyType,
                requestId: message.requestId,
                error: hostConversation
                  ? "The shared conversation request could not complete."
                  : "Hive Mind could not complete extended recall. Local notes are preserved; check the connection in J1 Settings.",
              });
          },
        )
        .finally(() => {
          memoryRequests.delete(message.requestId as string);
        });
    });
    stdout.setEncoding("utf8");
    stderr.setEncoding("utf8");
    stderr.resume();
    child.on("error", () => {
      if (this.child !== child) return;
      this.token = undefined;
      this.origin = undefined;
    });
    child.on("exit", () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.approvals?.rejectProcess(privatePort);
      this.privatePort = undefined;
      this.appliedBrowserExecutable = undefined;
      this.origin = undefined;
      this.token = undefined;
      const computer = this.computer;
      this.computer = undefined;
      void computer?.stop().catch(() => undefined);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let buffer = "";
        const timer = NodeTimers.setTimeout(
          () => finish(new Error("Mausbot startup timed out.")),
          30_000,
        );
        const read = (chunk: string) => {
          buffer = (buffer + chunk).slice(-8192);
          if (buffer.includes(`openmausbot server on ${origin}`)) finish();
        };
        const failed = () => finish(new Error("Mausbot exited before startup completed."));
        const error = () => finish(new Error("Could not launch the Mausbot runtime."));
        const finish = (failure?: Error) => {
          NodeTimers.clearTimeout(timer);
          stdout.off("data", read);
          child.off("exit", failed);
          child.off("error", error);
          if (failure) reject(failure);
          else resolve();
        };
        stdout.on("data", read);
        child.once("exit", failed);
        child.once("error", error);
        stdin.end(`${owner}\n`);
      });
      const edition = await this.json(origin, "/api/edition", {});
      if (!object(edition) || edition.edition !== "oss")
        throw new Error("Only the OSS runtime can be started by J1.");
      const opened = await this.json(origin, "/api/auth/pairing", {
        method: "POST",
        headers: { "x-openmausbot-cli-owner": owner },
        body: JSON.stringify({ label: "J1 managed runtime", scopes: ["admin", "client"] }),
      });
      if (!object(opened) || typeof opened.code !== "string")
        throw new Error("Runtime pairing failed.");
      const paired = await this.json(origin, "/api/auth/pair", {
        method: "POST",
        body: JSON.stringify({ code: opened.code, label: "J1 managed runtime" }),
      });
      if (!object(paired) || typeof paired.token !== "string")
        throw new Error("Runtime authentication failed.");
      if (this.child !== child) throw new Error("Runtime stopped during authentication.");
      this.origin = origin;
      this.token = paired.token;
      await this.setBrowserExecutablePath(this.browserExecutable);
      if (this.options.platform === "win32") {
        const native = NodePath.join(this.options.resources, "native", "cua-driver.exe");
        const available = await NodeFSP.access(native).then(
          () => true,
          () => false,
        );
        if (available) {
          this.computer = await startMausbotComputer(this.options.resources);
          if (this.child !== child) {
            await this.computer.stop();
            this.computer = undefined;
            throw new Error("Runtime stopped while starting its computer helper.");
          }
          const computer = this.computer;
          await new Promise<void>((resolve, reject) => {
            const requestId = NodeCrypto.randomUUID();
            const timer = NodeTimers.setTimeout(
              () =>
                finish(new Error("The assistant did not accept its native computer connection.")),
              5_000,
            );
            const received = (value: unknown) => {
              if (
                object(value) &&
                value.type === "j1:computer-applied" &&
                value.requestId === requestId
              )
                finish();
            };
            const exited = () =>
              finish(new Error("The assistant stopped before accepting its computer connection."));
            const finish = (error?: Error) => {
              NodeTimers.clearTimeout(timer);
              child.off("message", received);
              child.off("exit", exited);
              if (error) reject(error);
              else resolve();
            };
            child.on("message", received);
            child.once("exit", exited);
            child.send(
              { type: "openmausbot:local-computer", connection: computer.descriptor, requestId },
              (error) => {
                if (error) finish(error);
              },
            );
          });
          void computer.closed.then(() => {
            if (this.computer !== computer) return;
            this.computer = undefined;
            if (this.child === child && child.connected)
              child.send({ type: "openmausbot:local-computer", connection: null });
          });
        }
      }
    } catch (error) {
      if (this.child === child) await this.stop();
      throw error;
    }
  }

  private json(
    origin: string,
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, value?: unknown) => {
        if (settled) return;
        settled = true;
        NodeTimers.clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const request = NodeHttp.request(
        new URL(path, origin),
        {
          method: init.method ?? "GET",
          headers: { "content-type": "application/json", ...init.headers },
        },
        (response) => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            response.resume();
            finish(new Error(`Runtime request failed (${response.statusCode ?? 0}).`));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > 4 * 1024 * 1024) {
              finish(new Error("The runtime response exceeded 4 MiB."));
              response.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.once("error", () => finish(new Error("The runtime response was interrupted.")));
          response.once("end", () => {
            try {
              finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
            } catch {
              finish(new Error("The runtime returned invalid JSON."));
            }
          });
        },
      );
      const timer = NodeTimers.setTimeout(() => {
        finish(new Error("The runtime request timed out."));
        request.destroy();
      }, 15_000);
      request.once("error", () => finish(new Error("The runtime connection failed.")));
      request.end(init.body);
    });
  }

  /** Internal API only; callers must separately authorize the J1 user and operation. */
  async request(path: string, method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown) {
    if (!/^\/api\/(?:bots|threads)(?:\/[A-Za-z0-9_-]+)*$/.test(path))
      throw new Error("This upstream API route is not exposed by J1.");
    if (method === "GET" && body !== undefined)
      throw new Error("GET requests cannot contain a body.");
    if (body !== undefined && Buffer.byteLength(JSON.stringify(body)) > 256 * 1024)
      throw new Error("The runtime request exceeded 256 KiB.");
    if (!this.origin || !this.token) throw new Error("The Mausbot runtime is not running.");
    return this.json(this.origin, path, {
      method,
      headers: { authorization: `Bearer ${this.token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** J1 authorizes the owner before this transport injects its private upstream credential. */
  async forward(
    path: string,
    method: string,
    contentType?: string,
    body?: Uint8Array,
    signal?: AbortSignal,
    frameOrigin?: string,
  ) {
    const pathname = path.split("?")[0]!;
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      /[\\\x00-\x20#]|%2e|%2f|%5c|(?:^|\/)\.\.(?:\/|$)/i.test(pathname)
    )
      throw new Error("Invalid runtime path.");
    if (!["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"].includes(method))
      throw new Error("Unsupported runtime method.");
    if (/^\/api\/updates(?:\/|$)/.test(pathname))
      throw new Error("J1 Code owns updates for the bundled assistant runtime.");
    if (
      /^\/api\/(?:auth|internal)(?:\/|$)/.test(pathname) &&
      !(pathname === "/api/auth/session" && method === "GET")
    )
      throw new Error("This runtime authentication route is private to J1.");
    if ((method === "GET" || method === "HEAD") && body?.byteLength)
      throw new Error("Read requests cannot contain a body.");
    if ((body?.byteLength ?? 0) > 32 * 1024 * 1024)
      throw new Error("Runtime upload exceeded 32 MiB.");
    if (!this.origin || !this.token) throw new Error("The Mausbot runtime is not running.");
    const origin = this.origin;
    const token = this.token;
    return new Promise<Response>((resolve, reject) => {
      const request = NodeHttp.request(
        new URL(path, origin),
        {
          method,
          ...(signal ? { signal } : {}),
          headers: {
            authorization: `Bearer ${token}`,
            ...(contentType ? { "content-type": contentType } : {}),
          },
        },
        (response) => {
          const status = response.statusCode ?? 502;
          if (status >= 300 && status < 400) {
            response.resume();
            reject(new Error("Runtime redirects are not forwarded."));
            return;
          }
          const headers = new Headers({
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          });
          for (const key of [
            "content-type",
            "content-disposition",
            "content-security-policy",
            "x-content-type-options",
          ]) {
            const value = response.headers[key];
            if (typeof value === "string") headers.set(key, value);
          }
          const policy = headers.get("content-security-policy");
          if (policy)
            headers.set(
              "content-security-policy",
              policy.replace(
                /frame-ancestors[^;]*/i,
                `frame-ancestors 'self'${frameOrigin ? ` ${frameOrigin}` : ""}`,
              ),
            );
          resolve(
            new Response(
              method === "HEAD" || status === 204 || status === 304
                ? null
                : (NodeStream.Readable.toWeb(response) as ReadableStream<Uint8Array>),
              { status: status === 401 ? 502 : status, headers },
            ),
          );
        },
      );
      request.once("error", () => reject(new Error("The runtime connection failed.")));
      request.setTimeout(30_000, () =>
        request.destroy(new Error("The runtime request timed out.")),
      );
      request.end(body);
    });
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopChild().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  private async stopChild() {
    const child = this.child;
    this.token = undefined;
    this.origin = undefined;
    const computer = this.computer;
    this.computer = undefined;
    if (!child || child.exitCode !== null) {
      await computer?.stop();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const force = NodeTimers.setTimeout(() => child.kill(), 10_000);
      const timeout = NodeTimers.setTimeout(
        () =>
          reject(
            new Error("The assistant runtime has not stopped. A replacement was not started."),
          ),
        15_000,
      );
      child.once("exit", () => {
        NodeTimers.clearTimeout(force);
        NodeTimers.clearTimeout(timeout);
        resolve();
      });
      if (child.connected) child.send({ type: "j1:shutdown" });
      else child.kill();
    });
    await computer?.stop();
    if (this.child === child) this.child = undefined;
  }
}
