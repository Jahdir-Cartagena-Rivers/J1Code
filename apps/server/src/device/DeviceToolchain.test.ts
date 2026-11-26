import * as PlatformError from "effect/PlatformError";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import {
  AGENT_DEVICE_VERSION,
  deviceToolVersions,
  DEVICE_HUB_VERSION,
  ensureDeviceHub,
  installedAgentDeviceEntry,
  isDeviceHubInstalled,
} from "./DeviceToolchain.ts";

it.effect.each([true, false])(
  "patches an existing pinned hub safely (recognized=%s)",
  (recognized) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped();
      const dir = path.join(base, "tools", "expo-device-hub", DEVICE_HUB_VERSION);
      const server = path.join(dir, "node_modules/expo-device-hub/dist/server");
      yield* fs.makeDirectory(server, { recursive: true });
      yield* fs.writeFileString(path.join(server, "cli.mjs"), "");
      yield* fs.writeFileString(path.join(dir, ".install-complete"), DEVICE_HUB_VERSION);
      const original = recognized
        ? "async function freeEmulatorPort(listDevicesFn = listDevices) { if (!used.has(port)) return result(port); }\n// ../@expo/hub-android-utils/dist/list-device-profiles.js"
        : "unsupported module";
      const file = path.join(server, "index.mjs");
      yield* fs.writeFileString(file, original);
      const result = yield* ensureDeviceHub(base).pipe(Effect.result);
      if (recognized) {
        expect(result._tag).toBe("Success");
        expect(yield* fs.readFileString(`${file}.j1-before-android-ports`)).toBe(original);
        const patched = yield* fs.readFileString(file);
        yield* ensureDeviceHub(base);
        expect(yield* fs.readFileString(file)).toBe(patched);
        expect(yield* fs.readFileString(`${file}.j1-before-android-ports`)).toBe(original);
      } else {
        expect(result._tag).toBe("Failure");
        expect(yield* fs.readFileString(file)).toBe(original);
        expect(yield* fs.exists(`${file}.j1-before-android-ports`)).toBe(false);
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () => Effect.die("Unexpected package installation"),
      }),
    ),
);

it.effect("failed installation cleans staging and exposes only a safe failure message", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-install-" });
    const result = {
      code: ChildProcessSpawner.ExitCode(1),
      stdout: "",
      stderr: "registry rejected https://private:credential@example.test/package",
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    };
    const error = yield* ensureDeviceHub(baseDir).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () => Effect.succeed(result),
      }),
      Effect.flip,
    );
    expect(error.message).toBe(
      "Installing expo-device-hub failed while running npm install (exit code 1).",
    );
    expect(error.cause).toBe(result);
    expect(yield* isDeviceHubInstalled(baseDir)).toBe(false);
    expect(yield* fs.readDirectory(path.join(baseDir, "tools", "expo-device-hub"))).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("inventory reports only completed versions without installing the required version", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped();
    for (const [version, sentinel] of [
      ["0.9.0", "0.9.0"],
      [DEVICE_HUB_VERSION, "wrong"],
      [".staging-123", ".staging-123"],
    ]) {
      const dir = path.join(base, "tools", "expo-device-hub", version!);
      yield* fs.makeDirectory(path.join(dir, "node_modules/expo-device-hub/dist/server"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(dir, "node_modules/expo-device-hub/dist/server/cli.mjs"),
        "",
      );
      yield* fs.writeFileString(path.join(dir, ".install-complete"), sentinel!);
    }
    const tools = yield* deviceToolVersions(base);
    expect(tools?.hub).toEqual({
      requiredVersion: DEVICE_HUB_VERSION,
      installedVersions: ["0.9.0"],
      runningVersion: null,
    });
    expect(tools?.agent.installedVersions).toEqual([]);
    expect(yield* isDeviceHubInstalled(base)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("unreadable inventory stays unknown instead of reporting no installs", () =>
  Effect.gen(function* () {
    const tools = yield* deviceToolVersions("/unreadable");
    expect(tools).toBeUndefined();
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        readDirectory: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "readDirectory",
              description: "denied",
            }),
          ),
      }),
    ),
    Effect.provide(NodeServices.layer),
  ),
);

it.effect("selects only completed agent versions inside the managed tool directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped();
    const toolRoot = path.join(base, "tools", "agent-device");
    const escaped = "../foreign";
    const previous = "0.20.0";
    const entries = new Map<string, string>();
    for (const [version, completed] of [
      [escaped, true],
      [previous, true],
      ["0.20.1", false],
      [AGENT_DEVICE_VERSION, true],
    ] as const) {
      const dir = path.join(toolRoot, version);
      const bin = path.join(dir, "node_modules", "agent-device", "bin");
      yield* fs.makeDirectory(bin, { recursive: true });
      const entry = path.join(bin, "agent-device.mjs");
      yield* fs.writeFileString(entry, "");
      if (completed) yield* fs.writeFileString(path.join(dir, ".install-complete"), version);
      entries.set(version, entry);
    }

    expect(yield* installedAgentDeviceEntry(base, [escaped])).toBeNull();
    expect(yield* installedAgentDeviceEntry(base, [previous, AGENT_DEVICE_VERSION])).toBe(
      entries.get(previous),
    );
    expect(yield* installedAgentDeviceEntry(base, ["0.20.1", AGENT_DEVICE_VERSION])).toBe(
      entries.get(AGENT_DEVICE_VERSION),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
