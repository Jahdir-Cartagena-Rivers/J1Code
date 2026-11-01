import { replaceTextRange } from "@t3tools/shared/composerTrigger";

/** Own only our inserted range; any external edit stops updates rather than overwriting it. */
export class AndroidDictationDraft {
  private expected: string;
  private end: number;
  private committed = "";
  constructor(
    readonly owner: string,
    text: string,
    private readonly start: number,
    end: number,
  ) {
    this.expected = text;
    this.end = end;
  }
  update(owner: string | null, current: string, text: string, final: boolean) {
    if (owner !== this.owner || current !== this.expected) return null;
    const segment = text.trim();
    const inserted = [this.committed, segment].filter(Boolean).join(" ");
    const result = replaceTextRange(current, this.start, this.end, inserted);
    this.expected = result.text;
    this.end = result.cursor;
    if (final) this.committed = inserted;
    return result;
  }
}
