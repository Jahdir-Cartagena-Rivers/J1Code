import { MAUSBOT_THEME_ROLES } from "@t3tools/shared/mausbotAppearance";
import {
  getStandardThemeColors,
  toCanonicalThemeColor,
  type ThemeDefinition,
} from "../themePalette";

/** Native skins are read from upstream CSS; malformed catalog entries never become CSS. */
export function decodeMausbotThemes(value: unknown): ThemeDefinition[] {
  if (!Array.isArray(value) || value.length > 20) return [];
  const seen = new Set<string>();
  return value.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      !/^[a-z][a-z0-9-]{0,24}$/.test(row.id) ||
      typeof row.name !== "string" ||
      row.name.length > 48 ||
      !row.name.trim() ||
      (row.appearance !== "dark" && row.appearance !== "light") ||
      !row.colors ||
      typeof row.colors !== "object"
    )
      return [];
    if (seen.has(row.id)) return [];
    seen.add(row.id);
    const tokens = row.colors as Record<string, unknown>;
    const colors = { ...getStandardThemeColors(row.appearance) };
    for (const [role, token] of Object.entries(MAUSBOT_THEME_ROLES)) {
      const color = toCanonicalThemeColor(tokens[token]);
      if (!color) return [];
      colors[role as keyof typeof MAUSBOT_THEME_ROLES] = color;
    }
    return [
      {
        id: `mausbot-${row.id}`,
        label: row.name,
        appearance: row.appearance,
        colors,
        collection: { id: "openmausbot", label: "OpenMausbot" },
      },
    ];
  });
}
