import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
import { MAUSBOT_SOURCE, patchMausbotSource } from "./mausbot/patch-source.ts";

const run = NodeUtil.promisify(NodeChildProcess.execFile);
const repository = "https://github.com/milind-soni/OpenMausBot.git";
const ownRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

/** A locked OSS source build; no Docker, enterprise payload or Chromium preparation step. */
// oxlint-disable-next-line t3code/no-global-process-runtime -- This standalone Node builder also runs without an Effect runtime.
const hostPlatform = process.platform;

export async function stageMausbot(
  destination: string,
  sourceCheckout?: string,
  platform = hostPlatform,
) {
  // Windows CI may expose TEMP through an 8.3 alias. Vite resolves config inputs
  // to long paths, so its working root must use that same canonical spelling.
  const scratch = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-mausbot-assembly-")),
  );
  const source = sourceCheckout ?? NodePath.join(scratch, "upstream");
  const stage = NodePath.join(scratch, "build");
  const execute = async (command: string, args: string[], cwd: string) => {
    const env = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
    delete env.CUA_DRIVER_PATH;
    const result = await run(command, args, {
      cwd,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env,
    });
    return result.stdout.trim();
  };
  try {
    await NodeFSP.access(destination).then(
      () => {
        throw new Error("The runtime destination already exists.");
      },
      () => undefined,
    );
    if (!sourceCheckout) {
      await execute("git", ["init", source], scratch);
      await execute("git", ["fetch", "--depth=1", repository, MAUSBOT_SOURCE], source);
    }
    const pin = await execute("git", ["rev-parse", `${MAUSBOT_SOURCE}^{commit}`], source);
    if (pin !== MAUSBOT_SOURCE) throw new Error("Mausbot source pin did not match.");
    const archive = NodePath.join(scratch, "source.tar");
    await execute(
      "git",
      ["archive", "--format=tar", `--output=${archive}`, MAUSBOT_SOURCE, ":(exclude)enterprise"],
      source,
    );
    await NodeFSP.mkdir(stage);
    await execute("tar", ["-xf", archive, "-C", stage], scratch);
    await patchMausbotSource(stage);
    const corepack = platform === "win32" ? "corepack.cmd" : "corepack";
    // .cmd launch is explicit on Windows; every argument is a fixed build command and no user text enters the shell.
    const pnpm = async (args: string[]) => {
      if (platform === "win32")
        return execute("cmd.exe", ["/d", "/s", "/c", `${corepack} pnpm ${args.join(" ")}`], stage);
      return execute(corepack, ["pnpm", ...args], stage);
    };
    await pnpm(["install", "--frozen-lockfile", "--ignore-scripts", "--filter", "openmausbot"]);
    await pnpm(["exec", "vite", "build", "--base=./"]);
    await execute(process.execPath, ["scripts/bundle-server.mjs"], stage);
    if (platform === "win32")
      await execute(process.execPath, ["scripts/prepare-cua-win.mjs"], stage);
    await NodeFSP.mkdir(destination, { recursive: true });
    await NodeFSP.cp(NodePath.join(stage, "dist-server"), NodePath.join(destination, "server"), {
      recursive: true,
    });
    await NodeFSP.cp(NodePath.join(stage, "dist"), NodePath.join(destination, "ui"), {
      recursive: true,
    });
    // Keep the upstream approval handshake intact instead of implementing a second permission protocol.
    const approvals = NodePath.join(destination, "native/host-adapters");
    await NodeFSP.mkdir(NodePath.join(approvals, "electron"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(approvals, "src/locales"), { recursive: true });
    for (const file of ["approval-trusted-mode.cjs", "native-text.cjs"])
      await NodeFSP.copyFile(
        NodePath.join(stage, "electron", file),
        NodePath.join(approvals, "electron", file),
      );
    await NodeFSP.copyFile(
      NodePath.join(stage, "src/locales/en.json"),
      NodePath.join(approvals, "src/locales/en.json"),
    );
    if (platform === "win32") {
      await NodeFSP.cp(
        NodePath.join(stage, "dist-native/cua-win32-x64"),
        NodePath.join(destination, "native"),
        { recursive: true },
      );
      await NodeFSP.copyFile(
        NodePath.join(ownRoot, "scripts/mausbot/computer-host.mjs"),
        NodePath.join(destination, "native/j1-computer-host.mjs"),
      );
      const nativeCache = NodePath.join(
        stage,
        "node_modules/.cache/openmausbot/cua-driver-0.28.2-win",
      );
      for (const file of ["cua-driver-uia.exe", "cua-cursor-theme.exe"])
        await NodeFSP.copyFile(
          NodePath.join(nativeCache, file),
          NodePath.join(destination, "native", file),
        );
      await NodeFSP.writeFile(
        NodePath.join(destination, "native/SOURCE.txt"),
        "Cua Driver 0.28.2: https://github.com/trycua/cua/tree/fc188250b4ca8549b8e61f937fdb1fb560770e86\nOfficial Windows x64 binary release: https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.28.2\nArchive SHA256: 1f4bfceeab64cb7f56be7aad774c3dc2d2910d1427e4be1d79939c706e8029ba\nSDK and native libraries are pinned by the enclosed upstream pnpm lockfile.\n",
      );
      await NodeFSP.cp(
        NodePath.join(ownRoot, "third_party/mausbot/cua-driver-windows"),
        NodePath.join(destination, "licenses/cua-driver-windows"),
        { recursive: true },
      );
    }
    const store = NodePath.join(stage, "node_modules/.pnpm");
    const collect = async (directory: string) => {
      for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const directoryPath = NodePath.join(directory, entry.name);
        if (entry.name.startsWith("@")) {
          await collect(directoryPath);
          continue;
        }
        const metadata = await NodeFSP.readFile(
          NodePath.join(directoryPath, "package.json"),
          "utf8",
        ).then(
          (text) => JSON.parse(text) as { name: string; version: string },
          () => undefined,
        );
        if (!metadata) continue;
        const output = NodePath.join(
          destination,
          "licenses/npm",
          `${metadata.name.replaceAll("/", "_")}@${metadata.version}`,
        );
        for (const file of await NodeFSP.readdir(directoryPath, { withFileTypes: true })) {
          if (!file.isFile() || !/^(?:licen[cs]e|notice|copying)(?:\.|$)/i.test(file.name))
            continue;
          await NodeFSP.mkdir(output, { recursive: true });
          await NodeFSP.copyFile(
            NodePath.join(directoryPath, file.name),
            NodePath.join(output, file.name),
          );
        }
      }
    };
    for (const entry of await NodeFSP.readdir(store, { withFileTypes: true }))
      if (entry.isDirectory() && entry.name !== "node_modules")
        await collect(NodePath.join(store, entry.name, "node_modules"));
    await NodeFSP.cp(
      NodePath.join(stage, "third_party"),
      NodePath.join(destination, "third_party"),
      { recursive: true },
    );
    for (const name of ["LICENSE", "NOTICE"])
      await NodeFSP.copyFile(NodePath.join(stage, name), NodePath.join(destination, name));
    await NodeFSP.writeFile(
      NodePath.join(destination, "SOURCE.txt"),
      `OpenMausBot OSS source: https://github.com/milind-soni/OpenMausBot/tree/${MAUSBOT_SOURCE}\nJ1 adaptation is included in j1-adaptation and published with J1 Code source.\n`,
    );
    await NodeFSP.copyFile(
      NodePath.join(stage, "pnpm-lock.yaml"),
      NodePath.join(destination, "pnpm-lock.yaml"),
    );
    await NodeFSP.cp(
      NodePath.join(ownRoot, "scripts/mausbot"),
      NodePath.join(destination, "j1-adaptation"),
      { recursive: true },
    );
    const manifest: Record<string, string> = {};
    const walk = async (dir: string, prefix = "") => {
      for (const entry of await NodeFSP.readdir(dir, { withFileTypes: true })) {
        const relative = prefix + entry.name;
        const path = NodePath.join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new Error("Runtime resources must not contain symlinks.");
        if (entry.isDirectory()) await walk(path, relative + "/");
        else
          manifest[relative] = NodeCrypto.createHash("sha256")
            .update(await NodeFSP.readFile(path))
            .digest("hex");
      }
    };
    await walk(destination);
    await NodeFSP.writeFile(
      NodePath.join(destination, "j1-mausbot-manifest.json"),
      JSON.stringify({ source: repository, commit: MAUSBOT_SOURCE, files: manifest }, null, 2),
    );
  } finally {
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  }
}

export async function stageMausbotArchive(destination: string, sourceCheckout?: string) {
  const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-mausbot-package-"));
  try {
    const payload = NodePath.join(scratch, "payload");
    await stageMausbot(payload, sourceCheckout);
    await NodeFSP.mkdir(destination, { recursive: true });
    await run(
      "tar",
      [
        "-a",
        "-cf",
        NodePath.join(destination, "runtime.zip"),
        "-C",
        payload,
        ...(await NodeFSP.readdir(payload)),
      ],
      { windowsHide: true },
    );
  } finally {
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  if (!process.argv[2]) throw new Error("Supply a new runtime destination directory.");
  await (process.argv.includes("--archive") ? stageMausbotArchive : stageMausbot)(
    NodePath.resolve(process.argv[2]),
    process.argv[3],
  );
}
