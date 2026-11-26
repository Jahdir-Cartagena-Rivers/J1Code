import { DEFAULT_CLIENT_SETTINGS } from "@j1code/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function getTestWindow(): Window & typeof globalThis {
  const localStorage = createLocalStorageStub();
  const testWindow = {
    localStorage,
  } as Window & typeof globalThis;
  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("localStorage", localStorage);
  return testWindow;
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("clientPersistenceStorage", () => {
  it.each([
    "not-json",
    '{"wordWrap":"invalid"}',
    '{"legacySidebarEnabled":true,"boringSidebarEnabled":"false"}',
    '{"legacySidebarEnabled":null}',
  ])(
    "does not treat invalid saved settings as absent: %s",
    async (value) => {
      const testWindow = getTestWindow();
      testWindow.localStorage.setItem("t3code:client-settings:v1", value);
      const { readBrowserClientSettings } = await import("./clientPersistenceStorage");

      expect(() => readBrowserClientSettings()).toThrow(
        expect.objectContaining({
          _tag: "LocalStorageOperationError",
          operation: "decode",
          storageKey: "t3code:client-settings:v1",
        }),
      );
      expect(testWindow.localStorage.getItem("t3code:client-settings:v1")).toBe(value);
    },
  );

  it.each([
    { raw: { legacySidebarEnabled: true }, expected: true },
    { raw: { legacySidebarEnabled: false }, expected: false },
    { raw: { legacySidebarEnabled: true, boringSidebarEnabled: false }, expected: false },
    { raw: {}, expected: false },
  ])("decodes the stored sidebar preference without rewriting it: %j", async ({ raw, expected }) => {
    const testWindow = getTestWindow();
    const key = "t3code:client-settings:v1";
    const serialized = JSON.stringify({ ...raw, timestampFormat: "24-hour" });
    testWindow.localStorage.setItem(key, serialized);
    const { readBrowserClientSettings } = await import("./clientPersistenceStorage");

    expect(readBrowserClientSettings()).toMatchObject({
      boringSidebarEnabled: expected,
      timestampFormat: "24-hour",
    });
    expect(testWindow.localStorage.getItem(key)).toBe(serialized);
  });

  it("preserves saved settings across a transient read failure", async () => {
    const testWindow = getTestWindow();
    const settings = { ...DEFAULT_CLIENT_SETTINGS, timestampFormat: "12-hour" as const };
    testWindow.localStorage.setItem("t3code:client-settings:v1", JSON.stringify(settings));
    const write = vi.spyOn(testWindow.localStorage, "setItem");
    const failure = new Error("storage unavailable");
    vi.spyOn(testWindow.localStorage, "getItem").mockImplementationOnce(() => {
      throw failure;
    });
    const { readBrowserClientSettings } = await import("./clientPersistenceStorage");

    expect(() => readBrowserClientSettings()).toThrow(
      expect.objectContaining({
        _tag: "LocalStorageOperationError",
        operation: "read",
        storageKey: "t3code:client-settings:v1",
        cause: failure,
      }),
    );
    expect(readBrowserClientSettings()).toEqual(settings);
    expect(write).not.toHaveBeenCalled();
  });
});
