// @effect-diagnostics nodeBuiltinImport:off -- isolated filesystem fixtures.
import { describe, it, expect } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import * as NodeSqlite from "node:sqlite";
import { exportServerTransfer, importServerTransfer } from "./transfer.ts";

describe("offline server transfer", () => {
  it("rejects an archive inside userdata through a directory alias or Windows casing", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-transfer-alias-"));
    try {
      const source = NodePath.join(root, "source");
      const userdata = NodePath.join(source, "userdata");
      await NodeFSP.mkdir(userdata, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(userdata, "state.sqlite"), "preserved database");
      const alias = NodePath.join(root, "alias");
      await NodeFSP.symlink(userdata, alias, process.platform === "win32" ? "junction" : "dir");
      const outputs = [NodePath.join(alias, "setup.j1-transfer")];
      if (process.platform === "win32")
        outputs.push(NodePath.join(userdata.toUpperCase(), "setup.j1-transfer"));
      for (const output of outputs) {
        await expect(exportServerTransfer(source, output, "test-password-123")).rejects.toThrow(
          "outside userdata",
        );
        await expect(NodeFSP.stat(output)).rejects.toThrow();
      }
      expect(await NodeFSP.readFile(NodePath.join(userdata, "state.sqlite"), "utf8")).toBe(
        "preserved database",
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("restores a readable SQLite conversation database", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-transfer-sqlite-"));
    try {
      const source = NodePath.join(root, "source");
      await NodeFSP.mkdir(NodePath.join(source, "userdata"), { recursive: true });
      const db = new NodeSqlite.DatabaseSync(NodePath.join(source, "userdata/state.sqlite"));
      db.exec(
        "CREATE TABLE history (body TEXT); INSERT INTO history VALUES ('saved conversation')",
      );
      db.close();
      const archive = NodePath.join(root, "transfer");
      await exportServerTransfer(source, archive, "test-password-123");
      const target = NodePath.join(root, "target");
      await importServerTransfer(archive, target, "test-password-123");
      const restored = new NodeSqlite.DatabaseSync(NodePath.join(target, "userdata/state.sqlite"), {
        readOnly: true,
      });
      try {
        expect(restored.prepare("SELECT body FROM history").get()?.body).toBe("saved conversation");
      } finally {
        restored.close();
      }
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("roundtrips settings, database sidecars, secrets and bot history without overwriting a target", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-transfer-"));
    try {
      const source = NodePath.join(root, "source");
      const contents = {
        "state.sqlite": "database",
        "state.sqlite-wal": "wal",
        "settings.json": '{"theme":"dark"}',
        "secrets/key": "secret",
        "mausbot/history.json": "history",
        "logs/test": "skip",
      };
      for (const [name, data] of Object.entries(contents)) {
        await NodeFSP.mkdir(NodePath.dirname(NodePath.join(source, "userdata", name)), {
          recursive: true,
        });
        await NodeFSP.writeFile(NodePath.join(source, "userdata", name), data);
      }
      const archive = NodePath.join(root, "setup.j1-transfer");
      await exportServerTransfer(source, archive, "test-password-123");
      await expect(exportServerTransfer(source, archive, "test-password-123")).rejects.toThrow();
      const target = NodePath.join(root, "target");
      await importServerTransfer(archive, target, "test-password-123");
      for (const [name, data] of Object.entries(contents)) {
        if (!name.startsWith("logs/"))
          expect(await NodeFSP.readFile(NodePath.join(target, "userdata", name), "utf8")).toBe(
            data,
          );
      }
      await expect(NodeFSP.stat(NodePath.join(target, "userdata/logs"))).rejects.toThrow();
      await expect(importServerTransfer(archive, target, "test-password-123")).rejects.toThrow();
      expect(await NodeFSP.readFile(NodePath.join(target, "userdata/settings.json"), "utf8")).toBe(
        contents["settings.json"],
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("rejects traversal, duplicate paths, corruption and unknown formats before creating a destination", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-transfer-"));
    try {
      const file = NodePath.join(root, "bad");
      const target = NodePath.join(root, "target");
      for (const value of [
        { format: "wrong", files: [] },
        {
          format: "j1-server-transfer-v1",
          files: ["state.sqlite", "STATE.SQLITE"].map((name) => ({
            name,
            data: "",
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          })),
        },
        { format: "j1-server-transfer-v1", files: [{ name: "../escape", data: "", sha256: "" }] },
        {
          format: "j1-server-transfer-v1",
          files: [{ name: "state.sqlite", data: "eA==", sha256: "wrong" }],
        },
      ]) {
        await NodeFSP.writeFile(file, NodeZlib.gzipSync(JSON.stringify(value)));
        await expect(importServerTransfer(file, target, "test-password-123")).rejects.toThrow();
        await expect(NodeFSP.stat(target)).rejects.toThrow();
      }
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

it("rejects authenticated malicious paths, conflicts, oversized entries with cleanup", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-transfer-hostile-"));
  const password = "test-password-123";
  try {
    const archive = NodePath.join(root, "archive");
    const target = NodePath.join(root, "target");
    const cases = [
      [{ name: "../escape", size: 0 }],
      [
        { name: "state.sqlite", size: 0 },
        { name: "STATE.SQLITE", size: 0 },
      ],
      [
        { name: "state.sqlite", size: 0 },
        { name: "state.sqlite/child", size: 0 },
      ],
      [
        { name: "state.sqlite/child", size: 0 },
        { name: "state.sqlite", size: 0 },
      ],
      [{ name: "state.sqlite", size: 65 * 1024 ** 3 }],
    ];
    for (const entries of cases) {
      const frames = entries.flatMap((entry) => {
        const json = Buffer.from(JSON.stringify(entry));
        const size = Buffer.alloc(4);
        size.writeUInt32BE(json.length);
        return [size, json];
      });
      frames.push(Buffer.alloc(4));
      const salt = NodeCrypto.randomBytes(16),
        iv = NodeCrypto.randomBytes(12);
      const header = Buffer.concat([Buffer.from("J1XFER02"), salt, iv]);
      const cipher = NodeCrypto.createCipheriv(
        "aes-256-gcm",
        NodeCrypto.scryptSync(password, salt, 32),
        iv,
      );
      cipher.setAAD(header);
      const encrypted = Buffer.concat([
        cipher.update(NodeZlib.gzipSync(Buffer.concat(frames))),
        cipher.final(),
      ]);
      await NodeFSP.writeFile(archive, Buffer.concat([header, encrypted, cipher.getAuthTag()]));
      await expect(importServerTransfer(archive, target, password)).rejects.toThrow();
      await expect(NodeFSP.stat(target)).rejects.toThrow();
    }
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
