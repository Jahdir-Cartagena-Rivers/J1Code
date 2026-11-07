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
it("supports older clients without the native voice module", async () => {
  mocks.resolve.mockReturnValue(null);
  expect((await import("./botVoice")).botVoice).toBeNull();
});
it.each(["ios", "android"])("uses the registered native voice module on %s", async (os) => {
  mocks.os = os;
  const bridge = { speak: vi.fn() };
  mocks.resolve.mockReturnValue(bridge);
  expect((await import("./botVoice")).botVoice).toBe(bridge);
  expect(mocks.resolve).toHaveBeenCalledWith("T3BotVoice");
});
it("does not resolve the native module on unsupported platforms", async () => {
  mocks.os = "web";
  expect((await import("./botVoice")).botVoice).toBeNull();
  expect(mocks.resolve).not.toHaveBeenCalled();
});
