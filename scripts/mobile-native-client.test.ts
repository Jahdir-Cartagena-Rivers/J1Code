import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@j1code/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  androidSdk,
  buildRunTitle,
  installNativeClient,
  nativeClientBuildRepository,
  nativeClientCacheEndpoint,
  NativeClientError,
  prebuildAndroid,
  remoteBuildState,
} from "./mobile-native-client.ts";

const caches = [".gradle/history", "app/.cxx/object"];

it("uses a shared cache only when a J1 endpoint is configured", () => {
  const endpoint = "https://cache.example/projects/j1code";
  assert.isNull(nativeClientCacheEndpoint({}));
  assert.strictEqual(
    nativeClientCacheEndpoint({ T3_NATIVE_CLIENT_CACHE_ENDPOINT: ` ${endpoint}/ ` }),
    endpoint,
  );
  assert.strictEqual(
    nativeClientCacheEndpoint({
      T3_NATIVE_CLIENT_CACHE_ENDPOINT: endpoint,
      T3_NATIVE_CLIENT_CACHE: "read",
    }),
    endpoint,
  );
  assert.isNull(
    nativeClientCacheEndpoint({
      T3_NATIVE_CLIENT_CACHE_ENDPOINT: endpoint,
      T3_NATIVE_CLIENT_CACHE: "off",
    }),
  );
  for (const refused of [
    "https://t3-task-cache.pinglabs.workers.dev/projects/t3code",
    "https://T3-TASK-CACHE.PINGLABS.WORKERS.DEV./projects/t3code",
    "http://cache.example/projects/j1code",
    "https://user:password@cache.example/projects/j1code",
  ]) {
    assert.isNull(nativeClientCacheEndpoint({ T3_NATIVE_CLIENT_CACHE_ENDPOINT: refused }));
  }
});

it("dispatches only to an explicitly configured non-upstream repository outside CI and read-only mode", () => {
  const repository = "Jahdir-Cartagena-Rivers/J1Code";
  const environment = { T3_NATIVE_CLIENT_REPOSITORY: repository };
  assert.isNull(nativeClientBuildRepository({}));
  assert.isNull(nativeClientBuildRepository({ T3_NATIVE_CLIENT_REPOSITORY: "PingDotGG/T3Code" }));
  assert.strictEqual(nativeClientBuildRepository(environment), repository);
  for (const disabled of [
    { GITHUB_ACTIONS: "true" },
    { T3_NATIVE_CLIENT_BUILD: "local" },
    { T3_NATIVE_CLIENT_CACHE: "off" },
    { T3_NATIVE_CLIENT_CACHE: "read" },
  ]) {
    assert.isNull(nativeClientBuildRepository({ ...environment, ...disabled }));
  }
});

it.effect("installs on the chosen iOS simulator, Android emulator, or Android phone", () =>
  Effect.gen(function* () {
    const calls: string[][] = [];
    yield* installNativeClient("ios", "simulator-udid", "J1CodeDev.app", (program, args) => {
      calls.push([program, ...args]);
      return Effect.succeed("");
    });
    yield* installNativeClient("android", "emulator-5556", "app-debug.apk", (program, args) => {
      calls.push([program, ...args]);
      return Effect.succeed(args.includes("ro.kernel.qemu") ? "1" : "");
    });
    yield* installNativeClient("android", "phone-serial", "app-debug.apk", (program, args) => {
      calls.push([program, ...args]);
      return Effect.succeed(args.includes("ro.kernel.qemu") ? "0" : "");
    });
    assert.deepStrictEqual(calls, [
      ["xcrun", "simctl", "install", "simulator-udid", "J1CodeDev.app"],
      ["adb", "-s", "emulator-5556", "install", "-r", "-d", "app-debug.apk"],
      ["adb", "-s", "emulator-5556", "shell", "getprop", "ro.kernel.qemu"],
      ["adb", "-s", "phone-serial", "install", "-r", "-d", "app-debug.apk"],
      ["adb", "-s", "phone-serial", "shell", "getprop", "ro.kernel.qemu"],
      ["adb", "-s", "phone-serial", "reverse", "tcp:8081", "tcp:8081"],
    ]);
  }),
);

it.effect("keeps adb refusal on the selected device and gives the J1 signature recovery command", () =>
  Effect.gen(function* () {
    for (const message of ["device not found", "INSTALL_FAILED_UPDATE_INCOMPATIBLE"]) {
      const failure = new NativeClientError({ message });
      const calls: string[][] = [];
      const error = yield* installNativeClient(
        "android",
        "emulator-5556",
        "app-debug.apk",
        (program, args) => {
          calls.push([program, ...args]);
          return Effect.fail(failure);
        },
      ).pipe(Effect.flip);
      assert.deepStrictEqual(calls, [
        ["adb", "-s", "emulator-5556", "install", "-r", "-d", "app-debug.apk"],
      ]);
      if (message === "device not found") {
        assert.strictEqual(error, failure);
      } else {
        assert.include(error.message, "adb -s emulator-5556 uninstall com.j1code.mobile.dev");
      }
    }
  }),
);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mobile = yield* fs.makeTempDirectoryScoped({ prefix: "mobile-native-client-" });
  const android = path.join(mobile, "android");
  for (const cache of caches) {
    yield* fs.makeDirectory(path.dirname(path.join(android, cache)), { recursive: true });
    yield* fs.writeFileString(path.join(android, cache), cache);
  }
  const cleanPrebuild = Effect.gen(function* () {
    yield* fs.remove(android, { recursive: true });
    yield* fs.makeDirectory(path.join(android, "app"), { recursive: true });
    yield* fs.writeFileString(path.join(android, "app/build.gradle"), "regenerated");
  });
  const assertCachesRestored = Effect.gen(function* () {
    for (const cache of caches) {
      assert.strictEqual(yield* fs.readFileString(path.join(android, cache)), cache);
    }
    assert.deepStrictEqual(yield* fs.readDirectory(mobile), ["android"]);
  });
  return { fs, path, mobile, android, cleanPrebuild, assertCachesRestored };
});

it.layer(NodeServices.layer)("prebuildAndroid", (it) => {
  it.effect("keeps Gradle and native caches through a clean prebuild", () =>
    Effect.gen(function* () {
      const { fs, path, mobile, android, cleanPrebuild, assertCachesRestored } = yield* fixture;

      yield* prebuildAndroid(mobile, cleanPrebuild);

      assert.strictEqual(
        yield* fs.readFileString(path.join(android, "app/build.gradle")),
        "regenerated",
      );
      yield* assertCachesRestored;
    }),
  );

  it.effect("restores the caches and returns the error when prebuild fails", () =>
    Effect.gen(function* () {
      const { mobile, cleanPrebuild, assertCachesRestored } = yield* fixture;
      const failure = new NativeClientError({ message: "prebuild failed" });

      const error = yield* prebuildAndroid(
        mobile,
        cleanPrebuild.pipe(Effect.andThen(Effect.fail(failure))),
      ).pipe(Effect.flip);

      assert.strictEqual(error, failure);
      yield* assertCachesRestored;
    }),
  );
});

it.layer(NodeServices.layer)("androidSdk", (it) => {
  it.effect("skips a configured SDK path that holds no SDK", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "android-sdk-home-" });
      const sdk = path.join(home, "sdk");
      yield* fs.makeDirectory(path.join(sdk, "platform-tools"), { recursive: true });

      const resolved = yield* androidSdk.pipe(
        Effect.provideService(HostProcess.Environment, {
          HOME: home,
          ANDROID_HOME: path.join(home, "stale"),
          ANDROID_SDK_ROOT: sdk,
        }),
      );

      assert.strictEqual(resolved, sdk);
    }),
  );
});

it("finds a Blacksmith build by its run title and reads its state", () => {
  const fingerprint = "a".repeat(40);
  const title = buildRunTitle("android", "x86_64", fingerprint);
  assert.strictEqual(title, `Dev client android x86_64 ${fingerprint}`);
  assert.strictEqual(buildRunTitle("ios", null, fingerprint), `Dev client ios ${fingerprint}`);
  const run = (
    createdAt: string,
    status: string,
    conclusion: string | null,
    displayTitle = title,
  ) => ({
    displayTitle,
    status,
    conclusion,
    createdAt,
  });
  const since = Date.parse("2026-11-09T12:00:00Z");
  assert.strictEqual(remoteBuildState([], title, since), "none");
  // Another client's run, and a run from before this wait, say nothing about this build.
  assert.strictEqual(
    remoteBuildState(
      [
        run(
          "2026-11-09T12:05:00Z",
          "in_progress",
          null,
          buildRunTitle("android", "arm64-v8a", fingerprint),
        ),
        run("2026-11-09T11:00:00Z", "completed", "failure"),
      ],
      title,
      since,
    ),
    "none",
  );
  assert.strictEqual(
    remoteBuildState([run("2026-11-09T12:01:00Z", "queued", null)], title, since),
    "running",
  );
  assert.strictEqual(
    remoteBuildState([run("2026-11-09T12:01:00Z", "completed", "success")], title, since),
    "succeeded",
  );
  // The newest run decides: a retry that is running outranks the failure before it.
  assert.strictEqual(
    remoteBuildState(
      [
        run("2026-11-09T12:01:00Z", "completed", "failure"),
        run("2026-11-09T12:09:00Z", "in_progress", null),
      ],
      title,
      since,
    ),
    "running",
  );
  assert.strictEqual(
    remoteBuildState([run("2026-11-09T12:01:00Z", "completed", "cancelled")], title, since),
    "failed",
  );
});
