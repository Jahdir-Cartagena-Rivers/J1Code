import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export interface DotChatTarget {
  url: string;
  profileId: string;
}

/** Accept only a real Dot conversation link, never an arbitrary embedded site. */
export function normalizeDotChatUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (
      url.origin !== "https://chatgpt.com" ||
      url.username ||
      url.password ||
      !/^\/dots\/[a-zA-Z0-9-]+\/?$/.test(url.pathname)
    )
      return null;
    return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

export function readDotChatTarget(value: unknown): DotChatTarget | null {
  if (typeof value !== "object" || value === null || !("url" in value) || !("profileId" in value))
    return null;
  if (typeof value.url !== "string" || typeof value.profileId !== "string" || !value.profileId)
    return null;
  const url = normalizeDotChatUrl(value.url);
  return url ? { url, profileId: value.profileId } : null;
}

/** Device-local: each environment keeps its own conversation and login profile. */
export const useDotChatStore = create<{
  byEnvironment: Record<string, DotChatTarget>;
  setTarget: (environmentId: string, target: DotChatTarget | null) => void;
}>()(
  persist(
    (set) => ({
      byEnvironment: {},
      setTarget: (environmentId, target) =>
        set((state) => {
          const byEnvironment = { ...state.byEnvironment };
          if (target) byEnvironment[environmentId] = target;
          else delete byEnvironment[environmentId];
          return { byEnvironment };
        }),
    }),
    {
      name: "j1:dot-chat:v1",
      storage: createJSONStorage(() => resolveStorage(globalThis.localStorage)),
      partialize: (state) => ({ byEnvironment: state.byEnvironment }),
      merge: (saved, current) => {
        if (
          typeof saved !== "object" ||
          saved === null ||
          !("byEnvironment" in saved) ||
          typeof saved.byEnvironment !== "object" ||
          saved.byEnvironment === null
        )
          return current;
        const byEnvironment: Record<string, DotChatTarget> = {};
        for (const [key, value] of Object.entries(saved.byEnvironment)) {
          const target = readDotChatTarget(value);
          if (target) byEnvironment[key] = target;
        }
        return { ...current, byEnvironment };
      },
    },
  ),
);
