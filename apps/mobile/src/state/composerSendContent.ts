import type { ComposerDraft } from "./use-composer-drafts";
/** A call sends only its captured words and never consumes unrelated composer content. */
export function composerSendContent(draft: ComposerDraft, voiceText?: string) {
  return voiceText === undefined
    ? {
        text: draft.text.trim(),
        attachments: draft.attachments,
        context: draft.context,
        consumesDraft: true,
      }
    : { text: voiceText.trim(), attachments: [], context: undefined, consumesDraft: false };
}
