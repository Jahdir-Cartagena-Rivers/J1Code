import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ManualRoutePrepareInput, ManualRouteConfirmInput } from "./manualRouting.ts";

const endpoint = { environmentId: "e", projectId: "p", threadId: "t" };
const decode = Schema.decodeUnknownSync(ManualRoutePrepareInput, { onExcessProperty: "error" });
const decodeConfirm = Schema.decodeUnknownSync(ManualRouteConfirmInput, {
  onExcessProperty: "error",
});
describe("manual routing wire inputs", () => {
  it("accepts an explicit destination selection", () => {
    expect(decode({ requestId: "r", source: endpoint, destination: endpoint }).requestId).toBe("r");
  });
  it.each(["authenticatedUser", "userId", "permissions", "sessionId", "revision"])(
    "rejects caller supplied authority %s",
    (field) => {
      expect(() =>
        decode({ requestId: "r", source: endpoint, destination: endpoint, [field]: "forged" }),
      ).toThrow();
    },
  );
  it("rejects missing destinations, empty IDs and direct confirmation authority", () => {
    expect(() => decode({ requestId: "r", source: endpoint })).toThrow();
    expect(() => decode({ requestId: "", source: endpoint, destination: endpoint })).toThrow();
    expect(() =>
      decodeConfirm({
        token: "x",
        authenticatedUser: true,
      }),
    ).toThrow();
  });
});
