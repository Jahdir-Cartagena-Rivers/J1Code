// @effect-diagnostics nodeBuiltinImport:off -- isolated filesystem fixtures.
import { it, expect } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { runTransfer } from "./transfer.ts";
it("requires stopped confirmation before reading password or source", async () => {
  await expect(runTransfer("export", "missing", "missing", "missing", false)).rejects.toThrow(
    "--stopped",
  );
});
it("uses password files and rejects live source and wrong passwords without leaving a home", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-transfer-cli-"));
  try {
    const home = NodePath.join(root, "home");
    const userdata = NodePath.join(home, "userdata");
    await NodeFSP.mkdir(userdata, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(userdata, "state.sqlite"),
      Buffer.alloc(8 * 1024 * 1024, 65),
    );
    const password = NodePath.join(root, "password");
    await NodeFSP.writeFile(password, "test-password-123\n");
    const archive = NodePath.join(root, "archive");
    await NodeFSP.writeFile(
      NodePath.join(userdata, "server-runtime.json"),
      JSON.stringify({ pid: process.pid }),
    );
    await expect(runTransfer("export", home, archive, password, true)).rejects.toThrow("Stop");
    await NodeFSP.rm(NodePath.join(userdata, "server-runtime.json"));
    await runTransfer("export", home, archive, password, true);
    await NodeFSP.writeFile(password, "wrong-password-123");
    const target = NodePath.join(root, "target");
    await expect(runTransfer("import", target, archive, password, true)).rejects.toThrow();
    await expect(NodeFSP.stat(target)).rejects.toThrow();
    await NodeFSP.writeFile(password, "test-password-123");
    await runTransfer("import", target, archive, password, true);
    expect((await NodeFSP.stat(NodePath.join(target, "userdata/state.sqlite"))).size).toBe(
      8 * 1024 * 1024,
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
