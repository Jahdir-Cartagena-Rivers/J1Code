import { expect, it } from "vite-plus/test";
import { isDevProxiedPath } from "./devProxy.ts";

it("serves the native Dot page in Vite while preserving the MCP, OAuth and API neighbors", () => {
  expect(isDevProxiedPath("/dot")).toBe(false);
  expect(isDevProxiedPath("/dot/settings")).toBe(false);
  for (const path of [
    "/dot/mcp",
    "/oauth/dot/token",
    "/.well-known/oauth-protected-resource/dot/mcp",
    "/api/dot/chat",
    "/ws",
  ])
    expect(isDevProxiedPath(path)).toBe(true);
});
