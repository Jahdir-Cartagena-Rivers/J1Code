/** Blank selects the desktop bundle; disabled explicitly prevents native startup. */
export function resolveBrowserExecutable(override: string, bundled?: string): string {
  const value = override.trim();
  if (value.toLowerCase() === "disabled") throw new Error("Background browser is disabled.");
  return value || bundled || "";
}
