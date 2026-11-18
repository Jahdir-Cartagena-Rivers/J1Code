// @effect-diagnostics nodeBuiltinImport:off - Standalone local maintainer launcher; never packages a release.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeCrypto from "node:crypto";

const root = NodePath.resolve(import.meta.dirname, "..");

/** One launcher owns the worktree QA profile. A stale lock requires inspection, never a PID-pattern kill. */
export async function acquireQaLease(home: string) {
  const lock = `${home}.launch.lock`;
  await NodeFSP.mkdir(NodePath.dirname(lock), { recursive: true });
  const owner = JSON.stringify({ pid: process.pid, id: NodeCrypto.randomUUID() });
  const handle = await NodeFSP.open(lock, "wx").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST")
      throw new Error(
        `A QA launcher already owns ${lock}. Reuse its server. If it crashed, inspect the lock's PID before removing that lock.`,
      );
    throw error;
  });
  await handle.writeFile(owner);
  await handle.close();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if ((await NodeFSP.readFile(lock, "utf8").catch(() => "")) === owner)
      await NodeFSP.unlink(lock);
  };
}

/** Reuses one verified archive and serves watch output without making another ZIP or QA profile. */
export async function mausbotQaEnvironment(resources: string, uiDir: string, serverDir?: string) {
  const archiveDir = await NodeFSP.realpath(resources);
  const output = await NodeFSP.realpath(uiDir);
  await NodeFSP.access(NodePath.join(archiveDir, "runtime.zip"));
  await NodeFSP.access(NodePath.join(output, "index.html"));
  const server = serverDir ? await NodeFSP.realpath(serverDir) : undefined;
  if (server) await NodeFSP.access(NodePath.join(server, "index.js"));
  return {
    J1_MAUSBOT_RESOURCES: archiveDir,
    J1_MAUSBOT_DEV_UI_DIR: output,
    ...(server ? { J1_MAUSBOT_DEV_SERVER_DIR: server } : {}),
    T3CODE_HOME: NodePath.join(root, ".t3", "mausbot-qa"),
    PATH: [NodePath.join(root, "node_modules", ".bin"), process.env.PATH ?? ""].join(
      NodePath.delimiter,
    ),
  };
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      resources: { type: "string" },
      "ui-dir": { type: "string" },
      "server-dir": { type: "string" },
      desktop: { type: "boolean", default: false },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write(
      "node scripts/mausbot-qa.ts --resources <verified-archive-dir> --ui-dir <Maus-dist> [--server-dir <Maus-dist-server>] [--desktop]\nKeep vite build --watch --base=./ running in the prepared Maus assembly; reload after a rebuild. --server-dir uses the assembly's rebuilt server without another runtime archive (restart QA after rebuilding it). J1 web uses its normal HMR. State stays in this worktree's .t3/mausbot-qa. --desktop runs the native development app with isolated Electron storage.\n",
    );
  } else {
    if (!values.resources || !values["ui-dir"])
      throw new Error("Supply --resources and --ui-dir; use --help for the development workflow.");
    const env = await mausbotQaEnvironment(
      values.resources,
      values["ui-dir"],
      values["server-dir"],
    );
    const release = await acquireQaLease(env.T3CODE_HOME);
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        NodePath.join(root, "scripts/dev-runner.ts"),
        values.desktop ? "dev:desktop" : "dev",
        "--home-dir",
        env.T3CODE_HOME,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          ...env,
          ...(values.desktop
            ? {
                APPDATA: NodePath.join(env.T3CODE_HOME, "electron"),
                T3CODE_DESKTOP_AUTO_OPEN_DEVTOOLS: "false",
              }
            : {}),
        },
        stdio: "inherit",
        windowsHide: true,
      },
    );
    const stop = () => {
      if (child.exitCode !== null) return;
      // Windows cannot deliver POSIX signals through this wrapper. Stop only the
      // captured dev-runner tree; never match other J1 processes by name or path.
      // oxlint-disable-next-line j1code/no-global-process-runtime -- Standalone Node launcher owns its captured process tree.
      if (process.platform === "win32" && child.pid) {
        NodeChildProcess.spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
        });
      } else child.kill("SIGTERM");
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    child.once("error", (error) => {
      process.stderr.write(error.message + "\n");
      process.exitCode = 1;
      void release();
    });
    child.once("exit", (code) => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      process.exitCode = code ?? 1;
      void release();
    });
  }
}
