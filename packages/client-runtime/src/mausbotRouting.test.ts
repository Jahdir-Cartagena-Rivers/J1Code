import { describe, expect, it, vi } from "vitest";
import { callMausbotRouting, type MausbotRoutingHost } from "./mausbotRouting.ts";
import type { ManualRouteStatus } from "@t3tools/contracts";

const args = { botId: "crown", threadId: "main", requestId: "original" };
function fixture() {
  let row: typeof ManualRouteStatus.Type = {
    requestId: "original",
    revision: 1,
    status: "suggested",
    summary: "Updated requirements",
    reason: null,
    destination: {
      environmentId: "owned",
      projectId: "existing-project",
      threadId: "existing-thread",
    },
    delivered: false,
    accepted: false,
    completed: false,
    failed: false,
    uncertain: false,
  };
  const host: MausbotRoutingHost = {
    environmentId: "owned",
    list: vi.fn(async () => [row]),
    prepare: vi.fn(async () => ({ token: "single-use" })),
    confirm: vi.fn(async () => {
      row = { ...row, status: "queued", revision: 2 };
    }),
    open: vi.fn(async () => {}),
    label: () => "Existing conversation",
  };
  return {
    host,
    set: (next: Partial<typeof row>) => {
      row = { ...row, ...next };
    },
  };
}
describe("shared native routing client boundary", () => {
  it("reads a batch for one authenticated source without approving any request", async () => {
    const { host } = fixture();
    expect(
      await callMausbotRouting("routingList", { botId: "crown", threadId: "main" }, host),
    ).toMatchObject([{ requestId: "original", destinationUrl: "/owned/existing-thread" }]);
    expect(host.list).toHaveBeenCalledTimes(1);
    expect(host.prepare).not.toHaveBeenCalled();
    expect(host.confirm).not.toHaveBeenCalled();
  });
  it("returns a source-bound status and original destination link without redeeming approval", async () => {
    const { host } = fixture();
    const result = await callMausbotRouting("routingStatus", args, host);
    expect(result).toMatchObject({
      status: "suggested",
      destinationUrl: "/owned/existing-thread",
      label: "Needs your approval",
    });
    expect(host.list).toHaveBeenCalledWith({
      environmentId: "owned",
      projectId: "mausbot:crown",
      threadId: "mausbot:crown:main",
    });
    expect(host.prepare).not.toHaveBeenCalled();
    expect(host.confirm).not.toHaveBeenCalled();
  });
  it("requires the original source's prepared token and reads the resulting receipt", async () => {
    const { host } = fixture();
    expect(await callMausbotRouting("routingApprove", args, host)).toMatchObject({
      status: "queued",
      delivered: false,
    });
    expect(host.confirm).toHaveBeenCalledWith("single-use");
    expect(host.list).toHaveBeenCalledTimes(2);
  });
  it("rejects a changed request or failed permission check before confirming", async () => {
    const { host, set } = fixture();
    set({ destination: null });
    await expect(callMausbotRouting("routingApprove", args, host)).rejects.toThrow("changed");
    expect(host.prepare).not.toHaveBeenCalled();
    const f = fixture();
    vi.mocked(f.host.prepare).mockRejectedValue(new Error("Permission revoked"));
    await expect(callMausbotRouting("routingApprove", args, f.host)).rejects.toThrow(
      "Permission revoked",
    );
    expect(f.host.confirm).not.toHaveBeenCalled();
  });
  it("rejects injected source/destination overrides and invalid native ids", async () => {
    const { host } = fixture();
    await expect(
      callMausbotRouting("routingApprove", { ...args, environmentId: "foreign" }, host),
    ).rejects.toThrow();
    await expect(
      callMausbotRouting("routingStatus", { ...args, botId: "../other" }, host),
    ).rejects.toThrow();
    expect(host.list).not.toHaveBeenCalled();
  });
  it("opens only the destination returned for the original request", async () => {
    const { host } = fixture();
    expect(await callMausbotRouting("routingOpen", args, host)).toBe(true);
    expect(host.open).toHaveBeenCalledWith({
      environmentId: "owned",
      projectId: "existing-project",
      threadId: "existing-thread",
    });
  });
});
