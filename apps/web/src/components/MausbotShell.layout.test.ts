import { describe, expect, it } from "vite-plus/test";
import { nativeOverlayClip } from "./MausbotShell.layout";
const box = { left: 0, top: 100, width: 300, height: 500 };
describe("merged workspace overlays", () => {
  it("keeps project and footer navigation usable inside an open phone drawer while hiding the work pane", () => {
    const drawer = { left: 0, top: 0, width: 390, height: 840, mainOnly: true };
    expect(nativeOverlayClip(box, [drawer], "navigation")).toBeUndefined();
    expect(nativeOverlayClip(box, [drawer])).toBe("inset(50%)");
  });
  it("still gives ordinary native menus and dialogs priority over both navigation and the work pane", () => {
    const menu = { left: 0, top: 80, width: 300, height: 600 };
    expect(nativeOverlayClip(box, [menu], "navigation")).toBe("inset(50%)");
    expect(nativeOverlayClip(box, [menu])).toBe("inset(50%)");
    expect(
      nativeOverlayClip(box, [{ left: 500, top: 100, width: 20, height: 20 }], "navigation"),
    ).toBeUndefined();
    expect(
      nativeOverlayClip(box, [{ left: 100, top: 200, width: 20, height: 20 }], "navigation"),
    ).toContain("M92 92H128V128H92Z");
  });
});
