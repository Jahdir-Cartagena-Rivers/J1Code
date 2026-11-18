// @effect-diagnostics nodeBuiltinImport:off - Real filesystem and killed-child regression fixtures.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { codexNpmRecovery } from "./codexNpmRecovery.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});
const packageFile = (prefix: string) =>
  NodePath.join(prefix, "node_modules/@openai/codex/package.json");
const probe = async (prefix: string) =>
  NodeFSP.readFile(packageFile(prefix), "utf8").then(
    (text) => text.startsWith("working:"),
    () => false,
  );
async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-codex-recovery-"));
  roots.push(root);
  const prefix = NodePath.join(root, "npm prefix");
  const directory = NodePath.join(root, "journal");
  await NodeFSP.mkdir(NodePath.dirname(packageFile(prefix)), { recursive: true });
  await NodeFSP.writeFile(packageFile(prefix), "working:old");
  await NodeFSP.writeFile(NodePath.join(prefix, "codex.cmd"), "old launcher");
  await NodeFSP.mkdir(NodePath.join(prefix, "node_modules/opencode-ai"));
  await NodeFSP.writeFile(
    NodePath.join(prefix, "node_modules/opencode-ai/package.json"),
    "neighbor",
  );
  return { root, prefix, directory, store: codexNpmRecovery(directory, probe) };
}
describe("Codex npm recovery", () => {
  it("restores package and launchers after a failed update without touching neighboring packages", async () => {
    const { prefix, store } = await fixture();
    const tx = await store.prepare(prefix);
    await NodeFSP.rm(NodePath.dirname(packageFile(prefix)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(prefix, "codex.cmd"), "broken");
    await NodeFSP.writeFile(NodePath.join(prefix, "codex.ps1"), "new partial shim");
    await tx.close();
    await tx.close();
    expect(await NodeFSP.readFile(packageFile(prefix), "utf8")).toBe("working:old");
    expect(await NodeFSP.readFile(NodePath.join(prefix, "codex.cmd"), "utf8")).toBe("old launcher");
    await expect(NodeFSP.stat(NodePath.join(prefix, "codex.ps1"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await NodeFSP.readFile(
        NodePath.join(prefix, "node_modules/opencode-ai/package.json"),
        "utf8",
      ),
    ).toBe("neighbor");
  });
  it("commits a verified replacement and leaves no pending journal", async () => {
    const { prefix, store } = await fixture();
    const tx = await store.prepare(prefix);
    await NodeFSP.mkdir(NodePath.dirname(packageFile(tx.stagingPrefix)), { recursive: true });
    await NodeFSP.writeFile(packageFile(tx.stagingPrefix), "working:new");
    await NodeFSP.writeFile(NodePath.join(tx.stagingPrefix, "codex.cmd"), "new launcher");
    expect(await NodeFSP.readFile(packageFile(prefix), "utf8")).toBe("working:old");
    await tx.publish();
    await tx.commit();
    await tx.close();
    await store.recover();
    expect(await NodeFSP.readFile(packageFile(prefix), "utf8")).toBe("working:new");
  });
  it("never publishes an incomplete staged install", async () => {
    const { prefix, store } = await fixture();
    const tx = await store.prepare(prefix);
    await NodeFSP.mkdir(NodePath.dirname(packageFile(tx.stagingPrefix)), { recursive: true });
    await NodeFSP.writeFile(packageFile(tx.stagingPrefix), "broken");
    await expect(tx.publish()).rejects.toThrow("staged Codex");
    await tx.close();
    expect(await NodeFSP.readFile(packageFile(prefix), "utf8")).toBe("working:old");
  });
  it("rolls back a published replacement when final verification is rejected", async () => {
    const { prefix, store } = await fixture();
    const tx = await store.prepare(prefix);
    await NodeFSP.mkdir(NodePath.dirname(packageFile(tx.stagingPrefix)), { recursive: true });
    await NodeFSP.writeFile(packageFile(tx.stagingPrefix), "working:new");
    await NodeFSP.writeFile(NodePath.join(tx.stagingPrefix, "codex.cmd"), "new launcher");
    await tx.publish();
    expect(await NodeFSP.readFile(packageFile(prefix), "utf8")).toBe("working:new");
    await tx.close();
    expect(await NodeFSP.readFile(packageFile(prefix), "utf8")).toBe("working:old");
  });
  for (const repaired of [false, true]) {
    it(`recovers after an updater process exits without cleanup (healthy replacement: ${repaired})`, async () => {
      const { prefix, directory, store } = await fixture();
      // A real separate process publishes the journal, damages the fixture and
      // exits without releasing its transaction, just as a killed server does.
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import * as NodeFSP from 'node:fs/promises';
        import { codexNpmRecovery } from ${JSON.stringify(new URL("./codexNpmRecovery.ts", import.meta.url).href)};
        const probe = async p => NodeFSP.readFile(p + '/node_modules/@openai/codex/package.json', 'utf8').then(s => s.startsWith('working:'), () => false);
        await codexNpmRecovery(${JSON.stringify(directory)}, probe).prepare(${JSON.stringify(prefix)});
        await NodeFSP.writeFile(${JSON.stringify(packageFile(prefix))}, ${JSON.stringify(repaired ? "working:manual-repair" : "broken")});
        process.on('message', () => {});
        process.send('prepared');
      `,
        ],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      let stderr = "";
      child.stderr!.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      const exited = new Promise<void>((resolve, reject) => {
        child.once("exit", () => resolve());
        child.once("error", reject);
      });
      await Promise.race([
        new Promise<void>((resolve) => child.once("message", () => resolve())),
        exited.then(() => {
          throw new Error(stderr || "Fixture exited before preparing recovery");
        }),
      ]);
      child.kill("SIGKILL");
      await exited;
      // Advance only the owned lock's timestamp past proper-lockfile's lease.
      // No wall-clock sleep is necessary to exercise stale-owner recovery.
      await NodeFSP.utimes(NodePath.join(prefix, ".j1-codex-update.lock"), 0, 0).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
      await store.recover();
      expect(await NodeFSP.readFile(packageFile(prefix), "utf8")).toBe(
        repaired ? "working:manual-repair" : "working:old",
      );
    });
  }
  it("refuses to start when its backup cannot run", async () => {
    const { prefix, directory } = await fixture();
    await expect(codexNpmRecovery(directory, async () => false).prepare(prefix)).rejects.toThrow(
      "recovery copy",
    );
    expect(await NodeFSP.readFile(packageFile(prefix), "utf8")).toBe("working:old");
  });
  it("rejects a malformed journal before changing any installation", async () => {
    const { prefix, directory, store } = await fixture();
    const tx = await store.prepare(prefix);
    await tx.close();
    const [key] = await NodeFSP.readdir(directory);
    await NodeFSP.writeFile(NodePath.join(directory, key!, "pending.json"), '{"version":2}');
    await expect(store.recover()).rejects.toThrow();
    expect(await NodeFSP.readFile(packageFile(prefix), "utf8")).toBe("working:old");
  });
});
