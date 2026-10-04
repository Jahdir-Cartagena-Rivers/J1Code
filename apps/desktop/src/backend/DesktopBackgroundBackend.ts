// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// The detached host owns the process lifetime independently of Electron's scope.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { DesktopBackendBootstrap, PositiveInt } from "@t3tools/contracts";
import type { DesktopBackendStartConfig } from "./DesktopBackendManager.ts";

const RecordSchema = Schema.Struct({
  protocol: Schema.Literal(1),
  hostPid: PositiveInt,
  serverPid: PositiveInt,
  version: Schema.String,
  executablePath: Schema.String,
  entryPath: Schema.String,
  bootstrap: DesktopBackendBootstrap,
  secret: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type BackgroundRecord = typeof RecordSchema.Type;
const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(RecordSchema));
const decodeHostInput = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      ...RecordSchema.fields,
      hostPid: Schema.Int,
      serverPid: Schema.Int,
    }),
  ),
);
const RequestSchema = Schema.Struct({
  secret: Schema.String,
  method: Schema.Literals(["status", "stop"]),
});
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(RequestSchema));
const ResponseSchema = Schema.Struct({ serverPid: Schema.Int, hostPid: Schema.Int });
const decodeResponse = Schema.decodeUnknownSync(Schema.fromJsonString(ResponseSchema));
export interface BackgroundOptions {
  readonly baseDir: string;
  readonly version: string;
  readonly workerPath: string;
  readonly sourceRuntimeDir: string;
}

export const backgroundEnabled = (input: { platform: string; isPackaged: boolean }) =>
  input.platform === "win32" && input.isPackaged;
const recordPath = (baseDir: string) => NodePath.join(baseDir, "background", "server.json");
export const backgroundPipe = (baseDir: string) =>
  `\\\\.\\pipe\\j1-background-${NodeCrypto.createHash("sha256").update(NodePath.resolve(baseDir).toLowerCase()).digest("hex").slice(0, 32)}`;

export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export async function readBackgroundRecord(baseDir: string): Promise<BackgroundRecord | undefined> {
  let raw: string;
  try {
    raw = await NodeFSP.readFile(recordPath(baseDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  // Unknown protocol/corrupt state fails closed: never silently open a second database writer.
  let record: BackgroundRecord;
  try {
    record = decodeRecord(raw);
  } catch {
    throw new Error("Invalid J1 background state. Refusing a second server.");
  }
  if (!isProcessAlive(record.hostPid)) {
    if (isProcessAlive(record.serverPid))
      throw new Error(
        "J1 background host is unavailable but its server is still running. Refusing a second server.",
      );
    return undefined;
  }
  const status = await backgroundRequest(baseDir, record.secret, "status");
  if (status.hostPid !== record.hostPid || status.serverPid !== record.serverPid) {
    throw new Error("J1 background server identity changed. Refusing to attach.");
  }
  return record;
}

export function backgroundRequest(baseDir: string, secret: string, method: "status" | "stop") {
  return new Promise<typeof ResponseSchema.Type>((resolve, reject) => {
    const socket = NodeNet.createConnection(backgroundPipe(baseDir));
    let body = "";
    socket.setTimeout(method === "stop" ? 15_000 : 2_000, () =>
      socket.destroy(new Error("J1 background control timed out.")),
    );
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`${JSON.stringify({ secret, method })}\n`));
    socket.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 16_384) socket.destroy(new Error("Invalid background control response."));
      if (body.includes("\n")) {
        try {
          resolve(decodeResponse(body.trim()));
        } catch (error) {
          reject(error);
        }
        socket.destroy();
      }
    });
    socket.on("end", () => {
      if (!body.includes("\n")) reject(new Error("Background control closed without a response."));
    });
  });
}

export async function stopBackgroundServer(baseDir: string) {
  const record = await readBackgroundRecord(baseDir);
  if (!record) return;
  await backgroundRequest(baseDir, record.secret, "stop");
  // Older hosts acknowledge before their process and database writer have exited.
  // Do not let an update race that shutdown with a second writer.
  for (let attempt = 0; attempt < 150; attempt++) {
    if (!isProcessAlive(record.serverPid) && !isProcessAlive(record.hostPid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("J1 background server did not stop. Refusing a second server.");
}

// Copy the physical Electron distribution, including server.asar.unpacked/native modules.
// An immutable versioned copy survives portable extraction cleanup and later app updates.
export async function stageBackgroundRuntime(options: BackgroundOptions): Promise<string> {
  const key = NodeCrypto.createHash("sha256").update(options.version).digest("hex").slice(0, 20);
  const runtimeDir = NodePath.join(options.baseDir, "background", "runtimes", key);
  const sentinel = NodePath.join(runtimeDir, ".j1-complete");
  try {
    await NodeFSP.access(sentinel);
    return runtimeDir;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await NodeFSP.mkdir(NodePath.dirname(runtimeDir), { recursive: true, mode: 0o700 });
  const staging = await NodeFSP.mkdtemp(`${runtimeDir}.staging-`);
  // Electron patches fs to treat ASAR files as directories. Use its physical-fs API here.
  const physicalFs: typeof NodeFS = process.versions.electron
    ? NodeModule.createRequire(NodePath.join(options.sourceRuntimeDir, "package.json"))(
        "original-fs",
      )
    : NodeFS;
  await physicalFs.promises.cp(options.sourceRuntimeDir, staging, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(staging, ".j1-complete"), options.version, { mode: 0o600 });
  await NodeFSP.rename(staging, runtimeDir);
  return runtimeDir;
}

export async function ensureBackgroundServer(
  config: DesktopBackendStartConfig,
  options: BackgroundOptions,
): Promise<BackgroundRecord> {
  const existing = await readBackgroundRecord(options.baseDir);
  if (existing?.version === options.version) return existing;
  // Stage and validate the replacement before interrupting the old server.
  const runtimeDir = await stageBackgroundRuntime(options);
  const relocate = (file: string) => {
    const relative = NodePath.relative(options.sourceRuntimeDir, file);
    if (relative.startsWith("..") || NodePath.isAbsolute(relative))
      throw new Error("Background runtime file is outside the packaged application.");
    return NodePath.join(runtimeDir, relative);
  };
  const bootstrap = { ...config.bootstrap };
  bootstrap.desktopBackgroundBootstrap = true;
  delete bootstrap.desktopTelemetryFd;
  delete bootstrap.desktopTelemetryControlFd;
  if (bootstrap.resourceMonitorPath)
    bootstrap.resourceMonitorPath = relocate(bootstrap.resourceMonitorPath);
  const input = {
    protocol: 1 as const,
    hostPid: 0,
    serverPid: 0,
    version: options.version,
    executablePath: relocate(config.executablePath),
    entryPath: relocate(config.entryPath),
    bootstrap,
    secret: NodeCrypto.randomBytes(32).toString("hex"),
  };
  if (existing) await stopBackgroundServer(options.baseDir);
  const logPath = NodePath.join(options.baseDir, "background", "server.log");
  const log = NodeFS.openSync(logPath, "a", 0o600);
  try {
    const child = NodeChildProcess.spawn(input.executablePath, [relocate(options.workerPath)], {
      cwd: config.cwd,
      env: { ...process.env, ...config.env, ELECTRON_RUN_AS_NODE: "1" },
      detached: true,
      windowsHide: true,
      stdio: ["pipe", log, log],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.stdin!.on("error", () => undefined);
    child.stdin!.end(`${JSON.stringify(input)}\n`);
    child.unref();
    for (let attempt = 0; attempt < 150; attempt++) {
      const record = await readBackgroundRecord(options.baseDir);
      if (record) return record;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("J1 background host did not start. Inspect background/server.log.");
  } finally {
    NodeFS.closeSync(log);
  }
}

export async function runBackgroundHost(raw: string) {
  const input = decodeHostInput(raw);
  const baseDir = input.bootstrap.t3Home;
  if (!baseDir) throw new Error("Background host requires a private J1 home.");
  let child: ReturnType<typeof NodeChildProcess.spawn> | undefined;
  let stopping = false;
  const stop = async () => {
    if (!child || child.pid === undefined || child.exitCode !== null || stopping) return;
    stopping = true;
    // Only the child handle captured by this host is ever terminated, never a PID read from disk.
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Detached host runs outside the desktop Effect runtime.
    if (NodeOS.platform() === "win32") {
      await new Promise<void>((resolve, reject) => {
        const killer = NodeChildProcess.spawn(
          "taskkill.exe",
          ["/PID", String(child!.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        killer.once("error", reject);
        killer.once("exit", () => resolve());
      });
    } else child.kill("SIGTERM");
  };
  const server = NodeNet.createServer((socket) => {
    let body = "";
    socket.setTimeout(2_000, () => socket.destroy());
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 4096) {
        socket.destroy();
        return;
      }
      if (!body.includes("\n")) return;
      socket.pause();
      void (async () => {
        const request = decodeRequest(body.trim());
        const received = Buffer.from(request.secret);
        const expected = Buffer.from(input.secret);
        if (
          received.length !== expected.length ||
          !NodeCrypto.timingSafeEqual(received, expected)
        ) {
          socket.destroy();
          return;
        }
        if (request.method === "stop") await stop();
        socket.end(`${JSON.stringify({ hostPid: process.pid, serverPid: child?.pid ?? 0 })}\n`);
        if (request.method === "stop") server.close();
      })().catch(() => socket.destroy());
    });
  });
  // Exclusive named pipe is the singleton gate. No backend is spawned until this is owned.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(backgroundPipe(baseDir), resolve);
  });
  try {
    child = NodeChildProcess.spawn(input.executablePath, [input.entryPath, "--bootstrap-fd", "3"], {
      cwd: baseDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      stdio: ["ignore", "inherit", "inherit", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      child!.once("spawn", resolve);
      child!.once("error", reject);
    });
    const bootstrapPipe = child.stdio[3] as import("node:stream").Writable;
    bootstrapPipe.on("error", () => undefined);
    bootstrapPipe.end(`${JSON.stringify(input.bootstrap)}\n`);
    const temporary = `${recordPath(baseDir)}.${process.pid}.tmp`;
    await NodeFSP.writeFile(
      temporary,
      JSON.stringify({ ...input, hostPid: process.pid, serverPid: child.pid }),
      { mode: 0o600 },
    );
    await NodeFSP.rename(temporary, recordPath(baseDir));
    child.once("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      server.close();
    });
    child.once("exit", () => {
      if (!stopping) server.close();
    });
  } catch (error) {
    await stop();
    server.close();
    throw error;
  }
  process.once("SIGTERM", () => void stop().finally(() => server.close()));
  process.once("SIGINT", () => void stop().finally(() => server.close()));
}
