// @effect-diagnostics globalFetch:off - this native loopback fixture exercises the child-facing HTTP contract.
import { describe, expect, it, vi } from "vite-plus/test";
import { makeDeepAIClient } from "../provider/deepai/DeepAIClient.ts";
import { startDeepAIBridge } from "./DeepAIBridge.ts";

const plain = {
  id: "chat",
  name: "Chat",
  reasoning: false,
  input: ["text"],
  contextWindow: 4096,
  maxTokens: 512,
} as const;
const responses = { ...plain, id: "responses", api: "openai-responses" as const };

describe("Mausbot DeepAI bridge", () => {
  it("keeps the account credential in the parent while proxying an allowed streaming chat model", async () => {
    const request = vi.fn<typeof fetch>(async (url, init) => {
      expect(new Headers(init?.headers).get("api-key")).toBe("parent-only-secret");
      if (String(url).endsWith("/theos")) return Response.json({ enabled: true });
      return new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const bridge = await startDeepAIBridge({
      credentials: async () => "parent-only-secret",
      catalog: async () => ({ models: [plain, responses], default: plain.id }),
      client: makeDeepAIClient({ request }),
    });
    try {
      const models = await fetch(`${bridge.baseUrl}/models`, {
        headers: { authorization: `Bearer ${bridge.token}` },
      });
      expect(await models.json()).toEqual({
        object: "list",
        data: [{ id: "chat", object: "model", created: 0, owned_by: "deepai" }],
      });
      expect(models.headers.get("cache-control")).toBe("no-store");
      const reply = await fetch(`${bridge.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "chat",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      const replyText = await reply.text();
      expect(reply.status).toBe(200);
      expect(replyText).not.toContain("parent-only-secret");
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      await Promise.all([bridge.close(), bridge.close()]);
    }
  });

  it("rejects missing capabilities and responses-only models without contacting DeepAI", async () => {
    const request = vi.fn<typeof fetch>();
    const bridge = await startDeepAIBridge({
      credentials: async () => "parent-only-secret",
      catalog: async () => ({ models: [plain, responses], default: plain.id }),
      client: makeDeepAIClient({ request }),
    });
    try {
      expect((await fetch(`${bridge.baseUrl}/models`)).status).toBe(401);
      expect(
        (
          await fetch(`${bridge.baseUrl}/models`, {
            headers: {
              authorization: `Bearer ${bridge.token}`,
              origin: "https://untrusted.example",
            },
          })
        ).status,
      ).toBe(403);
      const forbidden = await fetch(`${bridge.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "responses", messages: [] }),
      });
      expect(forbidden.status).toBe(400);
      expect(await forbidden.text()).not.toContain("parent-only-secret");
      expect(request).not.toHaveBeenCalled();
    } finally {
      await bridge.close();
    }
  });
});
