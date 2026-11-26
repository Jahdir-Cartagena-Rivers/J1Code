import type { BrowserWindow } from "electron";
import { nativeTheme } from "electron";

const DWMWA_CAPTION_COLOR = 35;
const DWMWA_TEXT_COLOR = 36;
const DWMWA_COLOR_DEFAULT = 0xffffffff;
let api: Promise<typeof import("ffi-rs")> | undefined;

/** Tint the native caption while leaving its window dragging and controls to Windows. */
export function syncWindowsCaption(window: BrowserWindow, dark: boolean): void {
  api ??= import("ffi-rs").then((ffi) => {
    ffi.open({ library: "j1-dwm", path: "dwmapi.dll" });
    return ffi;
  });
  void api
    .then(({ DataType, load }) => {
      if (window.isDestroyed()) return;
      const handle = window.getNativeWindowHandle();
      const hwnd = handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
      const accessibilityColors = nativeTheme.shouldUseHighContrastColors;
      const setColor = (attribute: number, color: number) => {
        const value = Buffer.alloc(4);
        value.writeUInt32LE(accessibilityColors ? DWMWA_COLOR_DEFAULT : color);
        load({
          library: "j1-dwm",
          funcName: "DwmSetWindowAttribute",
          retType: DataType.I32,
          paramsType: [DataType.BigInt, DataType.U32, DataType.U8Array, DataType.U32],
          paramsValue: [hwnd, attribute, value, value.byteLength],
        });
      };
      setColor(DWMWA_CAPTION_COLOR, dark ? 0x141414 : 0xffffff);
      setColor(DWMWA_TEXT_COLOR, dark ? 0xfafafa : 0x171717);
    })
    .catch(() => {
      // Keep system chrome on hosts without the native caption-color APIs.
    });
}
