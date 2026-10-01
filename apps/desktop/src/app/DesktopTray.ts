import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Background from "../backend/DesktopBackgroundBackend.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronTray from "../electron/ElectronTray.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as Settings from "../settings/DesktopAppSettings.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

type Services =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopBackendPool.DesktopBackendPool
  | DesktopWindow.DesktopWindow
  | ElectronApp.ElectronApp
  | ElectronDialog.ElectronDialog
  | ElectronWindow.ElectronWindow
  | Settings.DesktopAppSettings;

/** @effect-expect-leaking DesktopEnvironment | DesktopBackendPool | DesktopWindow | ElectronApp | ElectronDialog | DesktopAssets | ElectronTray */
export class DesktopTray extends Context.Service<
  DesktopTray,
  {
    readonly active: Effect.Effect<boolean>;
    readonly requestClose: Effect.Effect<void>;
    readonly exitAllowed: Effect.Effect<boolean>;
    readonly allowExit: Effect.Effect<void>;
    readonly stopAndQuit: Effect.Effect<
      void,
      never,
      | DesktopEnvironment.DesktopEnvironment
      | DesktopBackendPool.DesktopBackendPool
      | ElectronApp.ElectronApp
    >;
    readonly configure: Effect.Effect<
      void,
      never,
      Services | DesktopAssets.DesktopAssets | ElectronTray.ElectronTray | Scope.Scope
    >;
  }
>()("@t3tools/desktop/app/DesktopTray") {}

const { logError } = makeComponentLogger("desktop-tray");

export const make = Effect.gen(function* () {
  const active = yield* Ref.make(false);
  const closing = yield* Ref.make(false);
  const closeHandler = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const exitAllowed = yield* Ref.make(false);
  const allowExit = Ref.set(exitAllowed, true);
  const stopAndQuit = Effect.gen(function* () {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const app = yield* ElectronApp.ElectronApp;
    // Stop observers before the host, so the desktop cannot restart a deliberately stopped server.
    yield* Effect.forEach(yield* pool.list, (instance) => instance.stop(), {
      concurrency: "unbounded",
    });
    yield* Effect.promise(() => Background.stopBackgroundServer(environment.baseDir));
    yield* allowExit;
    yield* app.quit;
  }).pipe(
    Effect.catchCause((cause) => logError("Could not stop the J1 background server", { cause })),
  );

  const configure = Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (!Background.backgroundEnabled(environment) || (yield* Ref.get(active))) return;
    const assets = yield* DesktopAssets.DesktopAssets;
    const icons = yield* assets.iconPaths;
    const icon = Option.orElse(icons.ico, () => icons.png);
    if (Option.isNone(icon)) return;
    const nativeTray = yield* ElectronTray.ElectronTray;
    const window = yield* DesktopWindow.DesktopWindow;
    const context = yield* Effect.context<Services>();
    const runPromise = Effect.runPromiseWith(context);
    const run = <E>(action: Effect.Effect<void, E, Services>) => {
      void runPromise(
        action.pipe(Effect.catchCause((cause) => logError("Tray action failed", { cause }))),
      );
    };
    const open = () => run(window.activate);
    const stop = () =>
      run(
        Effect.gen(function* () {
          const dialog = yield* ElectronDialog.ElectronDialog;
          const result = yield* dialog.showMessageBox({
            type: "warning",
            title: "Stop J1 Code?",
            message: "Stop the server and close J1 Code?",
            detail: "This ends running chats and their sub-agents.",
            buttons: ["Keep running", "Stop server and quit"],
            defaultId: 0,
            cancelId: 0,
          });
          if (result.response === 1) yield* stopAndQuit;
        }),
      );
    const close = Effect.gen(function* () {
      if (yield* Ref.getAndSet(closing, true)) return;
      yield* Effect.gen(function* () {
        const settings = yield* Settings.DesktopAppSettings;
        let behavior = (yield* settings.get).closeBehavior;
        if (behavior === "ask") {
          const dialog = yield* ElectronDialog.ElectronDialog;
          const choice = yield* dialog.showMessageBox({
            type: "question",
            title: "Close J1 Code",
            message: "How would you like to close J1 Code?",
            detail:
              "Close to tray keeps chats running. Close completely stops the server and running chats.",
            buttons: ["Close to tray", "Close completely", "Cancel"],
            defaultId: 0,
            cancelId: 2,
            checkboxLabel: "Remember my choice",
            checkboxChecked: false,
          });
          if (choice.response === 2) return;
          behavior = choice.response === 1 ? "quit" : "tray";
          if (choice.checkboxChecked) yield* settings.setCloseBehavior(behavior);
        }
        if (behavior === "quit") yield* stopAndQuit;
        else {
          yield* window.flushMainWindowBounds;
          yield* (yield* ElectronWindow.ElectronWindow).destroyAll;
        }
      }).pipe(Effect.ensuring(Ref.set(closing, false)));
    }).pipe(Effect.catchCause((cause) => logError("Could not close J1 Code", { cause })));
    yield* Ref.set(closeHandler, close.pipe(Effect.provide(context)));
    const tray = yield* nativeTray.create(icon.value, open);
    yield* Ref.set(active, true);
    yield* Effect.addFinalizer(() => Ref.set(active, false));
    let previousStatus = "";
    const refresh = Effect.gen(function* () {
      const record = yield* Effect.promise(() =>
        Background.readBackgroundRecord(environment.baseDir),
      ).pipe(
        Effect.map((record) => (record ? `Server running (${record.version})` : "Server stopped")),
        Effect.catchCause(() => Effect.succeed("Server status unavailable")),
      );
      if (record === previousStatus) return;
      yield* tray.update(record, [
        { label: record, enabled: false },
        { type: "separator" },
        { label: "Open J1 Code", click: open },
        { label: "Stop server and quit", click: stop },
      ]);
      previousStatus = record;
    });
    yield* refresh;
    yield* Effect.forkScoped(
      Effect.forever(Effect.sleep("5 seconds").pipe(Effect.andThen(refresh))),
    );
  }).pipe(Effect.catchCause((cause) => logError("Could not create J1 tray controls", { cause })));
  return DesktopTray.of({
    requestClose: Ref.get(closeHandler).pipe(Effect.flatMap((action) => action)),
    active: Ref.get(active),
    exitAllowed: Ref.get(exitAllowed),
    allowExit,
    stopAndQuit,
    configure,
  });
});

export const layer = Layer.effect(DesktopTray, make);
