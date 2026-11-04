import { it, expect } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import { verifyNativeHash, validatePackagedLightpanda } from "./stage-lightpanda.ts";
it("rejects damaged artifact bytes", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  expect(() => verifyNativeHash(bytes, hash)).not.toThrow();
  expect(() => verifyNativeHash(new Uint8Array([1, 2, 4]), hash)).toThrow("integrity");
});
it("rejects missing packaged browser and notices", async () => {
  await expect(validatePackagedLightpanda("missing-browser-fixture")).rejects.toThrow();
});
