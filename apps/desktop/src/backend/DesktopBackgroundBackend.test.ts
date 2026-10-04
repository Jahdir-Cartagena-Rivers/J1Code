// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it, vi } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeStream from "node:stream";
import * as Option from "effect/Option";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import {
  backgroundEnabled,
  backgroundPipe,
  backgroundRequest,
  readBackgroundRecord,
  stageBackgroundRuntime,
  ensureBackgroundServer,
} from "./DesktopBackgroundBackend.ts";
import type { BackgroundRecord } from "./DesktopBackgroundBackend.ts";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeChildProcess>()),
  spawn: vi.fn(),
}));

describe("desktop background backend", () => {
  it.each(["same-version", "upgrade", "stage-failure", "stop-failure"] as const)(
    "%s launch preserves or replaces the owned runtime without a second writer",
    async (scenario) => {
      // oxlint-disable-next-line t3code/no-global-process-runtime -- This fixture exercises Windows named pipes.
      if (NodeOS.platform() !== "win32") return;
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-background-upgrade-"));
      const sourceRuntimeDir = NodePath.join(root, "app");
      const baseDir = NodePath.join(root, "home");
      const executablePath = NodePath.join(sourceRuntimeDir, "J1.exe");
      const entryPath = NodePath.join(sourceRuntimeDir, "server.cjs");
      const workerPath = NodePath.join(sourceRuntimeDir, "worker.cjs");
      const recordFile = NodePath.join(baseDir, "background", "server.json");
      const options = { baseDir, sourceRuntimeDir, workerPath, version: "j1.22" };
      let record: BackgroundRecord = {
        protocol: 1,
        hostPid: 11111,
        serverPid: 22222,
        version: scenario === "same-version" ? options.version : "j1.17",
        executablePath: NodePath.join(root, "old", "J1.exe"),
        entryPath: NodePath.join(root, "old", "server.cjs"),
        bootstrap: {
          mode: "desktop",
          noBrowser: true,
          port: 4888,
          t3Home: baseDir,
          host: "127.0.0.1",
          desktopBootstrapToken: "retained-token",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        },
        secret: "a".repeat(64),
      };
      const old = record;
      const livePids = new Set([record.hostPid, record.serverPid]);
      const steps: string[] = [];
      const processAlive = vi.spyOn(process, "kill").mockImplementation((pid) => {
        if (livePids.has(pid)) return true;
        throw Object.assign(new Error("not running"), { code: "ESRCH" });
      });
      const control = () =>
        NodeNet.createServer((socket) => {
          socket.on("data", (chunk) => {
            const request = JSON.parse(chunk.toString()) as { secret: string; method: string };
            expect(request.secret).toBe(record.secret);
            if (request.method === "stop") {
              steps.push("stop");
              if (scenario === "stop-failure") {
                socket.end("{}\n");
                return;
              }
              socket.end(
                `${JSON.stringify({ hostPid: record.hostPid, serverPid: record.serverPid })}\n`,
              );
              server.close(() => {
                livePids.clear();
                steps.push("stopped");
              });
            } else {
              socket.end(
                `${JSON.stringify({ hostPid: record.hostPid, serverPid: record.serverPid })}\n`,
              );
            }
          });
        });
      let server = control();
      const listen = () =>
        new Promise<void>((resolve) => server.listen(backgroundPipe(baseDir), resolve));
      await NodeFSP.mkdir(NodePath.dirname(recordFile), { recursive: true });
      await NodeFSP.writeFile(recordFile, JSON.stringify(record));
      await listen();
      const spawn = vi.mocked(NodeChildProcess.spawn).mockImplementation((file, args) => {
        expect(livePids.size).toBe(0);
        steps.push("spawn");
        expect(file).not.toBe(old.executablePath);
        const child = new NodeChildProcess.ChildProcess();
        child.stdin = new NodeStream.PassThrough();
        child.stdin.once("data", (chunk: Buffer) => {
          const input = JSON.parse(chunk.toString()) as BackgroundRecord;
          record = { ...input, hostPid: 33333, serverPid: 44444 };
          expect(record.version).toBe(options.version);
          expect(record.bootstrap.desktopBootstrapToken).toBe("retained-token");
          expect(record.bootstrap.port).toBe(4888);
          expect(args?.[0]).toBe(
            NodePath.join(NodePath.dirname(record.executablePath), "worker.cjs"),
          );
          server = control();
          void listen().then(async () => {
            livePids.add(record.hostPid);
            livePids.add(record.serverPid);
            await NodeFSP.writeFile(recordFile, JSON.stringify(record));
          });
        });
        queueMicrotask(() => child.emit("spawn"));
        return child;
      });
      try {
        if (scenario !== "stage-failure") {
          await NodeFSP.mkdir(sourceRuntimeDir);
          await NodeFSP.writeFile(executablePath, "executable");
          await NodeFSP.writeFile(entryPath, "server");
          await NodeFSP.writeFile(workerPath, "worker");
        }
        const launch = ensureBackgroundServer(
          {
            executablePath,
            entryPath,
            args: [],
            cwd: root,
            env: {},
            extendEnv: false,
            bootstrap: old.bootstrap,
            httpBaseUrl: new URL("http://127.0.0.1:4888"),
            captureOutput: false,
            bootstrapDelivery: "fd3",
            preflightFailure: Option.none(),
          },
          options,
        );
        if (scenario === "stage-failure" || scenario === "stop-failure") {
          await expect(launch).rejects.toThrow();
          expect(spawn).not.toHaveBeenCalled();
          expect(livePids.has(old.serverPid)).toBe(true);
          expect(steps).toEqual(scenario === "stage-failure" ? [] : ["stop"]);
        } else {
          const result = await launch;
          expect(result.version).toBe(options.version);
          expect(steps).toEqual(scenario === "same-version" ? [] : ["stop", "stopped", "spawn"]);
          if (scenario === "same-version") expect(result).toEqual(old);
          else
            expect(result.entryPath).toBe(
              NodePath.join(NodePath.dirname(result.executablePath), "server.cjs"),
            );
        }
      } finally {
        spawn.mockReset();
        processAlive.mockRestore();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("enables only packaged Windows desktops", () => {
    expect(backgroundEnabled({ platform: "win32", isPackaged: true })).toBe(true);
    expect(backgroundEnabled({ platform: "win32", isPackaged: false })).toBe(false);
    expect(backgroundEnabled({ platform: "linux", isPackaged: true })).toBe(false);
  });

  it("retains immutable runtime files across source replacement and version changes", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-background-runtime-"));
    try {
      const sourceRuntimeDir = NodePath.join(root, "portable");
      await NodeFSP.mkdir(NodePath.join(sourceRuntimeDir, "resources"), { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(sourceRuntimeDir, "resources", "server.asar"),
        "original archive",
      );
      const options = {
        baseDir: NodePath.join(root, "home"),
        version: "j1.4",
        workerPath: "unused",
        sourceRuntimeDir,
      };
      const first = await stageBackgroundRuntime(options);
      await NodeFSP.writeFile(
        NodePath.join(sourceRuntimeDir, "resources", "server.asar"),
        "new archive",
      );
      expect(await stageBackgroundRuntime(options)).toBe(first);
      const next = await stageBackgroundRuntime({ ...options, version: "j1.5" });
      expect(next).not.toBe(first);
      expect(await NodeFSP.readFile(NodePath.join(first, "resources", "server.asar"), "utf8")).toBe(
        "original archive",
      );
      expect(await NodeFSP.readFile(NodePath.join(next, "resources", "server.asar"), "utf8")).toBe(
        "new archive",
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects corrupt/unknown state instead of treating it as a stopped server", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-background-state-"));
    try {
      expect(await readBackgroundRecord(root)).toBeUndefined();
      await NodeFSP.mkdir(NodePath.join(root, "background"));
      await NodeFSP.writeFile(NodePath.join(root, "background", "server.json"), '{"protocol":999}');
      await expect(readBackgroundRecord(root)).rejects.toThrow();
      await NodeFSP.writeFile(NodePath.join(root, "background", "server.json"), "partial write");
      await expect(readBackgroundRecord(root)).rejects.toThrow();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("uses an authenticated local control request and rejects malformed replies", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-background-control-"));
    // oxlint-disable-next-line t3code/no-global-process-runtime -- This test exercises actual Windows named pipes.
    const isWindows = NodeOS.platform() === "win32";
    const pipe = isWindows ? backgroundPipe(root) : NodePath.join(root, "control.sock");
    if (!isWindows) {
      await NodeFSP.rm(root, { recursive: true });
      return;
    }
    let request = "";
    let reply = '{"serverPid":123,"hostPid":456}\n';
    const server = NodeNet.createServer((socket) => {
      socket.on("data", (chunk) => {
        request = chunk.toString();
        socket.end(reply);
      });
    });
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
    try {
      expect(await backgroundRequest(root, "private-secret", "status")).toEqual({
        serverPid: 123,
        hostPid: 456,
      });
      expect(JSON.parse(request)).toEqual({ secret: "private-secret", method: "status" });
      reply = "{}\n";
      await expect(backgroundRequest(root, "private-secret", "status")).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
