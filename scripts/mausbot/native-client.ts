// This adapter exposes only J1-owned native operations to the pinned upstream UI.
type Host = { platform: "win32" | "darwin" | "linux"; capture: boolean };
const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: number }
>();
const capabilityListeners = new Set<(value: DesktopCapabilities) => void>();
let origin: string | undefined;
let nextId = 0;
let nativeHost: Host | undefined;
export function subscribeNativeCapabilities(listener: (value: DesktopCapabilities) => void) {
  capabilityListeners.add(listener);
  return () => {
    capabilityListeners.delete(listener);
  };
}
function capabilities(value: unknown): DesktopCapabilities {
  if (!nativeHost || !value || typeof value !== "object")
    throw new Error("The assistant runtime needs an update.");
  return {
    ...value,
    screenPreview: {
      available: nativeHost.capture,
      interaction: "none",
      ...(nativeHost.capture ? {} : { reasonCode: "unsupported-platform" }),
    },
  } as DesktopCapabilities;
}

function invoke(method: string, args?: unknown): Promise<unknown> {
  if (!origin) return Promise.reject(new Error("The J1 desktop connection is unavailable."));
  if (pending.size >= 32) return Promise.reject(new Error("Too many desktop requests are open."));
  const requestId = `desktop-${++nextId}`;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => {
        pending.delete(requestId);
        reject(new Error("The desktop request expired."));
      },
      method === "settingsSearch" ? 10_000 : 30 * 60_000,
    );
    pending.set(requestId, { resolve, reject, timer });
    window.parent.postMessage(
      { source: "j1-mausbot", type: "host-call", requestId, method, args },
      origin!,
    );
  });
}
export const j1Request = invoke;

/** Runs before React startup, so the original capability provider can subscribe normally. */
export async function prepareNativeHost() {
  const expected = new URLSearchParams(location.hash.slice(1)).get("j1-origin");
  if (!expected || parent === window) return;
  await new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, 3_000);
    let initialized = false;
    window.addEventListener("message", (event) => {
      if (event.source !== parent || event.origin !== expected || event.data?.source !== "j1-host")
        return;
      const value = event.data;
      if (value.type === "host-result" && typeof value.requestId === "string") {
        const request = pending.get(value.requestId);
        if (!request) return;
        pending.delete(value.requestId);
        clearTimeout(request.timer);
        if (typeof value.error === "string") request.reject(new Error(value.error));
        else request.resolve(value.value);
      }
      if (!initialized && value.navigation) {
        initialized = true;
        origin = event.origin;
        const host = value.navigation.nativeHost as Host | null;
        if (host && ["win32", "darwin", "linux"].includes(host.platform)) install(host);
        clearTimeout(timer);
        resolve();
      }
    });
    parent.postMessage({ source: "j1-mausbot", type: "bootstrap" }, expected);
  });
}

function install(host: Host) {
  nativeHost = host;
  const getCapabilities = async () => {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error("Could not read assistant capabilities.");
    const { j1DesktopCapabilities } = await response.json();
    if (!j1DesktopCapabilities || typeof j1DesktopCapabilities !== "object")
      throw new Error("The assistant runtime needs an update.");
    return capabilities(j1DesktopCapabilities);
  };
  const adapter: Partial<NonNullable<Window["ogb"]>> = {
    platform: host.platform,
    getCapabilities,
    onCapabilitiesChanged: (listener) => {
      capabilityListeners.add(listener);
      return () => {
        capabilityListeners.delete(listener);
      };
    },
    openExternal: async (url) => Boolean(await invoke("openExternal", { url })),
    pickFolder: async (current) => (await invoke("pickFolder", { current })) as string | null,
    screenFrame: async () =>
      host.capture ? ((await invoke("screenFrame")) as string | null) : null,
    beginScreenPreviewIntent: () => false,
    approvals: {
      setMode: async (botId, mode, options) =>
        (await invoke("approvalMode", { botId, mode, options })) as Awaited<
          ReturnType<NonNullable<NonNullable<Window["ogb"]>["approvals"]>["setMode"]>
        >,
    },
  };
  // Unsupported desktop members stay absent, preserving the upstream web/platform fallbacks.
  window.ogb = adapter as NonNullable<Window["ogb"]>;
  void getCapabilities()
    .then((value) => {
      for (const listener of capabilityListeners) listener(value);
    })
    .catch(() => undefined);
}

export function publishNativeCapabilities(config: unknown) {
  if (!nativeHost || !config || typeof config !== "object" || !("j1DesktopCapabilities" in config))
    return;
  const value = capabilities(config.j1DesktopCapabilities);
  for (const listener of capabilityListeners) listener(value);
}
