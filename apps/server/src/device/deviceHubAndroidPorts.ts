/** Compatibility fix for the pinned hub, whose ADB inventory omits offline emulators. */
export function patchDeviceHubAndroidPorts(source: string): string {
  if (source.includes("async function j1EmulatorPortPairAvailable(port)")) return source;
  const anchor = "async function freeEmulatorPort(listDevicesFn = listDevices) {";
  const end = "\n// ../@expo/hub-android-utils/dist/list-device-profiles.js";
  const start = source.indexOf(anchor);
  const stop = source.indexOf(end, start);
  if (start < 0 || stop < 0) throw new Error("Unsupported pinned device hub port allocator");
  const original = source.slice(start, stop);
  if (!original.includes("if (!used.has(port))"))
    throw new Error("Unsupported pinned device hub port selection");
  const probe = String.raw`async function j1EmulatorPortPairAvailable(port) {
  const { createServer } = await import("node:net");
  const held = [];
  try {
    for (const candidate of [port, port + 1]) {
      for (const host of ["127.0.0.1", "::1"]) {
        const available = await new Promise((resolve, reject) => {
          const server = createServer();
          server.unref();
          server.once("error", error => {
            if (host === "::1" && ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)) resolve(true);
            else if (["EADDRINUSE", "EACCES"].includes(error.code)) resolve(false);
            else reject(error);
          });
          server.listen({ port: candidate, host, ipv6Only: true, exclusive: true }, () => {
            held.push(server);
            resolve(true);
          });
        });
        if (!available) return false;
      }
    }
    return true;
  } finally {
    await Promise.all(held.map(server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  }
}
`;
  return (
    source.slice(0, start) +
    probe +
    original.replace(
      "if (!used.has(port))",
      "if (!used.has(port) && await j1EmulatorPortPairAvailable(port))",
    ) +
    source.slice(stop)
  );
}
