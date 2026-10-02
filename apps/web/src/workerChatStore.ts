import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { WorkerChatExpansion } from "@t3tools/client-runtime/worker-chats";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { resolveStorage } from "./lib/storage";

const decodeSavedWorkerChats = Schema.decodeUnknownOption(
  Schema.Struct({
    byParentKey: Schema.Record(Schema.String, WorkerChatExpansion),
  }),
);

interface WorkerChatStore {
  byParentKey: Record<string, WorkerChatExpansion>;
  setExpansion: (parentKey: string, expansion: WorkerChatExpansion) => void;
}

export const useWorkerChatStore = create<WorkerChatStore>()(
  persist(
    (set) => ({
      byParentKey: {},
      setExpansion: (parentKey, expansion) =>
        set((state) => ({
          byParentKey: { ...state.byParentKey, [parentKey]: expansion },
        })),
    }),
    {
      name: "j1:worker-chats:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byParentKey: state.byParentKey }),
      merge: (persisted, current) => {
        const saved = decodeSavedWorkerChats(persisted);
        return { ...current, byParentKey: Option.isSome(saved) ? saved.value.byParentKey : {} };
      },
    },
  ),
);
