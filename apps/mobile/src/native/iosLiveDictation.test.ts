import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ os: "ios", resolve: vi.fn() }));
vi.mock("expo", () => ({ requireOptionalNativeModule: mocks.resolve }));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return mocks.os;
    },
  },
}));

beforeEach(() => {
  vi.resetModules();
  mocks.resolve.mockReset();
  mocks.os = "ios";
});

it("leaves old binaries without the bridge on the fallback path", async () => {
  mocks.resolve.mockReturnValue(null);
  expect((await import("./iosLiveDictation")).iosLiveDictation).toBeNull();
});

it("never resolves the iOS bridge on another platform", async () => {
  mocks.os = "android";
  expect((await import("./iosLiveDictation")).iosLiveDictation).toBeNull();
  expect(mocks.resolve).not.toHaveBeenCalled();
});

it("exposes the registered bridge and allocates distinct session identities", async () => {
  const bridge = { startDictation: vi.fn() };
  mocks.resolve.mockReturnValue(bridge);
  const api = await import("./iosLiveDictation");
  expect(api.iosLiveDictation).toBe(bridge);
  expect(api.nextIOSLiveDictationSession()).not.toBe(api.nextIOSLiveDictationSession());
});
