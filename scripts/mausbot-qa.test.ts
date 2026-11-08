// @effect-diagnostics nodeBuiltinImport:off - Exercises the native filesystem launcher boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { acquireQaLease, mausbotQaEnvironment } from "./mausbot-qa.ts";

describe("reusable Mausbot QA environment", () => {
  it("rejects a second launcher on the same profile and permits reuse after release", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-qa-lease-test-"));
    try {
      const home = NodePath.join(root, "qa");
      const release = await acquireQaLease(home);
      await expect(acquireQaLease(home)).rejects.toThrow("already owns");
      await release();
      await release();
      const next = await acquireQaLease(home);
      await next();
      expect(await NodeFSP.readdir(root)).toEqual([]);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("reuses existing resources and a worktree-owned profile without creating candidate copies", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-qa-launcher-test-"));
    try {
      const resources = NodePath.join(root, "resources");
      const ui = NodePath.join(root, "dist");
      await NodeFSP.mkdir(resources);
      await NodeFSP.mkdir(ui);
      await NodeFSP.writeFile(NodePath.join(resources, "runtime.zip"), "fixture archive");
      await NodeFSP.writeFile(NodePath.join(ui, "index.html"), "fixture ui");
      const first = await mausbotQaEnvironment(resources, ui);
      const second = await mausbotQaEnvironment(resources, ui);
      expect(second).toEqual(first);
      expect(first.T3CODE_HOME).toBe(NodePath.resolve(import.meta.dirname, "../.t3/mausbot-qa"));
      expect((await NodeFSP.readdir(root)).sort()).toEqual(["dist", "resources"]);
      await NodeFSP.unlink(NodePath.join(ui, "index.html"));
      await expect(mausbotQaEnvironment(resources, ui)).rejects.toThrow();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
