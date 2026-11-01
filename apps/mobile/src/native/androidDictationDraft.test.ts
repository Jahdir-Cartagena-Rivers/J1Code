import { describe, expect, it } from "vite-plus/test";
import { AndroidDictationDraft } from "./androidDictationDraft";

describe("Android live dictation draft", () => {
  it("replaces interim text and appends finalized utterances across pauses", () => {
    const draft = new AndroidDictationDraft("chat", "before old after", 7, 10);
    const partial = draft.update("chat", "before old after", "hel", false)!;
    const final = draft.update("chat", partial.text, "hello", true)!;
    const next = draft.update("chat", final.text, "world", false)!;
    expect(next.text).toBe("before hello world after");
    expect(draft.update("chat", next.text, "world again", true)?.text).toBe(
      "before hello world again after",
    );
  });
  it("rejects edited drafts and changed owners without overwriting them", () => {
    const draft = new AndroidDictationDraft("chat", "typed", 5, 5);
    expect(draft.update("other", "typed", "speech", true)).toBeNull();
    expect(draft.update("chat", "user edited", "speech", true)).toBeNull();
  });
  it("clears unconfirmed hypotheses on silence while preserving committed text", () => {
    const draft = new AndroidDictationDraft("chat", "", 0, 0);
    const first = draft.update("chat", "", "hello", true)!;
    const second = draft.update("chat", first.text, "noise", false)!;
    expect(draft.update("chat", second.text, "", false)?.text).toBe("hello");
  });
});
