import { describe, expect, it } from "vite-plus/test";
import { AndroidDictationLifecycle } from "./androidDictationLifecycle";
describe("Android callback lifecycle", () => {
  it("rejects callbacks after cancel and does not end the replacement session", () => {
    const session = new AndroidDictationLifecycle();
    session.begin(1);
    expect(session.accepts(1)).toBe(true);
    session.cancel();
    expect(session.accepts(1)).toBe(false);
    session.begin(2);
    expect(session.end(1)).toBe(false);
    expect(session.accepts(2)).toBe(true);
    expect(session.end(2)).toBe(true);
    expect(session.accepts(2)).toBe(false);
  });
});
