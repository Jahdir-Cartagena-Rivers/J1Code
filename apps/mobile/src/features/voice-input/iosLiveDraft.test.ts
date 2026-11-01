import { expect, it } from "vite-plus/test";
import { AndroidDictationDraft } from "../../native/androidDictationDraft";

it("replaces cumulative iOS hypotheses through rotation and finish without duplicating words", () => {
  const draft = new AndroidDictationDraft("chat", "before old after", 7, 10);
  const first = draft.update("chat", "before old after", "hello", false)!;
  const rotated = draft.update("chat", first.text, "hello world", false)!;
  const finished = draft.update("chat", rotated.text, "hello world again", false)!;
  expect(finished.text).toBe("before hello world again after");
  expect(draft.update("other", finished.text, "late", false)).toBeNull();
  expect(draft.update("chat", "user edited", "late", false)).toBeNull();
});
