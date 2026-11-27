import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

export class ElectronDialogPickFolderError extends Schema.TaggedError<ElectronDialogPickFolderError>()(
  "ElectronDialogPickFolderError",
  {
    ownerWindowId: Schema.NullOr(Schema.Number),
    defaultPath: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const owner = this.ownerWindowId === null ? "the application" : `window ${this.ownerWindowId}`;
    const defaultPath = this.defaultPath === null ? "no default path" : this.defaultPath;
    return `Failed to open the Electron folder picker for ${owner} with ${defaultPath}.`;
  }
}

export class ElectronDialogPickFilesError extends Schema.TaggedError<ElectronDialogPickFilesError>()(
  "ElectronDialogPickFilesError",
  {
    ownerWindowId: Schema.NullOr(Schema.Number),
    defaultPath: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const owner = this.ownerWindowId === null ? "the application" : `window ${this.ownerWindowId}`;
    const defaultPath = this.defaultPath === null ? "no default path" : this.defaultPath;
    return `Failed to open the Electron file picker for ${owner} with ${defaultPath}.`;
  }
}

export class ElectronDialogShowMessageBoxError extends Schema.TaggedError<ElectronDialogShowMessageBoxError>()(
  "ElectronDialogShowMessageBoxError",
  {
    type: Schema.NullOr(Schema.Literals(["none", "info", "error", "question", "warning"])),
    titleLength: Schema.NullOr(Schema.Number),
    messageLength: Schema.Number,
    detailLength: Schema.NullOr(Schema.Number),
    buttonCount: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const type = this.type === null ? "untyped" : this.type;
    return `Failed to show the Electron ${type} message box with ${this.buttonCount} buttons.`;
  }
}

export class ElectronDialogShowErrorBoxError extends Schema.TaggedError<ElectronDialogShowErrorBoxError>()(
  "ElectronDialogShowErrorBoxError",
  {
    titleLength: Schema.Number,
    contentLength: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to show the Electron error box with a ${this.titleLength}-character title and ${this.contentLength}-character content.`;
  }
}

export const ElectronDialogError = Schema.Union([
  ElectronDialogPickFolderError,
  ElectronDialogPickFilesError,
  ElectronDialogShowMessageBoxError,
  ElectronDialogShowErrorBoxError,
]);
export type ElectronDialogError = typeof ElectronDialogError.Type;

export interface ElectronDialogPickFolderInput {
  readonly owner: Option.Option<Electron.BrowserWindow>;
  readonly defaultPath: Option.Option<string>;
}

export interface ElectronDialogPickFilesInput {
  readonly owner: Option.Option<Electron.BrowserWindow>;
  readonly defaultPath: Option.Option<string>;
  readonly filters: readonly Electron.FileFilter[];
  readonly multiple: boolean;
}

export class ElectronDialog extends Context.Service<
  ElectronDialog,
  {
    readonly pickFolder: (
      input: ElectronDialogPickFolderInput,
    ) => Effect.Effect<Option.Option<string>, ElectronDialogPickFolderError>;
    readonly pickFiles: (
      input: ElectronDialogPickFilesInput,
    ) => Effect.Effect<readonly string[], ElectronDialogPickFilesError>;
    /** Pass `owner` to attach the box to that window so it cannot fall behind it. */
    readonly showMessageBox: (
      options: Electron.MessageBoxOptions,
      owner?: Electron.BrowserWindow,
      presentation?: "close-j1",
    ) => Effect.Effect<Electron.MessageBoxReturnValue, ElectronDialogShowMessageBoxError>;
    readonly showErrorBox: (title: string, content: string) => Effect.Effect<void>;
  }
>()("@j1code/desktop/electron/ElectronDialog") {}

function showCloseJ1Dialog(
  owner?: Electron.BrowserWindow,
): Promise<Electron.MessageBoxReturnValue> {
  owner ??= Electron.BrowserWindow.getFocusedWindow() ?? undefined;
  const parent = owner && !owner.isDestroyed() ? owner : undefined;
  const width = 510;
  const height = 246;
  const ownerBounds = parent?.getBounds();
  const workArea = ownerBounds && Electron.screen.getDisplayMatching(ownerBounds).workArea;
  const position =
    ownerBounds && workArea
      ? {
          x: Math.max(
            workArea.x,
            Math.min(
              workArea.x + workArea.width - width,
              Math.round(ownerBounds.x + (ownerBounds.width - width) / 2),
            ),
          ),
          y: Math.max(
            workArea.y,
            Math.min(
              workArea.y + workArea.height - height,
              Math.round(ownerBounds.y + (ownerBounds.height - height) / 2),
            ),
          ),
        }
      : {};
  const cancel = { response: 2, checkboxChecked: false };
  const origin = "https://close-j1.invalid";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Close J1 Code</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#171717;--muted:#525252;--border:#d4d4d4;--hover:#f5f5f5}
@media(prefers-color-scheme:dark){:root{--bg:#141414;--fg:#fafafa;--muted:#a3a3a3;--border:#404040;--hover:#262626}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
header{padding:20px 24px 0;-webkit-app-region:drag}
h1{font-size:17px;margin:0}main{padding:12px 24px 20px}p{color:var(--muted);margin:0 0 16px}
nav{display:flex;gap:8px;margin-top:18px;flex-wrap:wrap}
a{padding:7px 10px;border:1px solid var(--border);border-radius:7px;color:inherit;text-decoration:none}
a:hover{background:var(--hover)}a.primary{background:#1864e8;border-color:#1864e8;color:white}
#remember:not(:checked)~nav .remembered,#remember:checked~nav .once{display:none}
</style></head><body><header><h1>Close J1 Code</h1></header><main>
<p>Close to tray keeps chats running. Close completely stops the server and running chats.</p>
<input type="checkbox" id="remember"><label for="remember"> Remember my choice</label>
<nav aria-label="Close options">
<a class="primary once" href="${origin}/0/once">Close to tray</a>
<a class="primary remembered" href="${origin}/0/remember">Close to tray</a>
<a class="once" href="${origin}/1/once">Close completely</a>
<a class="remembered" href="${origin}/1/remember">Close completely</a>
<a href="${origin}/2/once" autofocus>Cancel</a>
</nav></main></body></html>`;
  return new Promise((resolve, reject) => {
    const window = new Electron.BrowserWindow({
      title: "Close J1 Code",
      width,
      height,
      ...position,
      frame: false,
      show: false,
      resizable: false,
      backgroundColor: Electron.nativeTheme.shouldUseDarkColors ? "#141414" : "#ffffff",
      ...(parent ? { parent, modal: true } : {}),
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const finish = (choice: Electron.MessageBoxReturnValue) => {
      resolve(choice);
      if (!window.isDestroyed()) window.destroy();
    };
    window.once("closed", () => resolve(cancel));
    window.once("ready-to-show", () => window.show());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      event.preventDefault();
      const match = /^https:\/\/close-j1\.invalid\/([012])\/(once|remember)$/.exec(url);
      if (match) finish({ response: Number(match[1]), checkboxChecked: match[2] === "remember" });
    });
    window.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "Escape") {
        event.preventDefault();
        finish(cancel);
      }
    });
    void window
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .catch((error) => {
        reject(error);
        if (!window.isDestroyed()) window.destroy();
      });
  });
}

/** @public */
export const make = ElectronDialog.of({
  pickFolder: Effect.fn("desktop.electron.dialog.pickFolder")(function* (input) {
    const ownerWindowId = Option.match(input.owner, {
      onNone: () => null,
      onSome: (owner) => owner.id,
    });
    const defaultPath = Option.getOrNull(input.defaultPath);
    const openDialogOptions: Electron.OpenDialogOptions = Option.match(input.defaultPath, {
      onNone: () => ({
        properties: ["openDirectory", "createDirectory"],
      }),
      onSome: (defaultPath) => ({
        properties: ["openDirectory", "createDirectory"],
        defaultPath,
      }),
    });
    const result = yield* Effect.tryPromise({
      try: () =>
        Option.match(input.owner, {
          onNone: () => Electron.dialog.showOpenDialog(openDialogOptions),
          onSome: (owner) => Electron.dialog.showOpenDialog(owner, openDialogOptions),
        }),
      catch: (cause) =>
        new ElectronDialogPickFolderError({
          ownerWindowId,
          defaultPath,
          cause,
        }),
    });

    if (result.canceled) {
      return Option.none();
    }
    return Option.fromNullishOr(result.filePaths[0]);
  }),
  pickFiles: Effect.fn("desktop.electron.dialog.pickFiles")(function* (input) {
    const ownerWindowId = Option.match(input.owner, {
      onNone: () => null,
      onSome: (owner) => owner.id,
    });
    const defaultPath = Option.getOrNull(input.defaultPath);
    const openDialogOptions: Electron.OpenDialogOptions = {
      properties: input.multiple ? ["openFile", "multiSelections"] : ["openFile"],
      filters: [...input.filters],
      ...(defaultPath === null ? {} : { defaultPath }),
    };
    const result = yield* Effect.tryPromise({
      try: () =>
        Option.match(input.owner, {
          onNone: () => Electron.dialog.showOpenDialog(openDialogOptions),
          onSome: (owner) => Electron.dialog.showOpenDialog(owner, openDialogOptions),
        }),
      catch: (cause) =>
        new ElectronDialogPickFilesError({
          ownerWindowId,
          defaultPath,
          cause,
        }),
    });
    return result.canceled ? [] : result.filePaths;
  }),
  showMessageBox: Effect.fn("ElectronDialog.showMessageBox")(
    function (options, owner, presentation) {
      return Effect.tryPromise({
        try: () =>
          presentation === "close-j1"
            ? showCloseJ1Dialog(owner)
            : owner === undefined
              ? Electron.dialog.showMessageBox(options)
              : Electron.dialog.showMessageBox(owner, options),
        catch: (cause) =>
          new ElectronDialogShowMessageBoxError({
            type: options.type ?? null,
            titleLength: options.title?.length ?? null,
            messageLength: options.message.length,
            detailLength: options.detail?.length ?? null,
            buttonCount: options.buttons?.length ?? 0,
            cause,
          }),
      });
    },
  ),
  showErrorBox: Effect.fn("ElectronDialog.showErrorBox")(function (title, content) {
    return Effect.try({
      try: () => Electron.dialog.showErrorBox(title, content),
      catch: (cause) =>
        new ElectronDialogShowErrorBoxError({
          titleLength: title.length,
          contentLength: content.length,
          cause,
        }),
    }).pipe(Effect.orDie);
  }),
});

export const layer = Layer.succeed(ElectronDialog, make);
