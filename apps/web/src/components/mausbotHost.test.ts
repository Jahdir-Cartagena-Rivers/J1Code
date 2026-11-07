import { describe, expect, it } from "vite-plus/test";
import { localMausbotHost } from "./mausbotHost";

const bootstrap = {
  id: "primary",
  label: "This computer",
  httpBaseUrl: "http://127.0.0.1:3777",
  wsBaseUrl: "ws://127.0.0.1:3777",
};
const bridge = {
  getClientPlatform: () => "win32",
  getLocalEnvironmentBootstraps: () => [bootstrap],
  captureMausbotScreenFrame: async () => null,
};
describe("assistant desktop isolation", () => {
  it("offers this client's native operations only to its matching local backend", () => {
    expect(localMausbotHost(bridge, bootstrap.httpBaseUrl, "win32")).toEqual({
      platform: "win32",
      capture: true,
    });
  });
  it("never lends this PC's screen or folder picker to a remote or WSL environment", () => {
    expect(localMausbotHost(bridge, "https://remote.example", "win32")).toBeNull();
    expect(localMausbotHost(bridge, bootstrap.httpBaseUrl, "linux")).toBeNull();
    expect(
      localMausbotHost(
        {
          ...bridge,
          getLocalEnvironmentBootstraps: () => [{ ...bootstrap, runningDistro: "Ubuntu" }],
        },
        bootstrap.httpBaseUrl,
        "win32",
      ),
    ).toBeNull();
    expect(localMausbotHost(undefined, bootstrap.httpBaseUrl, "win32")).toBeNull();
    expect(localMausbotHost(bridge, "not a URL", "win32")).toBeNull();
  });
});
