import { useSyncExternalStore } from "react";

import { getCustomThemes, getWorkspaceThemes, subscribeToCustomThemes } from "../themePalette";

const EMPTY_CUSTOM_THEMES: readonly [] = [];

export function useCustomThemes() {
  return useSyncExternalStore(subscribeToCustomThemes, getCustomThemes, () => EMPTY_CUSTOM_THEMES);
}

export function useWorkspaceThemes() {
  return useSyncExternalStore(
    subscribeToCustomThemes,
    getWorkspaceThemes,
    () => EMPTY_CUSTOM_THEMES,
  );
}
