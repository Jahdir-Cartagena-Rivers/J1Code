import { expect, it } from "vite-plus/test";
import { composerSendContent } from "./composerSendContent";
import type { ComposerDraft } from "./use-composer-drafts";
it("keeps typed draft, attachments and context out of a voice message", () => {
  const attachments = [{ id: "a" }] as unknown as ComposerDraft["attachments"];
  const context = { items: [{ type: "fixture" }] } as unknown as NonNullable<
    ComposerDraft["context"]
  >;
  const draft: ComposerDraft = { text: "typed draft", attachments, context };
  expect(composerSendContent(draft, " spoken words ")).toEqual({
    text: "spoken words",
    attachments: [],
    context: undefined,
    consumesDraft: false,
  });
  expect(draft).toEqual({ text: "typed draft", attachments, context });
  expect(composerSendContent(draft)).toEqual({
    text: "typed draft",
    attachments,
    context,
    consumesDraft: true,
  });
});
