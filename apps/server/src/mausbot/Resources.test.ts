// @effect-diagnostics nodeBuiltinImport:off - Exercises extraction against disposable ZIP fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { describe, expect, it } from "vite-plus/test";
import { resolveMausbotResources } from "./Resources.ts";

/** Stored ZIP entries let rejection fixtures contain paths normal archivers refuse to create. */
function zip(files: Array<[string, string]>) {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of files) {
    const path = Buffer.from(name),
      data = Buffer.from(value),
      crc = NodeZlib.crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(path.length, 26);
    local.push(header, path, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(path.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, path);
    offset += header.length + path.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
async function fixture(extra: Array<[string, string]> = [], corrupt = false) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-mausbot-zip-test-"));
  const resources = NodePath.join(root, "resources"),
    cache = NodePath.join(root, "cache");
  await NodeFSP.mkdir(resources);
  const files: Array<[string, string]> = [
    ["server/index.js", "// fixture"],
    ["ui/index.html", "<title>fixture</title>"],
    ["LICENSE", "fixture"],
    ["NOTICE", "fixture"],
    ...extra,
  ];
  const hashes = Object.fromEntries(
    files.map(([name, content]) => [
      name,
      NodeCrypto.createHash("sha256").update(content).digest("hex"),
    ]),
  );
  if (corrupt) hashes["server/index.js"] = "0".repeat(64);
  files.push([
    "j1-mausbot-manifest.json",
    JSON.stringify({ commit: "d818c28aa80686dc1d7db64ebeffa2a9dc468762", files: hashes }),
  ]);
  await NodeFSP.writeFile(NodePath.join(resources, "runtime.zip"), zip(files));
  return { root, resources, cache };
}
describe("bundled assistant resources", () => {
  it("verifies and atomically expands a bundle into its hash-owned cache", async () => {
    const { root, resources, cache } = await fixture();
    try {
      const expanded = await resolveMausbotResources(resources, cache);
      expect(await NodeFSP.readFile(NodePath.join(expanded, "server/index.js"), "utf8")).toBe(
        "// fixture",
      );
      expect(await resolveMausbotResources(resources, cache)).toBe(expanded);
      expect(await NodeFSP.readdir(cache)).toEqual([NodePath.basename(expanded)]);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it.each(["../escaped", "server/INDEX.js", "server/enterprise/index.js"])(
    "rejects unsafe or excluded payload %s without publishing it",
    async (name) => {
      const { root, resources, cache } = await fixture([[name, "unsafe"]]);
      try {
        await expect(resolveMausbotResources(resources, cache)).rejects.toThrow();
        expect(await NodeFSP.readdir(cache)).toEqual([]);
        await expect(NodeFSP.access(NodePath.join(root, "escaped"))).rejects.toThrow();
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
  it("rejects a mismatched executable hash before making the bundle usable", async () => {
    const { root, resources, cache } = await fixture([], true);
    try {
      await expect(resolveMausbotResources(resources, cache)).rejects.toThrow("integrity");
      expect(await NodeFSP.readdir(cache)).toEqual([]);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
