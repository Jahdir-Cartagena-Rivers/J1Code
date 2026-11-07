import { describe, expect, it } from "vite-plus/test";
import type { LightpandaPool } from "../mcp/LightpandaProcess.ts";
import { MausbotLightpandaAdapter } from "./LightpandaAdapter.ts";

function fixture() {
  const calls: Array<{ session: string; method: string; params: unknown }> = [];
  const pages = new Set<string>();
  const pool: Pick<LightpandaPool, "request" | "requestExisting" | "close"> = {
    request: async (session, _executable, method, params) => {
      pages.add(session);
      calls.push({ session, method, params });
      if (method === "tools/list")
        return {
          tools: ["goto", "tree", "fill", "getEnv"].map((name) => ({ name, inputSchema: {} })),
        };
      return { content: [{ type: "text", text: "shared page" }] };
    },
    requestExisting: async (session, method, params) => {
      if (!pages.has(session)) throw new Error("not running");
      calls.push({ session, method, params });
      return "existing page";
    },
    close: (session) => pages.delete(session),
  };
  return { calls, adapter: new MausbotLightpandaAdapter(pool, "native-browser") };
}

describe("Mausbot's J1 browser boundary", () => {
  it("exposes only supported aliases and never environment or arbitrary engine tools", async () => {
    const { adapter } = fixture();
    expect(await adapter.request("runtime", "chat", "tools/list", {})).toEqual({
      tools: ["agent_browser_open", "agent_browser_snapshot", "agent_browser_fill"].map((name) => ({
        name,
        inputSchema: {},
      })),
    });
  });

  it("keeps viewer and agent on one page, with separate identities across runtime and chat", async () => {
    const { adapter, calls } = fixture();
    await expect(adapter.view("r", "c", "tools/call", {})).rejects.toThrow("not running");
    await adapter.request("r", "c", "tools/call", {
      name: "agent_browser_open",
      arguments: { url: "https://example.test" },
    });
    expect(calls.map((call) => call.params)).toEqual([
      { name: "goto", arguments: { url: "https://example.test" } },
      { name: "tree", arguments: { maxBytes: 16_000 } },
    ]);
    await adapter.view("r", "c", "tools/call", {});
    expect(new Set(calls.map((call) => call.session)).size).toBe(1);
    expect(adapter.sessionId("r2", "c")).not.toBe(adapter.sessionId("r", "c"));
    expect(adapter.sessionId("r", "c2")).not.toBe(adapter.sessionId("r", "c"));
    adapter.close("r", "c");
    await expect(adapter.view("r", "c", "tools/call", {})).rejects.toThrow("not running");
  });

  it("rejects unknown or prototype-named tools without executing another browser", async () => {
    const { adapter, calls } = fixture();
    for (const name of ["agent_browser_upload", "__proto__", "constructor"])
      expect(await adapter.request("r", "c", "tools/call", { name, arguments: {} })).toMatchObject({
        isError: true,
      });
    expect(calls).toEqual([]);
  });

  it("prevents incidental navigation through reads and filesystem writes through screenshots", async () => {
    const { adapter, calls } = fixture();
    await adapter.request("r", "c", "tools/call", {
      name: "agent_browser_read",
      arguments: { url: "https://other.test", selector: "main" },
    });
    await adapter.request("r", "c", "tools/call", {
      name: "agent_browser_screenshot",
      arguments: { path: "output.png" },
    });
    expect(calls.map((call) => call.params)).toEqual([
      { name: "markdown", arguments: { selector: "main" } },
      { name: "screenshot", arguments: {} },
    ]);
  });
});
