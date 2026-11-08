import { SKINS, SKIN_IDS, applySkin, readSkinChoice, resolveSkin } from "@/lib/skins";
import { applyChatWidth } from "@/lib/chat-width";
import { MAUSBOT_THEME_ROLES } from "../../shared/j1-appearance";

let catalog: ReturnType<typeof readNativeSkins> | undefined;
export const nativeSkinCatalog = () => (catalog ??= readNativeSkins());

function readNativeSkins() {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none";
  probe.dataset.skinPreview = "";
  document.body.append(probe);
  try {
    return SKINS.map((skin) => {
      probe.dataset.skin = skin.id;
      const colors = Object.fromEntries(
        [...new Set(Object.values(MAUSBOT_THEME_ROLES))].map((token) => {
          probe.style.color = `var(--color-${token})`;
          return [token, getComputedStyle(probe).color];
        }),
      );
      // The same skin contexts used by upstream's own previews supply the appearance.
      const appearance =
        getComputedStyle(probe).getPropertyValue("--code-color-scheme").trim() === "light"
          ? "light"
          : "dark";
      return { id: skin.id, name: skin.name, appearance, colors };
    });
  } finally {
    probe.remove();
  }
}

export function nativeFontCatalog() {
  return [...document.styleSheets].flatMap((sheet) => {
    try {
      return [...sheet.cssRules].flatMap((rule) => {
        if (rule.type !== CSSRule.FONT_FACE_RULE) return [];
        const style = (rule as CSSFontFaceRule).style;
        const family = style.getPropertyValue("font-family").replace(/^["']|["']$/g, "");
        if (!family.includes("Geist")) return [];
        const source = style.getPropertyValue("src").match(/url\(["']?([^"')]+)["']?\)/)?.[1];
        if (!source) return [];
        return [
          {
            family,
            url: new URL(source, sheet.href ?? location.href).href,
            weight: style.getPropertyValue("font-weight") || "400",
            style: style.getPropertyValue("font-style") || "normal",
            unicodeRange: style.getPropertyValue("unicode-range") || "U+0-10FFFF",
          },
        ];
      });
    } catch {
      return [];
    }
  });
}

export function applyJ1Appearance(value: unknown) {
  if (!value || typeof value !== "object") return;
  nativeSkinCatalog();
  const appearance = value as {
    skin?: string;
    dark?: boolean;
    colors?: Record<string, string>;
    chatWidth?: string;
    font?: string;
    mono?: string;
  };
  const selected =
    SKIN_IDS.find((id) => `mausbot-${id}` === appearance.skin) ??
    (appearance.dark ? "midnight" : "daylight");
  if (resolveSkin(readSkinChoice()) !== selected) applySkin(selected);
  const root = document.documentElement;
  for (const token of new Set(Object.values(MAUSBOT_THEME_ROLES))) {
    const color = appearance.colors?.[token];
    if (typeof color === "string" && CSS.supports("color", color))
      root.style.setProperty(`--color-${token}`, color);
  }
  if (typeof appearance.font === "string" && appearance.font.length < 500)
    root.style.setProperty("--font-sans", appearance.font);
  if (typeof appearance.mono === "string" && appearance.mono.length < 500)
    root.style.setProperty("--font-mono", appearance.mono);
  applyChatWidth(
    appearance.chatWidth === "full"
      ? "full"
      : appearance.chatWidth === "wide"
        ? "wide"
        : "standard",
  );
}
