import { describe, expect, it } from "vite-plus/test";
import { recoverMausbotView } from "./mausbotViewRecovery";

describe("embedded workspace recovery", () => {
  it("keeps the same frame when the view renews", async () => {
    let opened = false;
    const open = async () => { opened = true; return "/unexpected-view"; };
    expect(await recoverMausbotView(async () => true, open, () => true)).toBeNull();
    expect(opened).toBe(false);
  });

  it("replaces an expired view through the authenticated host", async () => {
    expect(await recoverMausbotView(async () => false, async () => "/new-view", () => true))
      .toBe("/new-view");
  });

  it("leaves an auth refusal in place", async () => {
    expect(await recoverMausbotView(async () => false, async () => null, () => true)).toBeNull();
  });

  it("recovers on the next attempt after a transport failure", async () => {
    let calls = 0;
    const renew = async () => {
      if (++calls === 1) throw new Error("Offline");
      return false;
    };
    const open = async () => "/new-view";
    expect(await recoverMausbotView(renew, open, () => true)).toBeNull();
    expect(await recoverMausbotView(renew, open, () => true)).toBe("/new-view");
  });

  it("ignores replacement results after switching environments", async () => {
    let current = true;
    const open = async () => { current = false; return "/stale-view"; };
    expect(await recoverMausbotView(async () => false, open, () => current)).toBeNull();
  });
});
