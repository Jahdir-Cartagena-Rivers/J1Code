// @effect-diagnostics nodeBuiltinImport:off - Owns the native helper process and its private pipes.
// @effect-diagnostics globalTimers:off - Clears deadlines when its captured child exits.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";
import * as NodeCrypto from "node:crypto";
import { mausbotChildEnvironment } from "./ChildEnvironment.ts";

/** A separate SDK host cannot crash J1 or attach to the installed Mausbot helper identity. */
export async function startMausbotComputer(resources: string) {
  const native = NodePath.join(resources, "native");
  const hostId = `com.j1code.mausbot-runtime.${NodeCrypto.randomBytes(12).toString("hex")}`;
  const child = NodeChildProcess.spawn(
    process.execPath,
    [NodePath.join(native, "j1-computer-host.mjs")],
    {
      cwd: native,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...mausbotChildEnvironment(),
        ELECTRON_RUN_AS_NODE: "1",
        J1_MAUSBOT_COMPUTER_ID: hostId,
      },
    },
  );
  child.stderr.resume();
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
    child.once("error", () => {
      exited = true;
      resolve();
    });
  });
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      if (exited) return;
      child.stdin.end();
      let deadline: ReturnType<typeof NodeTimers.setTimeout> | undefined;
      await Promise.race([
        exit,
        new Promise<void>((resolve) => {
          deadline = NodeTimers.setTimeout(() => {
            child.kill();
            resolve();
          }, 5_000);
        }),
      ]);
      if (deadline) NodeTimers.clearTimeout(deadline);
      if (!exited) await exit;
    })());
  try {
    const socketPath = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      const deadline = NodeTimers.setTimeout(
        () => finish(new Error("The native computer helper did not become ready.")),
        25_000,
      );
      const failed = () =>
        finish(new Error("The native computer helper exited before becoming ready."));
      const finish = (error?: Error, socket?: string) => {
        NodeTimers.clearTimeout(deadline);
        child.stdout.off("data", read);
        child.off("exit", failed);
        child.off("error", failed);
        if (error) reject(error);
        else resolve(socket!);
      };
      const read = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (buffer.length > 16_384)
          return finish(new Error("The native helper returned an oversized readiness response."));
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const value: unknown = JSON.parse(line);
            if (
              typeof value === "object" &&
              value !== null &&
              "type" in value &&
              value.type === "j1:computer-ready" &&
              "socketPath" in value &&
              typeof value.socketPath === "string" &&
              value.socketPath.length > 0 &&
              value.socketPath.length < 4_096
            )
              finish(undefined, value.socketPath);
          } catch {
            /* Native diagnostics are not a readiness descriptor. */
          }
        }
      };
      child.stdout.on("data", read);
      child.once("exit", failed);
      child.once("error", failed);
    });
    child.stdout.resume();
    return {
      descriptor: {
        mode: "embedded",
        socketPath,
        mcpCommand: NodePath.join(native, "cua-driver.exe"),
        mcpArgs: ["mcp", "--embedded", "--socket", socketPath],
        mcpEnv: {
          CUA_DRIVER_EMBEDDED: "1",
          CUA_DRIVER_HOST_BUNDLE_ID: hostId,
          CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
          CUA_DRIVER_RS_UPDATE_CHECK: "false",
        },
      },
      stop,
      closed: exit,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
