export function decodeMausbotFonts(value: unknown, viewUrl: string) {
  if (!Array.isArray(value) || value.length > 40) return [];
  const view = new URL(viewUrl);
  const prefix = view.pathname.replace(/[^/]*$/, "");
  return value.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (
      (row.family !== "Geist Variable" && row.family !== "Geist Mono Variable") ||
      typeof row.url !== "string" ||
      typeof row.weight !== "string" ||
      !/^\d{1,4}( \d{1,4})?$/.test(row.weight) ||
      (row.style !== "normal" && row.style !== "italic") ||
      typeof row.unicodeRange !== "string" ||
      row.unicodeRange.length > 500
    )
      return [];
    try {
      const url = new URL(row.url);
      if (
        url.origin !== view.origin ||
        !url.pathname.startsWith(prefix) ||
        !url.pathname.endsWith(".woff2")
      )
        return [];
      return [
        {
          family: row.family,
          url: url.href,
          weight: row.weight,
          style: row.style,
          unicodeRange: row.unicodeRange,
        },
      ];
    } catch {
      return [];
    }
  });
}

const installed = new Set<string>();
export function installMausbotFonts(value: unknown, viewUrl: string) {
  for (const font of decodeMausbotFonts(value, viewUrl)) {
    const key = JSON.stringify(font);
    if (installed.has(key)) continue;
    installed.add(key);
    // Desktop permits connections to the selected environment but intentionally keeps
    // font-src local. Load the granted asset as bytes without broadening that policy.
    void fetch(font.url, { credentials: "omit", signal: AbortSignal.timeout(15_000) })
      .then(async (response) => {
        if (!response.ok) throw new Error("The workspace font is unavailable.");
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > 1024 * 1024) throw new Error("The workspace font is too large.");
        const face = new FontFace(font.family, bytes, {
          weight: font.weight,
          style: font.style,
          unicodeRange: font.unicodeRange,
          display: "swap",
        });
        await face.load();
        document.fonts.add(face);
      })
      .catch(() => {
        installed.delete(key);
        // System fallbacks remain available while the environment is disconnected.
      });
  }
}
