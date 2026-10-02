import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { callbackUrl, isPublicCallbackAddress, signature, signingKey } from "./DotChatWebhook.ts";

describe("native Dot callback boundaries", () => {
  it("permits public OpenAI addresses without treating all IPv4 as mapped private IPv6", () => {
    for (const [address, family] of [
      ["172.64.149.72", 4],
      ["104.18.38.184", 4],
      ["::ffff:104.18.38.184", 6],
      ["2606:4700::1111", 6],
    ] as const)
      expect(isPublicCallbackAddress(address, family)).toBe(true);
    for (const [address, family] of [
      ["127.0.0.1", 4],
      ["10.1.2.3", 4],
      ["172.16.3.2", 4],
      ["100.64.5.4", 4],
      ["169.254.1.1", 4],
      ["192.0.2.1", 4],
      ["198.18.1.1", 4],
      ["::1", 6],
      ["::ffff:10.1.2.3", 6],
      ["::10.1.2.3", 6],
      ["100::1", 6],
      ["fec0::1", 6],
      ["2001:2::1", 6],
      ["not-an-ip", 4],
      ["fc00::1", 6],
      ["2001:db8::1", 6],
    ] as const)
      expect(isPublicCallbackAddress(address, family)).toBe(false);
  });
  it("requires the actual public ChatGPT callback origin", () => {
    expect(callbackUrl("https://connectors.api.openai.com/mcp-events/callback").hostname).toBe(
      "connectors.api.openai.com",
    );
    for (const value of [
      "http://connectors.api.openai.com/cb",
      "https://openai.com.evil.test/cb",
      "https://user:password@openai.com/cb",
      "https://127.0.0.1/cb",
      "https://openai.com:8443/cb",
    ])
      expect(() => callbackUrl(value)).toThrow();
  });
  it("signs the exact event bytes with Standard Webhooks HMAC", () => {
    const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    const secret = `whsec_${key.toString("base64")}`;
    const body = '{"eventId":"message-1","data":{"text":"hello"}}';
    const expected = NodeCrypto.createHmac("sha256", key)
      .update(`message-1.1790981639.${body}`)
      .digest("base64");
    expect(signature(secret, "message-1", "1790981639", body)).toBe(`v1,${expected}`);
    expect(signature(secret, "message-1", "1790981639", body + " ")).not.toBe(`v1,${expected}`);
    expect(() => signingKey("whsec_YQ==")).toThrow();
  });
});
