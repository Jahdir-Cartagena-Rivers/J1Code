import { describe, expect, it } from "vite-plus/test";
import { decodeMausbotFonts } from "./mausbotFonts";

const view = "https://server.example/api/mausbot/view/owned/index.html";
const font = {
  family: "Geist Variable",
  url: "https://server.example/api/mausbot/view/owned/assets/geist.woff2",
  weight: "100 900",
  style: "normal",
  unicodeRange: "U+0-10FFFF",
};
describe("bundled workspace fonts", () => {
  it("accepts a font belonging to the granted native view", () => {
    expect(decodeMausbotFonts([font], view)).toEqual([font]);
  });
  it("rejects another origin, another view grant and unsupported assets", () => {
    for (const url of [
      "https://other.example/assets/geist.woff2",
      "https://server.example/api/mausbot/view/other/assets/geist.woff2",
      "https://server.example/api/mausbot/view/owned/assets/script.js",
    ]) {
      expect(decodeMausbotFonts([{ ...font, url }], view)).toEqual([]);
    }
    expect(decodeMausbotFonts([{ ...font, weight: "url(invalid)" }], view)).toEqual([]);
    expect(
      decodeMausbotFonts(
        Array.from({ length: 41 }, () => font),
        view,
      ),
    ).toEqual([]);
  });
});
