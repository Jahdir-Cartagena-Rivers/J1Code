import { expect, it } from "vite-plus/test";
import { resolveBrowserExecutable } from "./executable.ts";
it("resolves bundled, custom, disabled and unbundled paths", () => {
  expect(resolveBrowserExecutable("", "D:/bundle/lightpanda.exe")).toBe("D:/bundle/lightpanda.exe");
  expect(resolveBrowserExecutable("C:/custom/browser.exe", "D:/bundle.exe")).toBe(
    "C:/custom/browser.exe",
  );
  expect(resolveBrowserExecutable(" ")).toBe("");
  expect(() => resolveBrowserExecutable("disabled", "D:/bundle.exe")).toThrow("disabled");
});
