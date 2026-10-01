import { assert, describe, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type { DesktopCloseBehavior } from "@t3tools/contracts";
import * as Background from "../backend/DesktopBackgroundBackend.ts";
import * as Pool from "../backend/DesktopBackendPool.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronTray from "../electron/ElectronTray.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopTray from "./DesktopTray.ts";
import * as Settings from "../settings/DesktopAppSettings.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";

afterEach(() => vi.restoreAllMocks());

describe("desktop tray lifecycle", () => {
  for (const scenario of [
    {
      initial: "ask",
      response: 0,
      remember: true,
      closes: 2,
      quits: 0,
      preference: "tray",
      prompts: 1,
    },
    {
      initial: "ask",
      response: 1,
      remember: true,
      closes: 0,
      quits: 1,
      preference: "quit",
      prompts: 1,
    },
    {
      initial: "ask",
      response: 2,
      remember: true,
      closes: 0,
      quits: 0,
      preference: "ask",
      prompts: 1,
    },
    {
      initial: "tray",
      response: 2,
      remember: false,
      closes: 1,
      quits: 0,
      preference: "tray",
      prompts: 0,
    },
    {
      initial: "quit",
      response: 2,
      remember: false,
      closes: 0,
      quits: 1,
      preference: "quit",
      prompts: 0,
    },
  ] as const) {
    it.effect(
      `close choice ${scenario.initial}/${scenario.response} remembers and applies the intended lifecycle`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const preference = yield* Ref.make<DesktopCloseBehavior>(scenario.initial);
            let prompts = 0,
              closes = 0,
              quits = 0;
            vi.spyOn(Background, "readBackgroundRecord").mockResolvedValue(undefined);
            const stop = vi.spyOn(Background, "stopBackgroundServer").mockResolvedValue(undefined);
            const layer = Layer.mergeAll(
              Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
                platform: "win32",
                isPackaged: true,
                baseDir: "C:/test",
              } as DesktopEnvironment.DesktopEnvironment["Service"]),
              Layer.succeed(DesktopAssets.DesktopAssets, {
                iconPaths: Effect.succeed({
                  ico: Option.some("icon.ico"),
                  png: Option.none(),
                  icns: Option.none(),
                }),
              } as DesktopAssets.DesktopAssets["Service"]),
              Layer.succeed(ElectronTray.ElectronTray, {
                create: () => Effect.succeed({ update: () => Effect.void }),
              }),
              Layer.succeed(DesktopWindow.DesktopWindow, {
                activate: Effect.void,
                hideMain: Effect.sync(() => {
                  closes++;
                }),
                flushMainWindowBounds: Effect.void,
              } as unknown as DesktopWindow.DesktopWindow["Service"]),
              Layer.succeed(Pool.DesktopBackendPool, {
                list: Effect.succeed([]),
              } as unknown as Pool.DesktopBackendPool["Service"]),
              Layer.succeed(ElectronApp.ElectronApp, {
                quit: Effect.sync(() => {
                  quits++;
                }),
              } as ElectronApp.ElectronApp["Service"]),
              Layer.succeed(ElectronWindow.ElectronWindow, {
                destroyAll: Effect.sync(() => {
                  closes++;
                }),
              } as ElectronWindow.ElectronWindow["Service"]),
              Layer.succeed(Settings.DesktopAppSettings, {
                get: Ref.get(preference).pipe(
                  Effect.map((closeBehavior) => ({
                    ...Settings.DEFAULT_DESKTOP_SETTINGS,
                    closeBehavior,
                  })),
                ),
                setCloseBehavior: (closeBehavior: DesktopCloseBehavior) =>
                  Ref.set(preference, closeBehavior).pipe(
                    Effect.as({
                      settings: { ...Settings.DEFAULT_DESKTOP_SETTINGS, closeBehavior },
                      changed: true,
                    }),
                  ),
              } as unknown as Settings.DesktopAppSettings["Service"]),
              Layer.succeed(ElectronDialog.ElectronDialog, {
                showMessageBox: () =>
                  Effect.sync(() => {
                    prompts++;
                    return { response: scenario.response, checkboxChecked: scenario.remember };
                  }),
              } as unknown as ElectronDialog.ElectronDialog["Service"]),
            );
            const tray = yield* DesktopTray.make;
            yield* tray.configure.pipe(Effect.provide(layer));
            yield* tray.requestClose;
            if (scenario.closes === 2) yield* tray.requestClose;
            assert.equal(prompts, scenario.prompts);
            assert.equal(closes, scenario.closes);
            assert.equal(quits, scenario.quits);
            assert.equal(stop.mock.calls.length, scenario.quits);
            assert.equal(yield* Ref.get(preference), scenario.preference);
          }),
        ),
    );
  }
  it.effect("stops observers before the host and then allows app exit", () =>
    Effect.gen(function* () {
      const order: string[] = [];
      vi.spyOn(Background, "stopBackgroundServer").mockImplementation(async () => {
        order.push("host");
      });
      const tray = yield* DesktopTray.make;
      yield* tray.stopAndQuit.pipe(
        Effect.provideService(Pool.DesktopBackendPool, {
          list: Effect.succeed([
            {
              stop: () =>
                Effect.sync(() => {
                  order.push("observer");
                }),
            },
          ]),
        } as unknown as Pool.DesktopBackendPool["Service"]),
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
          baseDir: "C:/test",
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
        Effect.provideService(ElectronApp.ElectronApp, {
          quit: Effect.sync(() => {
            order.push("quit");
          }),
        } as ElectronApp.ElectronApp["Service"]),
      );
      assert.deepEqual(order, ["observer", "host", "quit"]);
      assert.isTrue(yield* tray.exitAllowed);
    }),
  );

  for (const confirm of [false, true]) {
    it.effect(
      confirm ? "confirmed tray Stop ends the host" : "cancelled tray Stop preserves the host",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const shown = yield* Deferred.make<void>();
            const quit = yield* Deferred.make<void>();
            const stopped = vi
              .spyOn(Background, "stopBackgroundServer")
              .mockResolvedValue(undefined);
            vi.spyOn(Background, "readBackgroundRecord").mockResolvedValue(undefined);
            let stopClick: (() => void) | undefined;
            const layer = Layer.mergeAll(
              Settings.layerTest(Settings.DEFAULT_DESKTOP_SETTINGS),
              Layer.succeed(ElectronWindow.ElectronWindow, {
                destroyAll: Effect.void,
              } as ElectronWindow.ElectronWindow["Service"]),
              Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
                platform: "win32",
                isPackaged: true,
                baseDir: "C:/test",
              } as DesktopEnvironment.DesktopEnvironment["Service"]),
              Layer.succeed(DesktopAssets.DesktopAssets, {
                iconPaths: Effect.succeed({
                  ico: Option.some("icon.ico"),
                  png: Option.none(),
                  icns: Option.none(),
                }),
              } as DesktopAssets.DesktopAssets["Service"]),
              Layer.succeed(ElectronTray.ElectronTray, {
                create: () =>
                  Effect.succeed({
                    update: (_status, menu) =>
                      Effect.sync(() => {
                        stopClick = menu.find((item) => item.label === "Stop server and quit")!
                          .click as () => void;
                      }),
                  }),
              }),
              Layer.succeed(DesktopWindow.DesktopWindow, {
                activate: Effect.void,
              } as unknown as DesktopWindow.DesktopWindow["Service"]),
              Layer.succeed(Pool.DesktopBackendPool, {
                list: Effect.succeed([]),
              } as unknown as Pool.DesktopBackendPool["Service"]),
              Layer.succeed(ElectronApp.ElectronApp, {
                quit: Deferred.succeed(quit, undefined).pipe(Effect.asVoid),
              } as ElectronApp.ElectronApp["Service"]),
              Layer.succeed(ElectronDialog.ElectronDialog, {
                showMessageBox: () =>
                  Deferred.succeed(shown, undefined).pipe(
                    Effect.as({ response: confirm ? 1 : 0, checkboxChecked: false }),
                  ),
              } as unknown as ElectronDialog.ElectronDialog["Service"]),
            );
            const tray = yield* DesktopTray.make;
            yield* tray.configure.pipe(Effect.provide(layer));
            assert.isTrue(yield* tray.active);
            stopClick!();
            yield* Deferred.await(shown);
            if (confirm) yield* Deferred.await(quit);
            else yield* Effect.yieldNow;
            assert.equal(stopped.mock.calls.length, confirm ? 1 : 0);
            assert.equal(yield* tray.exitAllowed, confirm);
          }),
        ),
    );
  }
});
