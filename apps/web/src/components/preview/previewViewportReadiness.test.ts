import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { browserViewportSettingKey } from "~/browser/browserViewportLayout";

import { isPreviewViewportReady, waitForPreviewViewport } from "./previewViewportReadiness";
import { resolveHostWaitBudgetMs } from "./previewAutomationHostBudget";

describe("viewport probe deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it("returns before the broker deadline even when the guest never responds", async () => {
    const deadline = resolveHostWaitBudgetMs(1000);
    await vi.advanceTimersByTimeAsync(300); // setup shares the original budget
    const result = waitForPreviewViewport(deadline, () => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(499);
    let finished = false;
    void result.then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeNull();
    expect(Date.now()).toBe(800);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a viewport that arrives after its operation timed out", async () => {
    let respond!: (value: { width: number; height: number }) => void;
    const result = waitForPreviewViewport(
      80,
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(80);
    expect(await result).toBeNull();
    respond({ width: 390, height: 844 });
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps polling through transient views and returns the matching viewport", async () => {
    const size = { width: 390, height: 844 };
    const probe = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(size);
    const result = waitForPreviewViewport(800, probe);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toEqual(size);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("isPreviewViewportReady", () => {
  const landscape = {
    _tag: "preset",
    width: 844,
    height: 390,
    presetId: "iphone-12-pro",
  } as const;

  it("rejects a stale same-mode preset while React applies the requested orientation", () => {
    expect(
      isPreviewViewportReady({
        setting: landscape,
        appliedSettingKey: "preset:390:844:iphone-12-pro",
        declaredViewport: { width: 390, height: 844 },
        renderedViewport: { width: 390, height: 844 },
      }),
    ).toBe(false);
  });

  it("requires both the declaration and guest viewport to match a fixed request", () => {
    const appliedSettingKey = browserViewportSettingKey(landscape);
    expect(
      isPreviewViewportReady({
        setting: landscape,
        appliedSettingKey,
        declaredViewport: { width: 390, height: 844 },
        renderedViewport: { width: 844, height: 390 },
      }),
    ).toBe(false);
    expect(
      isPreviewViewportReady({
        setting: landscape,
        appliedSettingKey,
        declaredViewport: { width: 844, height: 390 },
        renderedViewport: { width: 844, height: 390 },
      }),
    ).toBe(true);
  });

  it("allows one pixel of Electron rounding tolerance in every mode", () => {
    expect(
      isPreviewViewportReady({
        setting: { _tag: "fill" },
        appliedSettingKey: "fill",
        declaredViewport: { width: 500, height: 700 },
        renderedViewport: { width: 501, height: 699 },
      }),
    ).toBe(true);
    expect(
      isPreviewViewportReady({
        setting: landscape,
        appliedSettingKey: browserViewportSettingKey(landscape),
        declaredViewport: { width: 844, height: 390 },
        renderedViewport: { width: 845, height: 389 },
      }),
    ).toBe(true);
    expect(
      isPreviewViewportReady({
        setting: landscape,
        appliedSettingKey: browserViewportSettingKey(landscape),
        declaredViewport: { width: 844, height: 390 },
        renderedViewport: { width: 846, height: 390 },
      }),
    ).toBe(false);
  });
});
