import { createContext, useContext } from "react";

// Hosted forms keep their overlays in the same document and stylesheet boundary.
export const PortalContainer = createContext<HTMLElement | undefined>(undefined);
export const usePortalContainer = () => useContext(PortalContainer);
