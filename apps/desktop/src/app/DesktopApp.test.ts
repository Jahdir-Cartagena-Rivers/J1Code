import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import { ChildProcessSpawner } from "effect/process";
import * as NetService from "@j1code/shared/Net";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));
vi.mock("@clerk/electron", () => ({ createClerkBridge: vi.fn() }));
vi.mock("@clerk/electron/storage", () => ({ storage: vi.fn() }));
vi.mock("../ipc/DesktopIpcHandlers.ts", () => ({
  installDesktopIpcHandlers: () => Effect.void,
}));
vi.mock("../updates/DesktopRemoteUpdates.ts", () => ({ listen: Effect.void }));
vi.mock("./DesktopStartupRecovery.ts", () => ({ listen: Effect.void }));
const ownership = vi.hoisted(() => ({ pid: 0, released: true, waits: 0 }));
vi.mock("../backend/DesktopHomeOwner.ts", () => ({
  awaitHomeOwnershipRelease: () => Effect.sync(() => { ownership.waits++; return ownership.released; }),
  readLiveHomeOwner: () => Effect.sync(() => ownership.pid ? Option.some({ pid: ownership.pid, port: 4888 }) : Option.none()),
  homeOwnedMessage: () => "Another server owns the isolated test home",
}));


import * as DesktopApp from "./DesktopApp.ts";
import * as DesktopTray from "./DesktopTray.ts";
import * as Background from "../backend/DesktopBackgroundBackend.ts";
import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopLinuxUrlHandler from "./DesktopLinuxUrlHandler.ts";
import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as PreviewPasskeys from "../preview/Passkeys.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopSnapShot from "../snapShot/DesktopSnapShot.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopApplicationMenu from "../window/DesktopApplicationMenu.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslBackend from "../wsl/DesktopWslBackend.ts";

import * as BrowserImport from "../preview/BrowserImport/BrowserImport.ts";
import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopCliCommand from "./DesktopCliCommand.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as ElectronTray from "../electron/ElectronTray.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopManagedPolicy from "./DesktopManagedPolicy.ts";
import * as DesktopPrimaryPaste from "./DesktopPrimaryPaste.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "../ssh/DesktopSshPasswordPrompts.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as MacPermissions from "../permissions/MacPermissions.ts";
import * as PreviewManager from "../preview/Manager.ts";

interface OwnershipCase { name: string; stopDefect?: boolean; backgroundPort?: number; ownerPid?: number;
  configuredPort?: number; released?: boolean; reject?: boolean; wslOnly?: boolean; expectedPort?: number; }
const ownershipCases: ReadonlyArray<OwnershipCase> = [
  { name: "normal", configuredPort: 3773 },
  { name: "stop defect", configuredPort: 3773, stopDefect: true },
  { name: "matching authenticated background", backgroundPort: 4888, ownerPid: 123, released: false, expectedPort: 4888 },
  { name: "explicit changed port", backgroundPort: 4888, ownerPid: 123, released: false, configuredPort: 6000, expectedPort: 6000 },
  { name: "mismatched background owner", backgroundPort: 4888, ownerPid: 456, released: false, reject: true },
  { name: "missing recorded owner", backgroundPort: 4888, released: false, reject: true },
  { name: "foreign home owner", ownerPid: 456, released: false, reject: true },
  { name: "invalid background port", backgroundPort: 0, ownerPid: 123, released: false, expectedPort: 3773 },
  { name: "Windows background with persisted WSL", backgroundPort: 4888, ownerPid: 123, released: false, wslOnly: true, expectedPort: 4888 },
  { name: "foreign Windows owner with persisted WSL", backgroundPort: 4888, ownerPid: 456, released: false, wslOnly: true, reject: true },
];
it.effect.each(ownershipCases)(
  "preserves ownership/startup/shutdown ordering for $name",
  (row) =>
    Effect.gen(function* () {
      const stopDefect = row.stopDefect ?? false;
      ownership.pid = row.ownerPid ?? 0; ownership.released = row.released ?? true; ownership.waits = 0;
      const backgroundRead = yield* Effect.acquireRelease(Effect.sync(() =>
        vi.spyOn(Background, "readBackgroundRecord").mockResolvedValue(row.backgroundPort === undefined ? undefined : {
          protocol: 1, hostPid: 122, serverPid: 123, version: "test", executablePath: "/test/J1.exe", entryPath: "/test/server.mjs",
          bootstrap: { mode: "desktop", noBrowser: true, port: row.backgroundPort, t3Home: "/isolated", host: "127.0.0.1", desktopBootstrapToken: "fixture", tailscaleServeEnabled: false, tailscaleServePort: 443 }, secret: "a".repeat(64),
        })), (mock) => Effect.sync(() => mock.mockRestore()));
      const hostStop = yield* Effect.acquireRelease(Effect.sync(() => vi.spyOn(Background, "stopBackgroundServer").mockResolvedValue(undefined)),
        (mock) => Effect.sync(() => mock.mockRestore()));
      const decided = yield* Deferred.make<void>();
      const selectedPorts: number[] = [];
      const scanned: number[] = [];
      const registrationStarted = yield* Deferred.make<void>();
      const releaseRegistration = yield* Deferred.make<void>();
      const registrationStopped = yield* Deferred.make<void>();
      const windowStarted = yield* Deferred.make<void>();
      const firstStopStarted = yield* Deferred.make<void>();
      const secondStopStarted = yield* Deferred.make<void>();
      const releaseStops = yield* Deferred.make<void>();
      const historyStarted = yield* Deferred.make<void>();
      const releaseHistory = yield* Deferred.make<void>();
      const quitting = yield* Ref.make(false);
      const tokenRequested = yield* Deferred.make<void>();
      const events: string[] = [];
      const record = (event: string) =>
        Effect.sync(() => {
          events.push(event);
        });
      const runApp = DesktopApp.program
        .pipe(
          Effect.provide(NodeCrypto.layer),
          Effect.provideService(DesktopAppIdentity.DesktopAppIdentity, {
            resolveUserDataPath: Effect.succeed("/isolated/userdata"),
            configure: record("identity"),
          } as DesktopAppIdentity.DesktopAppIdentity["Service"]),
          Effect.provideService(ElectronApp.ElectronApp, {
            setPath: () => Effect.void,
            whenReady: record("ready"),
            quit: Effect.void,
          } as unknown as ElectronApp.ElectronApp["Service"]),
          Effect.provideService(ElectronDialog.ElectronDialog, {
            showErrorBox: () => row.reject ? record("rejected").pipe(Effect.andThen(Deferred.succeed(decided, undefined)), Effect.asVoid) : Effect.die("unexpected fatal startup error"),
          } as unknown as ElectronDialog.ElectronDialog["Service"]),
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
            platform: row.backgroundPort === undefined ? "linux" : "win32",
            baseDir: "/isolated",
            isDevelopment: false,
            isPackaged: true,
            stateDir: "/isolated/userdata",
            configuredBackendPort: Option.fromUndefinedOr(row.configuredPort),
            defaultDesktopSettings: { serverExposureMode: "local-only" },
          } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
          Effect.provideService(DesktopPreReadyPlatform.DesktopPreReadyElectronOptions, {
            linux: null,
            linuxPasswordStoreCommandLine: "basic",
          }),
          Effect.provideService(DesktopShellEnvironment.DesktopShellEnvironment, {
            installIntoProcess: Effect.succeed(true),
            awaitDiscovery: Effect.succeed(true),
            awaitUserShellDiscovery: Effect.succeed(true),
            updates: Stream.empty,
          }),
          Effect.provideService(DesktopAppSettings.DesktopAppSettings, {
            load: Effect.void,
            get: Effect.succeed({
              localEnvironmentEnabled: true,
              wslOnly: row.wslOnly ?? false, wslBackendEnabled: row.wslOnly ?? false,
              serverExposureMode: "local-only",
            }),
          } as unknown as DesktopAppSettings.DesktopAppSettings["Service"]),
          Effect.provideService(DesktopLifecycle.DesktopLifecycle, {
            register: Effect.void,
            relaunch: () => Effect.void,
          }),
          Effect.provideService(DesktopClerk.DesktopClerk, {
            configure: Effect.void,
          } as DesktopClerk.DesktopClerk["Service"]),
          Effect.provideService(ElectronSafeStorage.ElectronSafeStorage, {
            selectedStorageBackend: Effect.succeedNone,
          } as unknown as ElectronSafeStorage.ElectronSafeStorage["Service"]),
          Effect.provideService(PreviewPasskeys.PreviewPasskeys, {
            configure: Effect.void,
          } as PreviewPasskeys.PreviewPasskeys["Service"]),
          Effect.provideService(DesktopApplicationMenu.DesktopApplicationMenu, {
            configure: record("menu"),
          }),
          Effect.provide(Layer.mock(DesktopTray.DesktopTray)({ configure: record("tray") })),
          Effect.provideService(DesktopUpdates.DesktopUpdates, {
            configure: record("updates"),
          } as unknown as DesktopUpdates.DesktopUpdates["Service"]),
          Effect.provideService(DesktopLinuxUrlHandler.DesktopLinuxUrlHandler, {
            register: Deferred.succeed(registrationStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseRegistration)),
              Effect.ensuring(Deferred.succeed(registrationStopped, undefined)),
            ),
          }),
        )
        .pipe(
          Effect.provideService(ElectronProtocol.ElectronProtocol, {
            registerDesktopProtocol: () => Effect.void,
          } as unknown as ElectronProtocol.ElectronProtocol["Service"]),
          Effect.provideService(DesktopLegacyLocalStorage.DesktopLegacyLocalStorage, {
            load: () => Effect.void,
          } as unknown as DesktopLegacyLocalStorage.DesktopLegacyLocalStorage["Service"]),
          Effect.provideService(DesktopSnapShot.DesktopSnapShot, {
            initialize: Effect.void,
          } as DesktopSnapShot.DesktopSnapShot["Service"]),
          Effect.provideService(DesktopState.DesktopState, {
            quitting,
          } as DesktopState.DesktopState["Service"]),
          Effect.provideService(DesktopWindow.DesktopWindow, {
            showConnectingSplash: record("splash"),
            ensureMain: record("window").pipe(
              Effect.andThen(Deferred.succeed(windowStarted, undefined)),
            ),
          } as unknown as DesktopWindow.DesktopWindow["Service"]),
          Effect.provideService(DesktopBackendPool.DesktopBackendPool, {
            primary: Effect.succeed({
              start: record("backend").pipe(Effect.andThen(Deferred.succeed(decided, undefined)), Effect.asVoid),
              currentConfig: Effect.succeedSome({ preflightFailure: Option.none() }),
            }),
            list: Effect.succeed(row.reject ? [] : [
              {
                stop: () =>
                  Deferred.succeed(firstStopStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseStops)),
                    Effect.andThen(stopDefect ? Effect.die("stop defect") : Effect.void),
                  ),
              },
              {
                stop: () =>
                  Deferred.succeed(secondStopStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseStops)),
                  ),
              },
            ]),
          } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]),
          Effect.provideService(DesktopServerExposure.DesktopServerExposure, {
            configureFromSettings: ({ port }: { readonly port: number }) => Effect.sync(() => { selectedPorts.push(port); return { mode: "local-only" }; }),
            backendConfig: Effect.succeed({ httpBaseUrl: new URL("http://127.0.0.1:3773") }),
          } as unknown as DesktopServerExposure.DesktopServerExposure["Service"]),
          Effect.provideService(DesktopWslBackend.DesktopWslBackend, {
            reconcile: Effect.void,
          } as DesktopWslBackend.DesktopWslBackend["Service"]),
          Effect.provideService(DesktopAppActivation.DesktopAppActivation, {
            start: Effect.void,
          } as unknown as DesktopAppActivation.DesktopAppActivation["Service"]),
          Effect.provideService(DesktopRendererHistory.DesktopRendererHistory, {
            shutdown: Deferred.succeed(historyStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseHistory)),
              Effect.asVoid,
            ),
          } as DesktopRendererHistory.DesktopRendererHistory["Service"]),
        );
      const app = yield* runApp.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(BrowserImport.BrowserImport, {}),
            Layer.mock(DesktopAssets.DesktopAssets)({}),
            Layer.mock(ElectronTray.ElectronTray)({}),
            Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {}),
            Layer.mock(DesktopBackendConfiguration.DesktopBackendConfiguration, {}),
            Layer.mock(DesktopCliCommand.DesktopCliCommand, {}),
            Layer.mock(DesktopClientSettings.DesktopClientSettings, {}),
            Layer.mock(DesktopConnectionCatalogStore.DesktopConnectionCatalogStore, {}),
            Layer.mock(DesktopIpc.DesktopIpc, {}),
            Layer.mock(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth, {
              getBearerToken: record("token").pipe(
                Effect.andThen(Deferred.succeed(tokenRequested, undefined)),
                Effect.as("token"),
              ),
            }),
            Layer.mock(DesktopManagedPolicy.DesktopManagedPolicy, {}),
            Layer.succeed(DesktopPrimaryPaste.DesktopPrimaryPaste, { enabled: true }),
            Layer.mock(DesktopSshEnvironment.DesktopSshEnvironment, {}),
            Layer.mock(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {}),
            Layer.mock(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {}),
            Layer.mock(DesktopWebLinks.DesktopWebLinks, {}),
            Layer.mock(DesktopWslEnvironment.DesktopWslEnvironment, {}),
            Layer.mock(ElectronMenu.ElectronMenu, {}),
            Layer.mock(ElectronShell.ElectronShell, {}),
            Layer.mock(ElectronTheme.ElectronTheme, {}),
            Layer.mock(ElectronWindow.ElectronWindow, {}),
            Layer.mock(MacPermissions.MacPermissions, {}),
            Layer.mock(PreviewManager.PreviewManager, {
              isBrowserPartition: () => {
                throw new Error("unexpected browser partition lookup");
              },
            }),
            FileSystem.layerNoop({}),
            Layer.mock(NetService.NetService, { canListenOnHost: (port) => Effect.sync(() => { scanned.push(port); return true; }) }),
            Path.layer,
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("unexpected HTTP request")),
            ),
          ),
        ),
        Effect.forkScoped,
      );
      yield* Effect.raceFirst(Deferred.await(decided), Fiber.join(app));
      assert.equal(hostStop.mock.calls.length, 0);
      if (row.reject) {
        assert.notInclude(events, "backend"); assert.deepEqual(selectedPorts, []);
        assert.deepEqual(scanned, []);
        assert.equal(ownership.waits, 1);
        const shutdown = yield* DesktopShutdown.DesktopShutdown;
        yield* shutdown.request;
        yield* Deferred.await(historyStarted);
        assert.isFalse(yield* Deferred.isDone(firstStopStarted));
        assert.isFalse(yield* Deferred.isDone(secondStopStarted));
        yield* Deferred.succeed(releaseHistory, undefined);
        yield* Fiber.await(app);
        assert.equal(hostStop.mock.calls.length, 0);
        return;
      }
      yield* Effect.raceFirst(
        Effect.all([
          Deferred.await(registrationStarted),
          Deferred.await(windowStarted),
          Deferred.await(tokenRequested),
        ]),
        Fiber.join(app),
      );
      // The backend spawns before menus, and its token is minted without waiting for the renderer.
      assert.deepEqual(
        events.filter((event) => event !== "token"),
        [
          "identity", "ready", "identity", "tray", "updates",
          ...(row.wslOnly ? ["splash"] : []),
          "backend", "menu", "window",
        ],
      );
      assert.isAbove(events.indexOf("token"), events.indexOf("backend"));
      assert.deepEqual(selectedPorts, [row.expectedPort ?? row.configuredPort ?? 3773]);
      assert.equal(scanned.length > 0, row.name === "invalid background port");
      if (row.backgroundPort !== undefined) assert.equal(backgroundRead.mock.calls.length, 1);
      assert.isFalse(yield* Deferred.isDone(registrationStopped));
      const shutdown = yield* DesktopShutdown.DesktopShutdown;
      yield* shutdown.request;
      yield* Deferred.await(firstStopStarted);
      yield* Deferred.await(secondStopStarted);
      assert.isFalse(yield* Deferred.isDone(historyStarted));
      assert.isFalse(yield* shutdown.isComplete);
      yield* Deferred.succeed(releaseStops, undefined);
      yield* Deferred.await(historyStarted);
      assert.isFalse(yield* shutdown.isComplete);
      yield* Deferred.succeed(releaseHistory, undefined);
      const result = yield* Fiber.await(app);
      assert.equal(Exit.isFailure(result), stopDefect);
      assert.isTrue(yield* shutdown.isComplete);
      assert.isTrue(yield* Deferred.isDone(registrationStopped));
      assert.equal(hostStop.mock.calls.length, 0);
    }).pipe(Effect.provide(DesktopShutdown.layer)),
);
