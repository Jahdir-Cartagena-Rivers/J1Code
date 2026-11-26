import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.doUnmock("react");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("theme failure handling", () => {
  it("preserves exact storage read causes and operation context", async () => {
    const readCause = new Error("storage read blocked");
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => {
          throw readCause;
        },
      }),
    });

    const { readThemePreference, ThemeStorageError } =
      await import("./useTheme");

    try {
      readThemePreference();
      expect.unreachable("expected the theme read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ThemeStorageError);
      expect(error).toMatchObject({
        operation: "read",
        storageKey: "t3code:theme",
        cause: readCause,
      });
    }


  });

  it("refuses a failed preference write and restores the saved theme mix", async () => {
    const cause = new Error("private storage quota failure");
    const storage = createStorage();
    const previousMix = JSON.stringify({ light: "t3-ocean", dark: "t3-grove" });
    storage.setItem("t3code:theme", "light");
    storage.setItem("t3code:theme-halves:v1", previousMix);
    const write = storage.setItem;
    storage.setItem = (key, value) => {
      if (key === "t3code:theme") throw cause;
      write(key, value);
    };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("window", { localStorage: storage });
    vi.stubGlobal("document", undefined);
    const { setTheme } = await import("./useTheme");
    expect(setTheme("dark")).toBe(false);
    expect(storage.getItem("t3code:theme")).toBe("light");
    expect(storage.getItem("t3code:theme-halves:v1")).toBe(previousMix);
    expect(errorLog).toHaveBeenCalledWith(
      "Failed to write theme preference for t3code:theme.",
      expect.objectContaining({ operation: "write", storageKey: "t3code:theme", theme: "dark", errorTag: "ThemeStorageError" }),
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(cause.message);
  });

  it("reads the persisted J1 Chat theme preference", async () => {
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => "t3-chat",
      }),
    });

    const { readThemePreference } = await import("./useTheme");

    expect(readThemePreference()).toBe("t3-chat");
  });

  it("falls back during initial theme application and logs only safe attributes", async () => {
    const cause = new Error("private browsing storage failure");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => {
          throw cause;
        },
      }),
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal("document", {
      documentElement: {
        classList: { toggle: vi.fn() },
      },
    });

    await expect(import("./useTheme")).resolves.toBeDefined();

    expect(errorLog).toHaveBeenCalledWith(
      "Failed to read theme preference for t3code:theme.",
      expect.objectContaining({
        operation: "read",
        storageKey: "t3code:theme",
        errorTag: "ThemeStorageError",
      }),
    );
    const attributes = errorLog.mock.calls[0]?.[1];
    expect(attributes).not.toHaveProperty("cause");
    expect(JSON.stringify(attributes)).not.toContain(cause.message);
  });

  it("retries a failed storage read only after a relevant storage event", async () => {
    const cause = new Error("persistent storage failure");
    const themeGetItem = vi.fn((): string | null => {
      throw cause;
    });
    const getItem = vi.fn((key: string) => (key === "t3code:theme" ? themeGetItem() : null));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let readSnapshot: (() => unknown) | undefined;
    let subscribeToTheme: ((listener: () => void) => () => void) | undefined;
    let storageHandler: ((event: StorageEvent) => void) | undefined;
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useEffect: () => undefined,
      useSyncExternalStore: (
        subscribe: (listener: () => void) => () => void,
        getSnapshot: () => unknown,
      ) => {
        subscribeToTheme = subscribe;
        readSnapshot = getSnapshot;
        return getSnapshot();
      },
    }));
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        if (type === "storage") storageHandler = listener;
      },
      localStorage: createStorage({ getItem }),
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      removeEventListener: () => undefined,
    });

    const { useTheme } = await import("./useTheme");
    useTheme();
    readSnapshot?.();
    readSnapshot?.();

    expect(themeGetItem).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);

    const unsubscribe = subscribeToTheme?.(() => undefined);
    storageHandler?.({ key: "t3code:theme" } as StorageEvent);
    readSnapshot?.();

    expect(themeGetItem).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledTimes(2);
    unsubscribe?.();
  });

  it("retries failed cosmetic desktop sync through the public theme action", async () => {
    const cause = new Error("private desktop IPC failure");
    let reportFailure!: () => void;
    const failureReported = new Promise<void>((resolve) => { reportFailure = resolve; });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => reportFailure());
    const desktopSetTheme = vi.fn().mockRejectedValueOnce(cause).mockResolvedValue(undefined);
    vi.stubGlobal("document", undefined);
    const storage = createStorage();
    storage.setItem("t3code:theme", "dark");
    storage.setItem("t3code:theme-appearance-mode", "dark");
    vi.stubGlobal("window", { localStorage: storage, desktopBridge: { setTheme: desktopSetTheme } });
    const { setTheme, setAppearanceMode } = await import("./useTheme");
    vi.stubGlobal("document", {
      documentElement: { dataset: {}, classList: { toggle: vi.fn(), add: vi.fn(), remove: vi.fn() } },
    });
    vi.stubGlobal("getComputedStyle", undefined);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
    expect(setTheme("dark")).toBe(true);
    await failureReported;
    expect(errorLog).toHaveBeenCalledWith(
      "Failed to sync the dark theme to the desktop shell.",
      expect.objectContaining({ theme: "dark", errorTag: "DesktopThemeSyncError" }),
    );
    expect(setTheme("dark")).toBe(true);
    expect(desktopSetTheme).toHaveBeenCalledTimes(2);
    expect(setAppearanceMode("light")).toBe(true);
    expect(desktopSetTheme).toHaveBeenLastCalledWith("light");
    for (const [, attributes] of errorLog.mock.calls) {
      expect(attributes).not.toHaveProperty("cause");
      expect(JSON.stringify(attributes)).not.toContain(cause.message);
    }
  });
});
