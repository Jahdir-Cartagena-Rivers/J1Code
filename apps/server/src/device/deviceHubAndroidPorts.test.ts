import * as NodeNet from "node:net";
import * as NodeVM from "node:vm";
import { expect, it } from "vite-plus/test";
import { patchDeviceHubAndroidPorts } from "./deviceHubAndroidPorts.ts";

const allocator = `async function freeEmulatorPort(listDevicesFn = listDevices) {
  const listed = await listDevicesFn();
  if (listed.error) return result(null, listed.error);
  const used = new Set(listed.value.map(device => Number(/^emulator-(\\d+)$/.exec(device.serial ?? "")?.[1])));
  for (let port = EMULATOR_PORT_MIN; port <= EMULATOR_PORT_MAX; port += 2) {
    if (!used.has(port)) return result(port);
  }
  throw new Error("No free emulator console port available");
}
// ../@expo/hub-android-utils/dist/list-device-profiles.js`;

it("keeps an already patched hub unchanged and rejects an unknown allocator", () => {
  const patched = patchDeviceHubAndroidPorts(allocator);
  expect(patchDeviceHubAndroidPorts(patched)).toBe(patched);
  expect(() => patchDeviceHubAndroidPorts("unrecognized")).toThrow("Unsupported pinned");
});

it("returns an available pair and releases its probe listeners", async () => {
  const run = NodeVM.compileFunction(
    patchDeviceHubAndroidPorts(allocator) + "\n; return freeEmulatorPort();",
    ["EMULATOR_PORT_MIN", "EMULATOR_PORT_MAX", "listDevices", "result"],
    { importModuleDynamically: NodeVM.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
  );
  const answer = await run(
    5554,
    5682,
    async () => ({ value: [], error: null }),
    (value: number) => ({ value }),
  );
  expect(answer.value).toBeGreaterThanOrEqual(5554);
  expect(answer.value).toBeLessThanOrEqual(5682);
  const server = NodeNet.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(answer.value, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

it.each([0, 1])(
  "skips an occupied console/ADB port even when ADB lists no devices (offset %s)",
  async (offset) => {
    const server = NodeNet.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture listener");
      const first = address.port - offset;
      const source = patchDeviceHubAndroidPorts(allocator);
      const run = NodeVM.compileFunction(
        source + "\n; return freeEmulatorPort();",
        ["EMULATOR_PORT_MIN", "EMULATOR_PORT_MAX", "listDevices", "result"],
        { importModuleDynamically: NodeVM.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
      );
      const answer = await run(
        first,
        first,
        async () => ({ value: [], error: null }),
        (value: number) => ({ value }),
      ).catch((error: Error) => error);
      expect(answer).toBeInstanceOf(Error);
      expect(answer.message).toBe("No free emulator console port available");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
