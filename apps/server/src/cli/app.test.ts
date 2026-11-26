// @effect-diagnostics nodeBuiltinImport:off -- The integration fixture binds the same platform socket or named pipe as the CLI.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { DesktopAppActivationRequest } from "@j1code/contracts";
import { resolveDesktopAppControlAddress } from "@j1code/shared/desktopAppControl";
import * as HostProcess from "@j1code/shared/HostProcess";
import * as NetService from "@j1code/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { describe, expect, vi } from "vite-plus/test";

import { makeCli } from "../binCli.ts";
import { PersistedServerRuntimeState } from "../serverRuntimeState.ts";

vi.mock("../server.ts", () => ({
  runServer: Effect.die(new Error("Unexpected server startup in app CLI tests")),
}));

const encodeRuntimeState = Schema.encodeEffect(Schema.fromJsonString(PersistedServerRuntimeState));

// Node reads this variable itself, so the test must set the real process environment.
const setProcessEnv = (name: string, value: string) => {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
};

const runCli = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Command.runWith(makeCli(), { version: "0.0.0" })(args).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        NetService.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
      ),
    ),
  );

const pathExists = (path: string) =>
  Effect.promise(() =>
    NodeFSP.stat(path).then(
      () => true,
      () => false,
    ),
  );

async function startFakeDesktop(input: {
  readonly baseDir: string;
  readonly stateSubdirectory?: "userdata" | "dev";
  readonly platform: NodeJS.Platform;
  readonly userId: number | undefined;
  readonly reply?: (request: DesktopAppActivationRequest) => unknown;
}) {
  const target = resolveDesktopAppControlAddress({
    stateDir: NodePath.join(input.baseDir, input.stateSubdirectory ?? "userdata"),
    platform: input.platform,
    tempDir: NodeOS.tmpdir(),
    userId: input.userId,
    joinPath: NodePath.join,
  });
  if (target.directory !== null) {
    await NodeFSP.mkdir(target.directory, { recursive: true, mode: 0o700 });
    await NodeFSP.unlink(target.address).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  const received: DesktopAppActivationRequest[] = [];
  const server = NodeNet.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as DesktopAppActivationRequest;
      received.push(request);
      const response = input.reply
        ? input.reply(request)
        : {
            version: 1,
            requestId: request.requestId,
            ok: true,
            projectId: "project-1",
            threadId: `thread-${received.length}`,
          };
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(target.address, resolve);
  });

  return {
    directory: target.directory,
    received,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (target.directory !== null) {
        await NodeFSP.unlink(target.address).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    },
  };
}

const fakeDesktop = Effect.fn(function* (
  input: Omit<Parameters<typeof startFakeDesktop>[0], "platform" | "userId">,
) {
  const platform = yield* HostProcess.Platform;
  const userId = yield* HostProcess.UserId;
  return yield* Effect.acquireRelease(
    Effect.promise(() => startFakeDesktop({ ...input, platform, userId })),
    (server) => Effect.promise(() => server.close()),
  );
});

const withTempDirectory = <A, E, R>(
  prefix: string,
  use: (root: string) => Effect.Effect<A, E, R>,
  tempDir = NodeOS.tmpdir(),
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(tempDir, prefix))),
    use,
    (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
  );

const withDesktopFixture = <A, E, R>(
  prefix: string,
  use: (root: string) => Effect.Effect<A, E, R>,
) =>
  withTempDirectory(
    prefix,
    (root) =>
      Effect.gen(function* () {
        if (process.platform !== "win32") {
          yield* Effect.acquireRelease(
            Effect.sync(() => setProcessEnv("TMPDIR", root)),
            (restore) => Effect.sync(restore),
          );
        }
        return yield* use(root);
      }).pipe(Effect.scoped),
    process.platform === "win32" ? NodeOS.tmpdir() : "/tmp",
  );

describe("j1 server command safety", () => {
  it.effect("rejects unknown command words without creating a home or project", () =>
    withTempDirectory("t3-cli-unknown-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "home");
        for (const word of [
          "account",
          "login",
          "clients",
          "conenct",
          "package.json",
          "C:new-project",
        ]) {
          const error = yield* runCli([word, "--base-dir", baseDir]).pipe(
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.flip,
          );
          expect(String(error)).toContain(`Unknown command "${word}"`);
          expect(yield* pathExists(word)).toBe(word === "package.json");
          expect(yield* pathExists(baseDir)).toBe(false);
        }
      }),
    ),
  );

  it.effect("does not offer auto-bootstrap in serve help, since serve never bootstraps", () =>
    Effect.gen(function* () {
      yield* runCli(["serve", "--help"]);
      const help = (yield* TestConsole.logLines).join("\n");
      expect(help).toContain("--no-browser");
      expect(help).not.toContain("--auto-bootstrap-project-from-cwd");
    }).pipe(Effect.provide(Layer.fresh(TestConsole.layer))),
  );

  it.effect("refuses manual startup over a live server before creating directories", () =>
    withTempDirectory("t3-cli-running-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "home");
        const stateDir = NodePath.join(baseDir, "userdata");
        const statePath = NodePath.join(stateDir, "server-runtime.json");
        const pid = process.pid + 1;
        const probe = yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi.spyOn(process, "kill").mockImplementation((target, signal) => {
              expect(target).toBe(pid);
              expect(signal).toBe(0);
              return true;
            }),
          ),
          (mock) => Effect.sync(() => mock.mockRestore()),
        );
        const record = yield* encodeRuntimeState({
          version: 1,
          pid,
          port: 3773,
          origin: "http://127.0.0.1:3773",
          startedAt: "2026-10-01T00:00:00.000Z",
          serviceManaged: true,
        });
        yield* Effect.promise(() => NodeFSP.mkdir(stateDir, { recursive: true }));
        yield* Effect.promise(() => NodeFSP.writeFile(statePath, record));
        const newDirectory = NodePath.join(root, "new-project");
        const platform = yield* HostProcess.Platform;
        const startupArgs = [
          [],
          ["start"],
          ["."],
          ["node_modules"],
          ["C:new-project"],
          [newDirectory],
          ["start", newDirectory],
        ];
        for (const args of startupArgs) {
          const error = yield* runCli(args, { T3CODE_HOME: baseDir }).pipe(
            Effect.provideService(
              HostProcess.Platform,
              args[0] === "C:new-project" ? "win32" : platform,
            ),
            Effect.flip,
          );
          expect(String(error)).toContain("A J1 Code server is already running");
          expect(yield* Effect.promise(() => NodeFSP.readFile(statePath, "utf8"))).toBe(record);
          expect(yield* pathExists(newDirectory)).toBe(false);
          expect(yield* Effect.promise(() => NodeFSP.readdir(stateDir))).toEqual([
            "server-runtime.json",
          ]);
        }
        expect(probe).toHaveBeenCalledTimes(startupArgs.length);
      }).pipe(Effect.scoped),
    ),
  );
});

describe("j1 app", () => {
  it.effect.each(["SSH_CONNECTION", "SSH_TTY"] as const)(
    "rejects %s before it tries to reach a desktop app",
    (variable) =>
      withDesktopFixture("j1-app-ssh-test-", (root) =>
        Effect.gen(function* () {
          const baseDir = NodePath.join(root, "missing-j1-home");
          const error = yield* runCli(["app", "--base-dir", baseDir], {
            [variable]: "synthetic SSH session",
          }).pipe(Effect.flip);

          expect(error).toMatchObject({
            _tag: "DesktopAppSshUnsupportedError",
            message:
              "`j1 app` only controls a desktop app on the same machine. It cannot run over SSH.",
          });
          expect(yield* pathExists(baseDir)).toBe(false);
        }),
      ),
  );

  it.effect("rejects unsupported platforms without creating state", () =>
    withDesktopFixture("j1-app-platform-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "missing-j1-home");
        const error = yield* runCli(["app", "--base-dir", baseDir]).pipe(
          Effect.provideService(HostProcess.Platform, "freebsd"),
          Effect.flip,
        );

        expect(error).toMatchObject({
          _tag: "DesktopAppPlatformUnsupportedError",
          platform: "freebsd",
          message: "`j1 app` is not supported on freebsd.",
        });
        expect(yield* pathExists(baseDir)).toBe(false);
      }),
    ),
  );

  it.effect("does not create state when only a server or no desktop app is running", () =>
    withDesktopFixture("j1-app-missing-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "missing-j1-home");
        const error = yield* runCli(["app", "--base-dir", baseDir]).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "DesktopAppUnreachableError",
          candidateAddresses: [expect.any(String)],
          workspaceRoot: yield* HostProcess.WorkingDirectory,
          message: expect.stringContaining("Could not reach the J1 Code desktop app."),
          cause: { code: "ENOENT" },
        });
        expect(yield* pathExists(baseDir)).toBe(false);
      }),
    ),
  );

  it.live.each(["permissions", "owner", "symlink", "missing owner"] as const)(
    "rejects unsafe %s on the socket directory before sending",
    (unsafe) =>
      withDesktopFixture("j1-app-unsafe-", (root) =>
        Effect.gen(function* () {
          const platform = yield* HostProcess.Platform;
          if (platform === "win32") return;
          const baseDir = NodePath.join(root, ".j1");
          const userId = yield* HostProcess.UserId;
          assert(userId !== undefined);
          const expectedUserId =
            unsafe === "missing owner" ? undefined : unsafe === "owner" ? userId + 1 : userId;
          const desktop = yield* fakeDesktop({ baseDir }).pipe(
            Effect.provideService(HostProcess.UserId, expectedUserId),
          );
          const directory = desktop.directory;
          assert(directory !== null);
          if (unsafe === "permissions") {
            yield* Effect.promise(() => NodeFSP.chmod(directory, 0o755));
          } else if (unsafe === "symlink") {
            const moved = NodePath.join(root, "moved");
            yield* Effect.promise(() => NodeFSP.rename(directory, moved));
            yield* Effect.promise(() => NodeFSP.symlink(moved, directory));
          }
          const error = yield* runCli(["app"]).pipe(
            Effect.provideService(HostProcess.HomeDirectory, root),
            Effect.provideService(HostProcess.UserId, expectedUserId),
            Effect.flip,
          );
          expect(desktop.received).toEqual([]);
          expect(error).toMatchObject({
            _tag: "DesktopAppUnreachableError",
            cause: {
              message: "The desktop app socket directory is not private or owned by this user.",
            },
          });
          expect(yield* pathExists(baseDir)).toBe(false);
        }),
      ),
  );

  it.effect("uses T3CODE_HOME or --base-dir and sends the default or explicit path", () =>
    withDesktopFixture("j1-app-command-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "selected-home");
        const explicitPath = NodePath.join(root, "project");
        const platform = yield* HostProcess.Platform;
        const workingDirectory = yield* HostProcess.WorkingDirectory;
        const desktop = yield* fakeDesktop({ baseDir });

        yield* runCli(["app"], { T3CODE_HOME: baseDir });
        const otherHome = NodePath.join(root, "unchosen-home");
        yield* runCli(["app", explicitPath, "--base-dir", baseDir], { T3CODE_HOME: otherHome });
        expect(yield* pathExists(otherHome)).toBe(false);

        expect(desktop.received.map((request) => request.workspaceRoot)).toEqual([
          workingDirectory,
          explicitPath,
        ]);
        expect(desktop.received.every((request) => request.platform === platform)).toBe(true);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("prefers the installed desktop app when a dev desktop is also running", () =>
    withDesktopFixture("j1-app-preferred-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, ".j1");
        const desktop = yield* fakeDesktop({ baseDir });
        const development = yield* fakeDesktop({ baseDir, stateSubdirectory: "dev" });

        yield* runCli(["app"]);

        expect(desktop.received).toHaveLength(1);
        expect(development.received).toHaveLength(0);
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, root), Effect.scoped),
    ),
  );

  it.effect("finds the dev desktop when the default desktop socket is absent", () =>
    withDesktopFixture("j1-app-dev-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, ".j1");
        const development = yield* fakeDesktop({ baseDir, stateSubdirectory: "dev" });

        yield* runCli(["app"]);
        yield* runCli(["app"], { T3CODE_HOME: "   " });

        expect(development.received).toHaveLength(2);
        expect(yield* pathExists(baseDir)).toBe(false);
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, root), Effect.scoped),
    ),
  );

  it.effect("never searches a dev state directory for an explicit J1 Code home", () =>
    withDesktopFixture("j1-app-explicit-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, ".j1");
        const development = yield* fakeDesktop({ baseDir, stateSubdirectory: "dev" });

        const flagError = yield* runCli(["app", "--base-dir", baseDir]).pipe(Effect.flip);
        const envError = yield* runCli(["app"], { T3CODE_HOME: baseDir }).pipe(Effect.flip);

        expect(flagError).toMatchObject({ _tag: "DesktopAppUnreachableError" });
        expect(envError).toMatchObject({ _tag: "DesktopAppUnreachableError" });
        expect(development.received).toHaveLength(0);
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, root), Effect.scoped),
    ),
  );

  it.effect.each(["failure", "invalid"] as const)(
    "never falls back after the default desktop sends a %s response",
    (responseKind) =>
      withDesktopFixture("j1-app-response-test-", (root) =>
        Effect.gen(function* () {
          const baseDir = NodePath.join(root, ".j1");
          const desktop = yield* fakeDesktop({
            baseDir,
            reply: (request) =>
              responseKind === "failure"
                ? {
                    version: 1,
                    requestId: request.requestId,
                    ok: false,
                    code: "project-create-failed",
                    message: "The project path is not available.",
                  }
                : { invalid: true },
          });
          const development = yield* fakeDesktop({ baseDir, stateSubdirectory: "dev" });

          const error = yield* runCli(["app"]).pipe(Effect.flip);

          expect(desktop.received).toHaveLength(1);
          expect(development.received).toHaveLength(0);
          if (responseKind === "failure") {
            expect(error).toMatchObject({
              _tag: "DesktopAppRequestFailedError",
              code: "project-create-failed",
              requestId: desktop.received[0]?.requestId,
              workspaceRoot: yield* HostProcess.WorkingDirectory,
              message: expect.stringContaining("project-create-failed"),
              cause: {
                ok: false,
                code: "project-create-failed",
                message: "The project path is not available.",
              },
            });
          } else {
            expect(error).toMatchObject({
              _tag: "DesktopAppUnreachableError",
              cause: { message: "The desktop app response is invalid." },
            });
          }
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, root), Effect.scoped),
      ),
  );
});
