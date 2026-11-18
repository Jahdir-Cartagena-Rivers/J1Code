// @effect-diagnostics nodeBuiltinImport:off - Native path fixtures for CLI configuration.
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { resolveMausbotDevUiDir, resolveMausbotDevServerDir } from "./DevUi.ts";

describe("Mausbot development UI", () => {
  it("keeps packaged launches unchanged and requires an explicit development server for overrides", () => {
    expect(resolveMausbotDevUiDir(undefined, undefined)).toBeUndefined();
    expect(resolveMausbotDevUiDir(" ", undefined)).toBeUndefined();
    expect(() => resolveMausbotDevUiDir(NodePath.resolve("dist"), undefined)).toThrow(
      "development server",
    );
  });
  it("rejects relative directories instead of interpreting them in a child working directory", () => {
    expect(() => resolveMausbotDevUiDir("dist", new URL("http://localhost:5173"))).toThrow(
      "absolute",
    );
    const directory = NodePath.resolve("sandbox/dist");
    expect(resolveMausbotDevUiDir(directory, new URL("http://localhost:5173"))).toBe(directory);
  });
  it("never loads an unsigned source server override into a packaged launch", () => {
    expect(() => resolveMausbotDevServerDir(NodePath.resolve("dist-server"), undefined)).toThrow(
      "development server",
    );
    expect(() =>
      resolveMausbotDevServerDir("dist-server", new URL("http://localhost:7172")),
    ).toThrow("absolute");
    expect(resolveMausbotDevServerDir(undefined, undefined)).toBeUndefined();
  });
});
