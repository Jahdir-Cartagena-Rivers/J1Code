import type { DesktopBridge } from "@t3tools/contracts";

/** A remote environment must never acquire this client's folders or physical screen. */
export function localMausbotHost(
  bridge:
    | Pick<
        DesktopBridge,
        "getClientPlatform" | "getLocalEnvironmentBootstraps" | "captureMausbotScreenFrame"
      >
    | undefined,
  httpBaseUrl: string | null,
  serverPlatform: string | undefined,
) {
  const platform = bridge?.getClientPlatform?.();
  if (
    !bridge ||
    !httpBaseUrl ||
    !platform ||
    platform !== serverPlatform ||
    !["win32", "darwin", "linux"].includes(platform)
  )
    return null;
  try {
    const origin = new URL(httpBaseUrl).origin;
    const local = bridge
      .getLocalEnvironmentBootstraps()
      .some(
        (entry) =>
          entry.id === "primary" &&
          !entry.runningDistro &&
          entry.httpBaseUrl &&
          new URL(entry.httpBaseUrl).origin === origin,
      );
    return local
      ? { platform, capture: typeof bridge.captureMausbotScreenFrame === "function" }
      : null;
  } catch {
    return null;
  }
}
