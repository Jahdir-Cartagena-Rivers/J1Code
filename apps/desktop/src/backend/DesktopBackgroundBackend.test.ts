// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";
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
} from "./DesktopBackgroundBackend.ts";

describe("desktop background backend", () => {
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
