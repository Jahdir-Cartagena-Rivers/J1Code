import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  readThreadPreviewState: vi.fn(),
  status: vi.fn(),
  evaluate: vi.fn(),
}));

vi.mock("~/previewStateStore", () => ({
  applyPreviewServerSnapshot: vi.fn(),
  readThreadPreviewState: mocks.readThreadPreviewState,
  reconcilePreviewServerSessions: vi.fn(),
  updatePreviewServerSnapshot: vi.fn(),
}));

vi.mock("./previewBridge", () => ({
  previewBridge: {
    automation: {
      evaluate: mocks.evaluate,
      status: mocks.status,
    },
  },
}));

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";

import { PreviewAutomationTargetUnavailableError } from "./previewAutomationErrors";
import { waitForNavigationReadiness } from "./previewNavigationReadiness";
import { resolveHostWaitBudgetMs } from "./previewAutomationHostBudget";

describe("waitForNavigationReadiness", () => {
  it("rejects a replaced runtime target even when readiness polling is disabled", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("environment-2"),
      threadId: ThreadId.make("thread-1"),
    };
    const tabId = "tab_1";
    const staleRuntimeTabId = previewRuntimeTabId(threadRef, "epoch-1", tabId);
    mocks.readThreadPreviewState.mockReturnValue({
      serverEpoch: "epoch-2",
      sessions: {
        [tabId]: { tabId },
      },
    });

    await expect(
      waitForNavigationReadiness(
        threadRef,
        "request-1",
        tabId,
        staleRuntimeTabId,
        "navigate",
        "none",
        100,
      ),
    ).rejects.toBeInstanceOf(PreviewAutomationTargetUnavailableError);
  });
});

const thread = { environmentId: EnvironmentId.make("qa"), threadId: ThreadId.make("thread") };
const runtimeTabId = previewRuntimeTabId(thread, "epoch", "tab");
describe("navigation probe deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.resetAllMocks();
    mocks.readThreadPreviewState.mockReturnValue({
      serverEpoch: "epoch",
      sessions: { tab: { tabId: "tab" } },
    });
  });
  afterEach(() => vi.useRealTimers());

  it.each(["load", "domContentLoaded"] as const)("bounds a stalled %s probe", async (readiness) => {
    mocks.status.mockReturnValue(new Promise(() => {}));
    mocks.evaluate.mockReturnValue(new Promise(() => {}));
    const result = waitForNavigationReadiness(
      thread,
      "request",
      "tab",
      runtimeTabId,
      "navigate",
      readiness,
      resolveHostWaitBudgetMs(1000),
    ).catch((error) => error);
    await vi.advanceTimersByTimeAsync(800);
    expect(await result).toMatchObject({ _tag: "PreviewAutomationNavigationTimeoutError" });
    expect(Date.now()).toBeLessThan(1000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues normally when a navigation finishes", async () => {
    mocks.status
      .mockResolvedValueOnce({ available: true, loading: true })
      .mockResolvedValueOnce({ available: true, loading: false });
    const result = waitForNavigationReadiness(
      thread,
      "request",
      "tab",
      runtimeTabId,
      "navigate",
      "load",
      800,
    );
    await vi.advanceTimersByTimeAsync(50);
    await expect(result).resolves.toBeUndefined();
    expect(mocks.status).toHaveBeenCalledTimes(2);
  });

  it("does not probe when navigation readiness was not requested", async () => {
    await waitForNavigationReadiness(
      thread,
      "request",
      "tab",
      runtimeTabId,
      "navigate",
      "none",
      800,
    );
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
});
