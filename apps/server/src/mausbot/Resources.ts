// @effect-diagnostics nodeBuiltinImport:off - Verified archive extraction is a native filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";
import * as Yauzl from "yauzl";
import * as Schema from "effect/Schema";

const sourcePin = "d818c28aa80686dc1d7db64ebeffa2a9dc468762";
const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      commit: Schema.Literal(sourcePin),
      files: Schema.Record(Schema.String, Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
    }),
  ),
);

/** The archive is copied with J1's versioned background runtime; expansion is lazy and atomic. */
export async function resolveMausbotResources(resources: string, cacheRoot: string) {
  const archive = NodePath.join(resources, "runtime.zip");
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(archive)) hash.update(chunk);
  const digest = hash.digest("hex");
  const target = NodePath.join(cacheRoot, digest);
  try {
    if ((await NodeFSP.readFile(NodePath.join(target, ".complete"), "utf8")) === digest)
      return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await NodeFSP.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const staging = await NodeFSP.mkdtemp(NodePath.join(cacheRoot, ".stage-"));
  try {
    const seen = new Set<string>();
    let total = 0;
    const zip = await new Promise<Yauzl.ZipFile>((resolve, reject) =>
      Yauzl.open(
        archive,
        { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
        (error, file) =>
          error || !file ? reject(error ?? new Error("Invalid runtime archive.")) : resolve(file),
      ),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        zip.on("error", reject);
        zip.on("end", resolve);
        zip.on("entry", (entry: Yauzl.Entry) => {
          void (async () => {
            const name = entry.fileName;
            const normalized = name.replace(/\/$/, "");
            if (
              !normalized ||
              normalized.split("/").some((part) => !part || part === "." || part === "..") ||
              /[\\:\x00-\x1f]/.test(name) ||
              seen.has(normalized.toLowerCase()) ||
              ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000
            )
              throw new Error("Unsafe runtime archive entry.");
            seen.add(normalized.toLowerCase());
            total += entry.uncompressedSize;
            if (seen.size > 20_000 || total > 1024 * 1024 * 1024)
              throw new Error("Runtime archive exceeded its extraction budget.");
            const file = NodePath.resolve(staging, ...normalized.split("/"));
            const relative = NodePath.relative(staging, file);
            if (relative.startsWith("..") || NodePath.isAbsolute(relative))
              throw new Error("Runtime archive escaped its directory.");
            if (name.endsWith("/")) await NodeFSP.mkdir(file, { recursive: true, mode: 0o700 });
            else {
              await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true, mode: 0o700 });
              const stream = await new Promise<NodeFS.ReadStream>((done, fail) =>
                zip.openReadStream(entry, (error, value) =>
                  error || !value
                    ? fail(error ?? new Error("Unreadable archive entry."))
                    : done(value as NodeFS.ReadStream),
                ),
              );
              await NodeStreamPromises.pipeline(
                stream,
                NodeFS.createWriteStream(file, { flags: "wx", mode: 0o600 }),
              );
            }
            zip.readEntry();
          })().catch(reject);
        });
        zip.readEntry();
      });
    } finally {
      zip.close();
    }
    const manifest = decodeManifest(
      await NodeFSP.readFile(NodePath.join(staging, "j1-mausbot-manifest.json"), "utf8"),
    );
    const expected = new Set(Object.keys(manifest.files).map((name) => name.toLowerCase()));
    for (const name of seen) {
      if (name === "j1-mausbot-manifest.json" || expected.has(name)) continue;
      if (![...expected].some((file) => file.startsWith(name + "/")))
        throw new Error("An unlisted file was found in the runtime archive.");
    }
    for (const [name, expectedHash] of Object.entries(manifest.files)) {
      if (!seen.has(name.toLowerCase())) throw new Error("A runtime manifest file is missing.");
      const actual = NodeCrypto.createHash("sha256")
        .update(await NodeFSP.readFile(NodePath.join(staging, name)))
        .digest("hex");
      if (actual !== expectedHash) throw new Error("Runtime integrity verification failed.");
    }
    for (const file of ["server/index.js", "ui/index.html", "LICENSE", "NOTICE"])
      await NodeFSP.access(NodePath.join(staging, file));
    if (
      [...seen].some(
        (name) =>
          name === "enterprise" ||
          name.startsWith("enterprise/") ||
          name.startsWith("server/enterprise/"),
      )
    )
      throw new Error("Enterprise payloads cannot be installed by J1.");
    await NodeFSP.writeFile(NodePath.join(staging, ".complete"), digest, { mode: 0o600 });
    await NodeFSP.rename(staging, target);
    return target;
  } catch (error) {
    await NodeFSP.rm(staging, { recursive: true, force: true });
    throw error;
  }
}
