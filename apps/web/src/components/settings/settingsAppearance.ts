import { createContext, useContext } from "react";

export const MergedSettingsAppearance = createContext(false);
export const useMergedSettingsAppearance = () => useContext(MergedSettingsAppearance);
