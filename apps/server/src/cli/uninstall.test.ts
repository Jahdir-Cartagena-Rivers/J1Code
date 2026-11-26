import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Terminal from "effect/Terminal";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import * as HostProcess from "@j1code/shared/HostProcess";
import * as NetService from "@j1code/shared/Net";
import { afterEach, vi } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import { posixLauncherScript } from "../cloud/pinnedRuntime.ts";
import {
  findOwnedLauncher,
  findRecordedLaunchers,
  spawnWindowsRemoval,
  uninstallCommand,
} from "./uninstall.ts";

afterEach(() => vi.restoreAllMocks());

const withTerminalFlag = (isTTY: boolean) => Effect.acquireRelease(
  Effect.sync(() =>
    [process.stdin, process.stdout].map((stream) => {
      const descriptor = Object.getOwnPropertyDescriptor(stream, "isTTY");
      Object.defineProperty(stream, "isTTY", { configurable: true, value: isTTY });
      return { stream, descriptor };
    }),
  ),
  (saved) =>
    Effect.sync(() => {
      for (const { stream, descriptor } of saved) {
        if (descriptor === undefined) Reflect.deleteProperty(stream, "isTTY");
        else Object.defineProperty(stream, "isTTY", descriptor);
      }
    }),
);

const answering = (text: string) =>
  Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    size: Queue.unbounded<Terminal.Size, Cause.Done>(),
    readInput: Effect.gen(function* () {
      const input = yield* Queue.unbounded<Terminal.UserInput, Cause.Done>();
      yield* Queue.offer(input, {
        input: Option.some(text),
        key: { name: text, ctrl: false, meta: false, shift: false },
      });
      return input;
    }),
    readLine: Effect.succeed(text),
    display: () => Effect.void,
  });

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))("j1 uninstall command", (it) => {
  it.effect.each([
    { scenario: "declined", tty: true, yes: false, answer: "n", removed: false },
    { scenario: "non-interactive", tty: false, yes: false, answer: "n", removed: false },
    { scenario: "owner changed", tty: true, yes: false, answer: "y", removed: false },
    { scenario: "owned home", tty: true, yes: false, answer: "y", removed: true },
    { scenario: "explicit --yes", tty: false, yes: true, answer: "n", removed: true },
  ] as const)("handles uninstall for $scenario", ({ scenario, tty, yes, answer, removed }) =>
    Effect.gen(function* () {
      yield* withTerminalFlag(tty);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "j1-uninstall-confirm-" });
      const runtime = path.join(baseDir, "runtime");
      const userdata = path.join(baseDir, "userdata");
      const savedProject = path.join(userdata, "saved-project.txt");
      yield* fs.makeDirectory(runtime);
      yield* fs.makeDirectory(userdata);
      yield* fs.writeFileString(path.join(runtime, "fixture"), "generated runtime");
      yield* fs.writeFileString(savedProject, "keep this");
      let statusReads = 0;
      let uninstalls = 0;
      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.succeed(
          BootService.BootService,
          BootService.BootService.of({
            status: Effect.sync(() => ({
              supported: true,
              installed: true,
              current: true,
              installedBaseDir:
                ++statusReads > 1 && scenario === "owner changed" ? path.join(baseDir, "other") : baseDir,
              unitPath: path.join(baseDir, "fixture.service"),
              logPath: path.join(userdata, "fixture.log"),
            })),
            withStopped: (operation) => operation,
            restart: Effect.die("unexpected restart"),
            install: () => Effect.die("unexpected install"),
            uninstall: Effect.sync(() => {
              uninstalls++;
              return true;
            }),
          }),
        ),
      );
      const [result, lines] = yield* Command.runWith(uninstallCommand, {
        version: packageJson.version,
      })(["--base-dir", baseDir, ...(yes ? ["--yes"] : [])]).pipe(
        Effect.exit,
        Effect.flatMap((result) => Effect.map(TestConsole.logLines, (lines) => [result, lines] as const)),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provideService(HostProcess.IsExecutable, false),
        Effect.provideService(Terminal.Terminal, answering(answer)),
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "3773" } })),
            Layer.fresh(TestConsole.layer),
          ),
        ),
      );
      assert.equal(uninstalls, removed ? 1 : 0);
      assert.equal(yield* fs.exists(runtime), !removed);
      assert.equal(yield* fs.readFileString(savedProject), "keep this");
      if (scenario === "non-interactive" || scenario === "owner changed") {
        if (!Exit.isFailure(result)) return yield* Effect.die("Expected uninstall refusal");
        assert.include(
          Cause.pretty(result.cause),
          scenario === "owner changed" ? "service or runtime changed" : "Not a terminal",
        );
      } else {
        assert.isTrue(Exit.isSuccess(result));
        assert.include(lines.join("\n"), removed ? "Removed the background service." : "Left as is.");
      }
    }),
  );

  it.effect("names another home's service it leaves installed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-uninstall-cli-test-" });
      const uninstalls: Array<true> = [];
      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.succeed(
          BootService.BootService,
          BootService.BootService.of({
            status: Effect.succeed({
              supported: true,
              installed: true,
              current: true,
              installedBaseDir: "/home/me/.t3",
              unitPath: "/home/me/.config/systemd/user/t3code.service",
              logPath: "/home/me/.t3/userdata/logs/boot-service.log",
            }),
            withStopped: (operation) => operation,
            restart: Effect.die("unexpected restart"),
            install: () => Effect.die("unexpected install"),
            uninstall: Effect.sync(() => {
              uninstalls.push(true);
              return true;
            }),
          }),
        ),
      );

      const output = yield* Command.runWith(uninstallCommand, { version: packageJson.version })([
        "--base-dir",
        baseDir,
        "--yes",
      ]).pipe(
        Effect.andThen(TestConsole.logLines),
        Effect.map((lines) => lines.join("\n")),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provideService(HostProcess.IsExecutable, false),
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "3773" } })),
            Layer.fresh(TestConsole.layer),
          ),
        ),
      );
      assert.deepStrictEqual(uninstalls, []);
      assert.include(output, "--base-dir '/home/me/.t3'");
    }),
  );
});

it.layer(NodeServices.layer)("j1 uninstall launcher", (it) => {
  it.effect("claims only a launcher that points into this home's runtime tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // macOS spells the temp folder /var but resolves it to /private/var.
      const root = yield* fs
        .makeTempDirectoryScoped({ prefix: "t3-uninstall-" })
        .pipe(Effect.flatMap(fs.realPath));
      const versionsDir = path.join(root, "runtime/versions");
      const exe = path.join(versionsDir, "1.0.0/t3");
      const otherExe = path.join(root, "other/runtime/versions/1.0.0/t3");
      const copy = path.join(root, "copy/t3");
      for (const file of [exe, otherExe, copy]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      const ours = path.join(root, "bin/t3");
      const theirs = path.join(root, "other/bin/t3");
      yield* fs.makeDirectory(path.dirname(ours), { recursive: true });
      yield* fs.makeDirectory(path.dirname(theirs), { recursive: true });
      yield* fs.symlink(exe, ours);
      yield* fs.symlink(otherExe, theirs);

      assert.equal(yield* findOwnedLauncher({ launchedAs: ours, versionsDir }), ours);
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: theirs, versionsDir }));
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: copy, versionsDir }));
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: undefined, versionsDir }));
      // A script launcher execs by absolute path, so argv0 names the executable.
      const scriptDir = path.join(root, "script-bin");
      const script = path.join(scriptDir, "t3");
      yield* fs.makeDirectory(scriptDir);
      yield* fs.writeFileString(script, posixLauncherScript(exe), { mode: 0o755 });
      assert.equal(
        yield* findOwnedLauncher({ launchedAs: exe, versionsDir }).pipe(
          Effect.provideService(HostProcess.Environment, { PATH: scriptDir }),
        ),
        script,
      );
      const editedScript = path.join(scriptDir, "t3-edited");
      yield* fs.writeFileString(editedScript, `${posixLauncherScript(exe)}# mine\n`);

      // On Windows, only the shim exactly as written is ours; a user's wrapper stays.
      const shimDir = path.join(root, "win-bin");
      const shim = path.join(shimDir, "t3.cmd");
      yield* fs.makeDirectory(shimDir);
      const windowsOwner = (contents: string) =>
        fs
          .writeFileString(shim, contents)
          .pipe(
            Effect.andThen(findOwnedLauncher({ launchedAs: exe, versionsDir })),
            Effect.provideService(HostProcess.Platform, "win32"),
            Effect.provideService(HostProcess.Environment, { PATH: shimDir }),
          );
      assert.equal(yield* windowsOwner(`@echo off\r\n"${exe}" %*`), shim);
      assert.isUndefined(yield* windowsOwner(`@echo off\r\nset FOO=1\r\n"${exe}" %*`));

      // npx can run another version than the installed one, so uninstall also reads the
      // recorded launchers: through a symlinked home, and dangling after a prune.
      const throughAlias = path.join(root, "bin/t3-alias");
      const pruned = path.join(root, "bin/t3-pruned");
      yield* fs.symlink(root, path.join(root, "alias"));
      yield* fs.symlink(path.join(root, "alias/runtime/versions/1.0.0/t3"), throughAlias);
      yield* fs.symlink(path.join(versionsDir, "0.9.0/t3"), pruned);
      // Another program inside a version is not a launcher.
      const sibling = path.join(root, "bin/t3-sibling");
      yield* fs.symlink(path.join(versionsDir, "1.0.0/node"), sibling);
      yield* fs.writeFileString(
        path.join(root, "runtime/launchers"),
        [
          ours,
          theirs,
          copy,
          throughAlias,
          pruned,
          sibling,
          script,
          editedScript,
          path.join(root, "missing"),
        ].join("\n") + "\n",
      );
      for (const dir of [versionsDir, path.join(root, "alias/runtime/versions")]) {
        assert.deepStrictEqual(yield* findRecordedLaunchers(dir), [
          ours,
          throughAlias,
          pruned,
          script,
        ]);
      }

      // On Windows only an unedited t3.cmd is ours; a hand-edited wrapper belongs to the user.
      const cmd = path.join(root, "bin/t3.cmd");
      const edited = path.join(root, "bin/edited.cmd");
      yield* fs.writeFileString(cmd, `@echo off\r\n"${exe}" %*`);
      yield* fs.writeFileString(edited, `@echo off\r\nset "T3CODE_HOME=D:\\other"\r\n"${exe}" %*`);
      yield* fs.writeFileString(path.join(root, "runtime/launchers"), `${cmd}\r\n${edited}\r\n`);
      assert.deepStrictEqual(
        yield* findRecordedLaunchers(versionsDir).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
        ),
        [cmd],
      );
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );
});

it.live.runIf(HostProcess.Platform.defaultValue() === "win32")(
  "j1 uninstall has cmd.exe remove the runtime directory, preserving spaces and literal environment-variable syntax",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-uninstall-" });
      const runtimeDir = path.join(root, "t3 home %COMSPEC% !COMSPEC! & data", "runtime");
      yield* fs.makeDirectory(path.join(runtimeDir, "versions", "1.0.0"), { recursive: true });
      yield* fs.writeFileString(path.join(runtimeDir, "versions", "1.0.0", "t3.exe"), "");

      const child = spawnWindowsRemoval(
        yield* Config.String("ComSpec").pipe(Config.withDefault("cmd.exe")),
        runtimeDir,
      );
      yield* Effect.callback<void, Error>((resume) => {
        child.once("error", (error) => resume(Effect.fail(error)));
        child.once("exit", (code) =>
          resume(code === 0 ? Effect.void : Effect.die(`cmd.exe exited with ${code}`)),
        );
      });

      assert.isFalse(yield* fs.exists(runtimeDir));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
