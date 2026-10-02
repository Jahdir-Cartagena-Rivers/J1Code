import { DotChatSendInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { create } from "zustand";
import { persist } from "zustand/middleware";

const Draft = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(40000)),
  pending: Schema.NullOr(DotChatSendInput),
});
const Saved = Schema.Struct({ drafts: Schema.Record(Schema.String, Draft) });
const decodeSaved = Schema.decodeUnknownOption(Saved);
type DraftState = {
  drafts: Record<string, typeof Draft.Type>;
  put: (key: string, draft: typeof Draft.Type) => void;
};
export const useDotChatDraftStore = create<DraftState>()(
  persist(
    (set) => ({
      drafts: {},
      put: (key, draft) => set((state) => ({ drafts: { ...state.drafts, [key]: draft } })),
    }),
    {
      name: "j1:dot-native-drafts:v1",
      partialize: (state) => ({ drafts: state.drafts }),
      merge: (saved, current) => {
        const decoded = decodeSaved(saved);
        return Option.isSome(decoded) && Object.keys(decoded.value.drafts).length <= 500
          ? { ...current, drafts: { ...decoded.value.drafts } }
          : current;
      },
    },
  ),
);
