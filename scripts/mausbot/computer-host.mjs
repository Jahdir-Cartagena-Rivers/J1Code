// Own the native SDK in a disposable process, never in J1's server or the installed Mausbot app.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const native = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const hostId = process.env.J1_MAUSBOT_COMPUTER_ID;
delete process.env.J1_MAUSBOT_COMPUTER_ID;
if (!hostId || !/^com\.j1code\.mausbot-runtime\.[a-f0-9]{24}$/.test(hostId))
  throw new Error("Missing J1 helper identity.");
process.env.OPENMAUSBOT_CUA_SDK_LIBRARY = NodePath.join(
  native,
  "cua-sdk/native/cua_driver_sdk.dll",
);
process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = "false";
process.env.CUA_DRIVER_RS_UPDATE_CHECK = "false";
const sdk = await import(NodeURL.pathToFileURL(NodePath.join(native, "cua-sdk/cua-sdk.mjs")).href);
const host = new sdk.EmbeddedCuaDriverHost(
  NodePath.join(native, "cua-driver-background.exe"),
  hostId,
);
let closing;
const stop = () =>
  (closing ??= (async () => {
    try {
      await host.stop();
    } finally {
      host.uniffiDestroy?.();
    }
  })());
process.stdin.resume();
process.stdin.once("end", () => {
  void stop().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void stop().finally(() => process.exit(0));
});
try {
  const { socketPath } = await host.start({ signal: AbortSignal.timeout(20_000) });
  if (closing) await closing;
  else console.log(JSON.stringify({ type: "j1:computer-ready", socketPath }));
} catch {
  await stop();
  process.exitCode = 1;
}
