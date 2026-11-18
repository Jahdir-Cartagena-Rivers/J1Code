// @effect-diagnostics nodeBuiltinImport:off - Durable npm filesystem transactions also run in crash-test child processes.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { lock } from "proper-lockfile";
import * as Schema from "effect/Schema";

const entries = ["node_modules/@openai/codex", "codex", "codex.cmd", "codex.ps1"] as const;
const Journal = Schema.Struct({
  version: Schema.Literal(1),
  prefix: Schema.String,
  operation: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/)),
  present: Schema.Array(Schema.Literals(entries)),
});
const decodeJournal = Schema.decodeUnknownSync(Schema.fromJsonString(Journal));
const exists = (file: string) =>
  NodeFSP.lstat(file).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

/** The journal is published only after the independently runnable backup is complete. */
export function codexNpmRecovery(directory: string, probe: (prefix: string) => Promise<boolean>) {
  const keyFor = (prefix: string) =>
    NodeCrypto.createHash("sha256").update(prefix.toLowerCase()).digest("hex").slice(0, 24);
  const checkedPrefix = (prefix: string) => {
    if (!NodePath.isAbsolute(prefix) || NodePath.resolve(prefix) === NodePath.parse(prefix).root)
      throw new Error("Cannot identify the Codex npm installation prefix safely.");
    return NodePath.resolve(prefix);
  };
  const releaseLock = (prefix: string) =>
    lock(prefix, {
      realpath: true,
      lockfilePath: NodePath.join(prefix, ".j1-codex-update.lock"),
      retries: { retries: 24, minTimeout: 500, maxTimeout: 500 },
    });
  const replaceEntries = async (record: typeof Journal.Type, source: string) => {
    const prefix = checkedPrefix(record.prefix);
    // Stage beside each destination so publication is a same-volume rename. Never
    // overwrite files in a running executable's directory one at a time.
    for (const entry of entries) {
      const destination = NodePath.join(prefix, entry);
      const temporary = `${destination}.j1-restore-${record.operation}`;
      const retired = `${destination}.j1-retired-${record.operation}-${NodeCrypto.randomUUID()}`;
      if (record.present.includes(entry)) {
        const backup = NodePath.join(source, entry);
        if (!(await exists(backup)))
          throw new Error("Codex recovery backup is incomplete; it was retained for repair.");
        await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
        await NodeFSP.rm(temporary, { recursive: true, force: true });
        await NodeFSP.cp(backup, temporary, {
          recursive: true,
          dereference: true,
          errorOnExist: true,
        });
      }
      let moved = false;
      if (await exists(destination)) {
        await NodeFSP.rename(destination, retired);
        moved = true;
      }
      try {
        if (record.present.includes(entry)) await NodeFSP.rename(temporary, destination);
      } catch (error) {
        if (moved) await NodeFSP.rename(retired, destination);
        throw error;
      }
      // Windows may still hold an old executable open. Leaving that owned retired
      // copy is harmless; the backup and journal remain until validation succeeds.
      if (moved) await NodeFSP.rm(retired, { recursive: true, force: true }).catch(() => {});
    }
  };
  const restore = async (record: typeof Journal.Type, root: string) => {
    await replaceEntries(record, NodePath.join(root, record.operation));
    if (!(await probe(record.prefix)))
      throw new Error("Restored Codex could not start; its recovery backup was retained.");
    await NodeFSP.unlink(NodePath.join(root, "pending.json"));
  };
  const read = async (root: string) => {
    const file = NodePath.join(root, "pending.json");
    if (!(await exists(file))) return null;
    if ((await NodeFSP.stat(file)).size > 8192) throw new Error("Invalid Codex recovery journal.");
    const record = decodeJournal(await NodeFSP.readFile(file, "utf8"));
    if (
      keyFor(checkedPrefix(record.prefix)) !== NodePath.basename(root) ||
      !record.present.includes(entries[0])
    )
      throw new Error("Invalid Codex recovery journal; no installation was changed.");
    return record;
  };
  const recoverLocked = async (root: string) => {
    const record = await read(root);
    if (!record) return;
    // The updater may have completed just before the server exited. Preserve a
    // healthy replacement (including a user's subsequent manual repair).
    if (await probe(record.prefix)) await NodeFSP.unlink(NodePath.join(root, "pending.json"));
    else await restore(record, root);
    await NodeFSP.rm(NodePath.join(root, record.operation), { recursive: true, force: true });
  };
  return {
    async recover() {
      if (!(await exists(directory))) return;
      for (const name of await NodeFSP.readdir(directory)) {
        if (!/^[a-f0-9]{24}$/.test(name)) continue;
        const root = NodePath.join(directory, name);
        const record = await read(root);
        if (!record) continue;
        const unlock = await releaseLock(record.prefix);
        try {
          await recoverLocked(root);
        } finally {
          await unlock();
        }
      }
    },
    async prepare(prefixInput: string) {
      const prefix = checkedPrefix(prefixInput);
      const unlock = await releaseLock(prefix);
      let released = false;
      let unpublishedBackup: string | undefined;
      const release = async () => {
        if (!released) {
          released = true;
          await unlock();
        }
      };
      try {
        const root = NodePath.join(directory, keyFor(prefix));
        await NodeFSP.mkdir(root, { recursive: true, mode: 0o700 });
        await recoverLocked(root);
        // Native Windows executable startup still has shorter path limits than
        // Node's filesystem APIs. Keep the nested npm vendor path runnable.
        const operation = NodeCrypto.randomUUID().replaceAll("-", "").slice(0, 16);
        const backup = NodePath.join(root, operation);
        const stagingPrefix = NodePath.join(root, `${operation}n`);
        unpublishedBackup = backup;
        await NodeFSP.mkdir(backup, { mode: 0o700 });
        await NodeFSP.mkdir(stagingPrefix, { mode: 0o700 });
        const present: Array<(typeof entries)[number]> = [];
        for (const entry of entries) {
          const source = NodePath.join(prefix, entry);
          if (!(await exists(source))) continue;
          if ((await NodeFSP.lstat(source)).isSymbolicLink())
            throw new Error("Linked Codex installations require their owning installer.");
          const destination = NodePath.join(backup, entry);
          await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
          await NodeFSP.cp(source, destination, {
            recursive: true,
            dereference: true,
            errorOnExist: true,
          });
          present.push(entry);
        }
        if (!present.includes(entries[0]) || !(await probe(backup)))
          throw new Error("Codex was not changed: a runnable recovery copy could not be prepared.");
        const record = { version: 1 as const, prefix, operation, present };
        const temporary = NodePath.join(root, `${operation}.json`);
        const handle = await NodeFSP.open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(record));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await NodeFSP.rename(temporary, NodePath.join(root, "pending.json"));
        unpublishedBackup = undefined;
        let committed = false;
        let closed = false;
        let publishing = false;
        return {
          stagingPrefix,
          async publish() {
            if (!(await probe(stagingPrefix)))
              throw new Error(
                "The staged Codex update could not start; the working installation was not changed.",
              );
            const stagedEntries: Array<(typeof entries)[number]> = [];
            for (const entry of entries)
              if (await exists(NodePath.join(stagingPrefix, entry))) stagedEntries.push(entry);
            if (!stagedEntries.includes(entries[0]))
              throw new Error("The staged Codex package is incomplete.");
            publishing = true;
            await replaceEntries({ ...record, present: stagedEntries }, stagingPrefix);
          },
          async commit() {
            if (!publishing || !(await probe(prefix)))
              throw new Error(
                "The Codex update could not be verified; the recovery copy was retained.",
              );
            await NodeFSP.unlink(NodePath.join(root, "pending.json"));
            committed = true;
          },
          async close() {
            if (closed) return;
            try {
              if (!committed) {
                if (publishing || !(await probe(prefix))) await restore(record, root);
                else await NodeFSP.unlink(NodePath.join(root, "pending.json"));
              }
              await NodeFSP.rm(backup, { recursive: true, force: true });
              await NodeFSP.rm(stagingPrefix, { recursive: true, force: true }).catch(() => {});
              closed = true;
            } finally {
              await release();
            }
          },
        };
      } catch (error) {
        if (unpublishedBackup)
          await NodeFSP.rm(unpublishedBackup, { recursive: true, force: true }).catch(() => {});
        await release();
        throw error;
      }
    },
  };
}
