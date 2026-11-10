// @effect-diagnostics nodeBuiltinImport:off - Native identity probe matches the upstream desktop protocol and returns only a hash.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const placeholders = new Set([
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "03000200-0400-0500-0006-000700080009",
]);
const run = (file: string, args: string[]) =>
  new Promise<string>((resolve) => {
    NodeChildProcess.execFile(
      file,
      args,
      { encoding: "utf8", timeout: 10000, windowsHide: true },
      (error, stdout) => resolve(error ? "" : stdout),
    );
  });

/** Match DeepAI Code's hardware identity; only its digest leaves this process. */
async function detect(platform: NodeJS.Platform) {
  let raw: string | undefined;
  if (platform === "win32") {
    raw = (
      await run("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance Win32_ComputerSystemProduct).UUID",
      ])
    )
      .match(uuid)?.[0]
      ?.toLowerCase();
    if (!raw || placeholders.has(raw))
      raw = (
        await run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"])
      )
        .match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1]
        ?.toLowerCase();
  } else if (platform === "darwin") {
    raw = (await run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]))
      .match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1]
      ?.toLowerCase();
  } else {
    raw = await NodeFSP.readFile("/etc/machine-id", "utf8")
      .then((s) => s.trim())
      .catch(() => undefined);
  }
  return raw ? NodeCrypto.createHash("sha256").update(raw).digest("hex") : undefined;
}
let pending: ReturnType<typeof detect> | undefined;
export const deepAIMachineDigest = (platform: NodeJS.Platform) => (pending ??= detect(platform));
