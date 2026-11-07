import { describe, expect, it } from "vite-plus/test";
import { scrollWithin } from "./scrollWithin";

describe("scrolling within a floating panel", () => {
  it("moves only the supplied scroller using viewport-relative coordinates", () => {
    const scroller = {
      scrollTop: 80,
      clientHeight: 200,
      getBoundingClientRect: () => ({ top: 100 }),
    };
    const item = { offsetHeight: 30, getBoundingClientRect: () => ({ top: 350 }) };
    scrollWithin(scroller, item, "start", 170);
    expect(scroller.scrollTop).toBe(160);
    scrollWithin(scroller, { getBoundingClientRect: () => ({ top: -500 }) });
    expect(scroller.scrollTop).toBe(0);
  });
});
