import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Electron from "electron";

export interface TrayHandle {
  readonly update: (
    status: string,
    menu: Electron.MenuItemConstructorOptions[],
  ) => Effect.Effect<void>;
}

export class ElectronTray extends Context.Service<
  ElectronTray,
  {
    readonly create: (
      icon: string,
      open: () => void,
    ) => Effect.Effect<TrayHandle, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronTray") {}

export const layer = Layer.succeed(ElectronTray, {
  create: (icon, open) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const tray = new Electron.Tray(icon);
        tray.on("click", open);
        tray.on("double-click", open);
        return tray;
      }),
      (tray) => Effect.sync(() => tray.destroy()),
    ).pipe(
      Effect.map((tray) => ({
        update: (status, menu) =>
          Effect.sync(() => {
            tray.setToolTip(`J1 Code — ${status}`);
            tray.setContextMenu(Electron.Menu.buildFromTemplate(menu));
          }),
      })),
    ),
});
