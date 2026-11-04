// @effect-diagnostics nodeBuiltinImport:off
import { beforeEach, expect, it, vi } from "vite-plus/test";
const mock = vi.hoisted(() => ({ exists: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: mock.exists }));
import { getWhisperRuntime } from "./WhisperRuntime.ts";
beforeEach(() => mock.exists.mockReset());
it("keeps the Windows recognizer when no local model is installed", () => {
  mock.exists.mockReturnValue(false);
  expect(getWhisperRuntime({ LOCALAPPDATA: "C:/Local" })).toBeNull();
});
it("selects an installed model and supports a separate runtime directory", () => {
  mock.exists.mockReturnValue(true);
  expect(getWhisperRuntime({ J1_DICTATION_HOME: "C:/Voice" })).toEqual({
    python: expect.stringContaining("python.exe"),
    model: expect.stringContaining("model"),
  });
  expect(mock.exists).toHaveBeenCalledWith(expect.stringContaining("model.bin"));
});
