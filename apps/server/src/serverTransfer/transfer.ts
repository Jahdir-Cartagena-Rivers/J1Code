// @effect-diagnostics nodeBuiltinImport:off -- offline archive requires Node streams and exclusive filesystem operations.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeZlib from "node:zlib";
import * as NodeCrypto from "node:crypto";

const LIMIT = 64 * 1024 ** 3;
const MAGIC = Buffer.from("J1XFER02");
const excluded = new Set(["logs", "server-runtime.json", "browser-artifacts"]);
export function safeTransferName(name: string) {
  return (
    name.length > 0 &&
    name.length <= 4096 &&
    name
      .split("/")
      .every(
        (part) =>
          part.length > 0 &&
          part !== "." &&
          part !== ".." &&
          !/[\\:<>"|?*]/.test(part) &&
          ![...part].some((char) => char.charCodeAt(0) < 32) &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(part),
      )
  );
}
async function assertStopped(root: string) {
  let text: string;
  try {
    text = await NodeFSP.readFile(NodePath.join(root, "server-runtime.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const value = JSON.parse(text) as { pid?: number };
  if (!Number.isInteger(value.pid) || value.pid! <= 0)
    throw new Error("Invalid runtime record; cannot confirm stopped server.");
  try {
    process.kill(value.pid!, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  throw new Error("Stop the source server, service and managed bots before exporting.");
}
function key(password: string, salt: Buffer) {
  if (password.length < 12) throw new Error("Use a transfer password of at least 12 characters.");
  return NodeCrypto.scryptSync(password, salt, 32);
}

/** Offline copy, including WAL sidecars. Caller must keep server/services/bots stopped throughout. */
export async function exportServerTransfer(home: string, file: string, password: string) {
  const root = NodePath.join(NodePath.resolve(home), "userdata");
  if ((await NodeFSP.lstat(root)).isSymbolicLink())
    throw new Error("Symlink userdata is unsupported.");
  const output = NodePath.resolve(file);
  if (output === root || output.startsWith(root + NodePath.sep))
    throw new Error("Archive must be outside userdata.");
  await assertStopped(root);
  const entries: { name: string; size: number }[] = [];
  let bytes = 0;
  async function visit(dir: string, prefix = "") {
    for (const entry of await NodeFSP.readdir(dir, { withFileTypes: true })) {
      if (!prefix && excluded.has(entry.name)) continue;
      const name = prefix + entry.name;
      if (!safeTransferName(name)) throw new Error("Unsupported transfer NodePath.");
      const stat = await NodeFSP.lstat(NodePath.join(dir, entry.name));
      if (stat.isSymbolicLink()) throw new Error("Symlinks cannot be transferred.");
      if (stat.isDirectory()) await visit(NodePath.join(dir, entry.name), name + "/");
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > LIMIT || entries.length >= 100000)
          throw new Error("Transfer exceeds 64 GiB / 100000 file limit.");
        entries.push({ name, size: stat.size });
      } else throw new Error("Unsupported transfer entry.");
    }
  }
  await visit(root);
  if (!entries.some((e) => e.name === "state.sqlite")) throw new Error("Missing state database.");
  const salt = NodeCrypto.randomBytes(16),
    iv = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key(password, salt), iv);
  const header = Buffer.concat([MAGIC, salt, iv]);
  cipher.setAAD(header);
  async function* frames() {
    for (const entry of entries) {
      const metadata = Buffer.from(JSON.stringify(entry));
      const length = Buffer.alloc(4);
      length.writeUInt32BE(metadata.length);
      yield length;
      yield metadata;
      let copied = 0;
      for await (const chunk of NodeFS.createReadStream(
        NodePath.join(root, ...entry.name.split("/")),
      )) {
        copied += (chunk as Buffer).length;
        if (copied > entry.size) throw new Error("Source changed during transfer.");
        yield chunk;
      }
      if (copied !== entry.size) throw new Error("Source changed during transfer.");
    }
    yield Buffer.alloc(4);
  }
  const handle = await NodeFSP.open(output, "wx", 0o600);
  try {
    await handle.write(header);
    await handle.close();
    await NodeStreamPromises.pipeline(
      NodeStream.Readable.from(frames()),
      NodeZlib.createGzip(),
      cipher,
      NodeFS.createWriteStream(output, { flags: "r+", start: header.length }),
    );
    await assertStopped(root);
    await NodeFSP.appendFile(output, cipher.getAuthTag());
  } catch (error) {
    await handle.close();
    await NodeFSP.rm(output, { force: true });
    throw error;
  }
  await handle.close();
  return { files: entries.length, bytes };
}

/** Authenticate before publishing. Extraction is private staging; existing homes are never merged. */
export async function importServerTransfer(file: string, home: string, password: string) {
  const target = NodePath.resolve(home);
  const handle = await NodeFSP.open(file, "r");
  const size = (await handle.stat()).size;
  const header = Buffer.alloc(36),
    tag = Buffer.alloc(16);
  try {
    if (size < 52 || size > LIMIT + 1024 ** 3) throw new Error("Invalid archive size.");
    await handle.read(header, 0, 36, 0);
    await handle.read(tag, 0, 16, size - 16);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, 8).equals(MAGIC)) throw new Error("Unsupported transfer format.");
  const decipher = NodeCrypto.createDecipheriv(
    "aes-256-gcm",
    key(password, header.subarray(8, 24)),
    header.subarray(24),
  );
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  // Reserve new home; staging is nested so final userdata publication is one atomic rename.
  await NodeFSP.mkdir(target, { mode: 0o700 });
  const stage = NodePath.join(target, ".transfer-staging");
  let files = 0,
    bytes = 0;
  try {
    await NodeFSP.mkdir(stage, { mode: 0o700 });
    const source = NodeFS.createReadStream(file, { start: 36, end: size - 17 });
    const unzip = NodeZlib.createGunzip();
    const pumping = NodeStreamPromises.pipeline(source, decipher, unzip);
    // Attach rejection handler immediately; the original promise is awaited below.
    void pumping.catch(() => {});
    const iterator = unzip[Symbol.asyncIterator]();
    let pending = Buffer.alloc(0);
    async function take(n: number) {
      const parts: Buffer[] = [];
      let remaining = n;
      while (remaining) {
        if (!pending.length) {
          const next = await iterator.next();
          if (next.done) throw new Error("Truncated archive.");
          pending = Buffer.from(next.value);
        }
        const count = Math.min(remaining, pending.length);
        parts.push(pending.subarray(0, count));
        pending = pending.subarray(count);
        remaining -= count;
      }
      return Buffer.concat(parts, n);
    }
    const names = new Set<string>();
    const directories = new Set<string>();
    try {
      while (true) {
        const length = (await take(4)).readUInt32BE();
        if (!length) break;
        if (length > 8192) throw new Error("Invalid entry header.");
        const entry = JSON.parse((await take(length)).toString()) as { name: string; size: number };
        if (
          typeof entry.name !== "string" ||
          !safeTransferName(entry.name) ||
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0
        )
          throw new Error("Invalid entry.");
        const name = entry.name.toLowerCase();
        if (names.has(name) || directories.has(name)) throw new Error("Conflicting archive paths.");
        const parts = name.split("/");
        for (let index = 1; index < parts.length; index++) {
          const parent = parts.slice(0, index).join("/");
          if (names.has(parent)) throw new Error("Conflicting archive paths.");
          directories.add(parent);
        }
        names.add(name);
        bytes += entry.size;
        files++;
        if (bytes > LIMIT || files > 100000) throw new Error("Transfer exceeds limits.");
        const destination = NodePath.join(stage, ...entry.name.split("/"));
        await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true, mode: 0o700 });
        const out = await NodeFSP.open(destination, "wx", 0o600);
        try {
          for (let remaining = entry.size; remaining > 0;) {
            const count = Math.min(remaining, 65536);
            await out.write(await take(count));
            remaining -= count;
          }
        } finally {
          await out.close();
        }
      }
      if (pending.length || !(await iterator.next()).done)
        throw new Error("Trailing archive data.");
      await pumping;
      if (!names.has("state.sqlite")) throw new Error("Missing state database.");
    } catch (error) {
      unzip.destroy();
      await pumping.catch(() => {});
      throw error;
    }
    await NodeFSP.rename(stage, NodePath.join(target, "userdata"));
  } catch (error) {
    await NodeFSP.rm(target, { recursive: true, force: true });
    throw error;
  }
  return { files, home: target };
}
