import { describe, expect, it } from "vite-plus/test";
import { MAUSBOT_THEME_ROLES } from "@t3tools/shared/mausbotAppearance";
import { decodeMausbotThemes } from "./mausbotAppearance";
import {
  getCustomThemes,
  getThemeDefinition,
  getWorkspaceThemes,
  setWorkspaceThemes,
  themeColorToHex,
} from "../themePalette";

const skin = {
  id: "midnight",
  name: "Midnight",
  appearance: "dark",
  colors: Object.fromEntries(Object.values(MAUSBOT_THEME_ROLES).map((token) => [token, "#121212"])),
};
describe("native workspace palettes", () => {
  it("resolves a runtime skin through the existing theme library without saving a custom theme", () => {
    const previous = getWorkspaceThemes();
    const custom = getCustomThemes();
    try {
      const themes = decodeMausbotThemes([skin]);
      expect(themes).toHaveLength(1);
      expect(setWorkspaceThemes(themes)).toBe(true);
      expect(themeColorToHex(getThemeDefinition("mausbot-midnight")!.colors.canvas)).toBe(
        "#121212",
      );
      expect(getThemeDefinition("t3-chat")?.id).toBe("t3-chat");
      expect(getCustomThemes()).toBe(custom);
      expect(setWorkspaceThemes(decodeMausbotThemes([skin]))).toBe(false);
    } finally {
      setWorkspaceThemes(previous);
    }
  });
  it("rejects malformed colors and unbounded catalogs", () => {
    expect(
      decodeMausbotThemes([
        { ...skin, colors: { ...skin.colors, app: "url(https://example.invalid/)" } },
      ]),
    ).toEqual([]);
    expect(decodeMausbotThemes(Array.from({ length: 21 }, () => skin))).toEqual([]);
    expect(decodeMausbotThemes([{ ...skin, id: "../escape" }])).toEqual([]);
  });
});
