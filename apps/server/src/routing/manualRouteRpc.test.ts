import { describe, expect, it } from "vite-plus/test";
import { makeManualRouteRpc } from "./manualRouteRpc.ts";

describe("manual route RPC unavailable integration", () => {
  it("fails closed for every action without a trusted connection boundary", async () => {
    const rpc = makeManualRouteRpc(null);
    for (const action of [rpc.prepare, rpc.confirm, rpc.status]) {
      await expect(
        action({ authenticatedUser: true, permissions: ["admin"] }),
      ).rejects.toMatchObject({
        _tag: "ManualRouteActionError",
        code: "unavailable",
      });
    }
  });
});
