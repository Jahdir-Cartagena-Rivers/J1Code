// @effect-diagnostics nodeBuiltinImport:off - Real filesystem and killed-child regression fixtures.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { codexNpmRecovery, legacyCodexStartupPrefixes } from "./codexNpmRecovery.ts";

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
  it("limits startup ownership to the user and configured legacy prefixes", () => {
    const baseDir = "C:\\J1";
    expect(legacyCodexStartupPrefixes(baseDir, {
      APPDATA: "C:\\User\\AppData", NPM_CONFIG_PREFIX: "D:\\custom npm",
    })).toEqual(["C:\\User\\AppData\\npm", "D:\\custom npm"]);
    for (const configured of [
      "C:\\J1\\tools\\codex\\current", "C:\\Else\\..\\other", "\\relative", "\\\\?\\C:\\special", "D:\\",
    ]) {
      expect(legacyCodexStartupPrefixes(baseDir, { NPM_CONFIG_PREFIX: configured })).toEqual([]);
    }
  });

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
    await store.recover([prefix]);
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
        const tx = await codexNpmRecovery(${JSON.stringify(directory)}, probe).prepare(${JSON.stringify(prefix)});
        await NodeFSP.writeFile(${JSON.stringify(packageFile(prefix))}, ${JSON.stringify(repaired ? "working:manual-repair" : "broken")});
        process.on('message', () => {});
        process.send(tx.stagingPrefix);
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
      const staging = await Promise.race([
        new Promise<string>((resolve) => child.once("message", (message) => resolve(String(message)))),
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
      expect(await store.recover([prefix])).toEqual({ recovered: 1, invalid: 0, deferred: 0 });
      await NodeFSP.mkdir(NodePath.dirname(packageFile(staging)), { recursive: true });
      await NodeFSP.writeFile(packageFile(staging), "working:late-orphan");
      expect(await NodeFSP.readFile(packageFile(prefix), "utf8")).toBe(
        repaired ? "working:manual-repair" : "working:old",
      );
    });
  }
  it("leaves a live updater alone and never publishes a delayed staging write", async () => {
    const { prefix, store } = await fixture();
    const transaction = await store.prepare(prefix);
    const staging = transaction.stagingPrefix;
    try {
      expect(await store.recover([prefix])).toEqual({ recovered: 0, invalid: 0, deferred: 1 });
      await NodeFSP.mkdir(NodePath.dirname(packageFile(staging)), { recursive: true });
      await NodeFSP.writeFile(packageFile(staging), "working:orphan");
      expect(await NodeFSP.readFile(packageFile(prefix), "utf8")).toBe("working:old");
    } finally {
      await transaction.close();
    }
  });

  it("leaves a managed or foreign installation outside the startup ownership list alone", async () => {
    const { root, directory, prefix, store } = await fixture();
    const foreign = NodePath.join(root, "managed releases", "current");
    await NodeFSP.mkdir(NodePath.dirname(packageFile(foreign)), { recursive: true });
    await NodeFSP.writeFile(packageFile(foreign), "managed:untouched");
    const key = NodeCrypto.createHash("sha256").update(foreign.toLowerCase()).digest("hex").slice(0, 24);
    const journalRoot = NodePath.join(directory, key);
    await NodeFSP.mkdir(journalRoot, { recursive: true });
    const journal = NodePath.join(journalRoot, "pending.json");
    const record = JSON.stringify({
      version: 1, prefix: foreign, operation: "0123456789abcdef", present: ["node_modules/@openai/codex"],
    });
    await NodeFSP.writeFile(journal, record);
    expect(await store.recover([prefix])).toEqual({ recovered: 0, invalid: 1, deferred: 0 });
    expect(await NodeFSP.readFile(packageFile(foreign), "utf8")).toBe("managed:untouched");
    expect(await NodeFSP.readFile(journal, "utf8")).toBe(record);
  });

  it("rejects a linked package scope before touching its outside target", async () => {
    const { root, prefix, store } = await fixture();
    const scope = NodePath.join(prefix, "node_modules", "@openai");
    const outside = NodePath.join(root, "outside");
    await NodeFSP.rename(scope, outside);
    await NodeFSP.symlink(outside, scope, "junction");
    await expect(store.prepare(prefix)).rejects.toThrow("linked Codex recovery path");
    expect(await NodeFSP.readFile(NodePath.join(outside, "codex", "package.json"), "utf8")).toBe("working:old");
  });

  it("refuses to start when its backup cannot run", async () => {
    const { prefix, directory } = await fixture();
    await expect(codexNpmRecovery(directory, async () => false).prepare(prefix)).rejects.toThrow(
      "recovery copy",
    );
    expect(await NodeFSP.readFile(packageFile(prefix), "utf8")).toBe("working:old");
  });
  it("retains a journal with an escaped backup and never probes or restores its target", async () => {
    const { root, prefix, directory, store } = await fixture();
    const tx = await store.prepare(prefix);
    const [key] = await NodeFSP.readdir(directory);
    const journal = NodePath.join(directory, key!, "pending.json");
    const raw = await NodeFSP.readFile(journal, "utf8");
    const operation = JSON.parse(raw).operation;
    await tx.close();
    const outside = NodePath.join(root, "outside backup");
    await NodeFSP.mkdir(NodePath.dirname(packageFile(outside)), { recursive: true });
    await NodeFSP.writeFile(packageFile(outside), "working:outside");
    await NodeFSP.symlink(outside, NodePath.join(directory, key!, operation), "junction");
    await NodeFSP.writeFile(journal, raw);
    await NodeFSP.writeFile(packageFile(prefix), "broken");
    let probes = 0;
    const startup = codexNpmRecovery(directory, async () => { probes++; return true; });
    expect(await startup.recover([prefix])).toEqual({ recovered: 0, invalid: 0, deferred: 1 });
    expect(probes).toBe(0);
    expect(await NodeFSP.readFile(packageFile(outside), "utf8")).toBe("working:outside");
    expect(await NodeFSP.readFile(packageFile(prefix), "utf8")).toBe("broken");
    expect(await NodeFSP.readFile(journal, "utf8")).toBe(raw);
  });

  it("rejects a malformed journal before changing any installation", async () => {
    const { prefix, directory, store } = await fixture();
    const tx = await store.prepare(prefix);
    await tx.close();
    const [key] = await NodeFSP.readdir(directory);
    await NodeFSP.writeFile(NodePath.join(directory, key!, "pending.json"), '{"version":2}');
    expect(await store.recover([prefix])).toEqual({ recovered: 0, invalid: 1, deferred: 0 });
    expect(await NodeFSP.readFile(packageFile(prefix), "utf8")).toBe("working:old");
  });
});

it("reads valid legacy journals and preserves malformed or foreign records without probing npm", async () => {
  const { root, prefix, directory, store } = await fixture();
  const tx = await store.prepare(prefix);
  try {
    const key = (await NodeFSP.readdir(directory))[0]!;
    const pendingPath = NodePath.join(directory, key, "pending.json");
    const raw = await NodeFSP.readFile(pendingPath, "utf8");
    const journal = JSON.parse(raw);
    const otherKeys = ["0", "1", "2"].map((char) => char.repeat(24)).filter((candidate) => candidate !== key);
    const foreignDirectory = NodePath.join(directory, otherKeys[0]!);
    const malformedDirectory = NodePath.join(directory, otherKeys[1]!);
    await NodeFSP.mkdir(foreignDirectory);
    await NodeFSP.mkdir(malformedDirectory);
    const foreign = NodePath.join(foreignDirectory, "pending.json");
    const malformed = NodePath.join(malformedDirectory, "pending.json");
    const foreignRecord = JSON.stringify({ ...journal, prefix: NodePath.join(root, "outside") });
    await NodeFSP.writeFile(foreign, foreignRecord);
    await NodeFSP.writeFile(malformed, "{invalid");
    const discovery = codexNpmRecovery(directory, async () => {
      throw new Error("Legacy inspection must not invoke npm or Codex");
    });
    expect(await discovery.inspect()).toEqual({ pending: 1, invalid: 2 });
    expect(await NodeFSP.readFile(pendingPath, "utf8")).toBe(raw);
    expect(await NodeFSP.readFile(foreign, "utf8")).toBe(foreignRecord);
    expect(await NodeFSP.readFile(malformed, "utf8")).toBe("{invalid");
    expect(await NodeFSP.readFile(packageFile(prefix), "utf8")).toBe("working:old");
  } finally {
    await tx.close();
  }
});
