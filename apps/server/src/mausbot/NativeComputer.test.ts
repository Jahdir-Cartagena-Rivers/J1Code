// @effect-diagnostics nodeBuiltinImport:off - Tests the real captured child lifetime with an isolated helper fixture.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { startMausbotComputer } from "./NativeComputer.ts";
import { mausbotChildEnvironment } from "./ChildEnvironment.ts";

describe("isolated native computer host", () => {
  it("retains provider credentials without inheriting private J1 or Node watch state", () => {
    expect(
      mausbotChildEnvironment({
        PATH: "os",
        ANTHROPIC_API_KEY: "fixture",
        J1_SECRET: "private",
        T3CODE_HOME: "live",
        OMB_TOKEN: "private",
        NODE_OPTIONS: "--watch",
        NODE_CHANNEL_FD: "4",
        WATCH_REPORT_DEPENDENCIES: "1",
      }),
    ).toEqual({ PATH: "os", ANTHROPIC_API_KEY: "fixture" });
  });
  it("owns only its helper and closes it through its parent pipe", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-computer-host-test-"));
    await NodeFSP.mkdir(NodePath.join(root, "native"));
    await NodeFSP.writeFile(
      NodePath.join(root, "native/j1-computer-host.mjs"),
      `import fs from 'node:fs'; fs.writeFileSync('pid',String(process.pid)); console.log(JSON.stringify({type:'j1:computer-ready',socketPath:'fixture-socket'})); process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));`,
    );
    const host = await startMausbotComputer(root);
    try {
      const pid = Number(await NodeFSP.readFile(NodePath.join(root, "native/pid"), "utf8"));
      expect(host.descriptor.socketPath).toBe("fixture-socket");
      expect(host.descriptor.mcpEnv.CUA_DRIVER_HOST_BUNDLE_ID).toMatch(
        /^com\.j1code\.mausbot-runtime\.[a-f0-9]{24}$/,
      );
      await Promise.all([host.stop(), host.stop()]);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await host.stop();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("reports an SDK host failure without crashing the caller", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-computer-host-test-"));
    try {
      await NodeFSP.mkdir(NodePath.join(root, "native"));
      await NodeFSP.writeFile(
        NodePath.join(root, "native/j1-computer-host.mjs"),
        "process.exit(23)",
      );
      await expect(startMausbotComputer(root)).rejects.toThrow("exited before becoming ready");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
