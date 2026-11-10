import { describe, expect, it, vi } from "vite-plus/test";
import { DeepAIRequestError, makeDeepAIClient } from "./DeepAIClient.ts";

const model = {
  id: "pilot",
  name: "Pilot",
  reasoning: true,
  input: ["text"],
  contextWindow: 4096,
  maxTokens: 1024,
};
const signal = () => new AbortController().signal;

describe("DeepAI wire boundary", () => {
  it("discovers the current catalog without sending an account credential", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ models: [model], default: "pilot" }),
    );
    const client = makeDeepAIClient({ request });
    expect((await client.models(signal())).models[0]).toEqual(model);
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("https://api.deepai.org/deepai_code/models");
    expect(new Headers(init?.headers).get("api-key")).toBeNull();
    expect(new Headers(init?.headers).get("X-DeepAI-Code-Theos")).toBe("4");
    expect(init?.redirect).toBe("error");
  });

  it.each([
    { models: [], default: "pilot" },
    { models: [model, model], default: "pilot" },
    { models: [model], default: "missing" },
    { models: [{ ...model, maxTokens: 8192 }], default: "pilot" },
    { models: [{ ...model, input: ["image"] }], default: "pilot" },
  ])("rejects inconsistent catalog %j", async (catalog) => {
    const client = makeDeepAIClient({ request: async () => Response.json(catalog) });
    await expect(client.models(signal())).rejects.toThrow("Invalid DeepAI model catalog");
  });

  it.each([401, 402, 429, 503])(
    "preserves HTTP %i without exposing the upstream body",
    async (status) => {
      const client = makeDeepAIClient({
        request: async () =>
          Response.json(
            { error: "secret-and-prompt" },
            { status, headers: { "retry-after": "8" } },
          ),
      });
      const error = await client
        .allowance("private-key", signal())
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(DeepAIRequestError);
      expect(error).toMatchObject({ status, retryAfter: "8" });
      expect(String(error)).not.toContain("secret-and-prompt");
      expect(String(error)).not.toContain("private-key");
    },
  );

  it("passes both API formats and the original stream through without buffering", async () => {
    for (const api of ["openai-completions", "openai-responses"] as const) {
      const response = new Response("data: [DONE]\n\n");
      const request = vi.fn<typeof fetch>(async (url) =>
        String(url).endsWith("/theos") ? Response.json({ enabled: true }) : response,
      );
      const client = makeDeepAIClient({ request });
      const body = { model: "pilot", stream: true };
      const controller = new AbortController();
      expect(
        await client.completion({ apiKey: "private-key", api, body, signal: controller.signal }),
      ).toBe(response);
      const [url, init] = request.mock.calls.at(-1)!;
      expect(
        String(url).endsWith(api === "openai-responses" ? "/responses" : "/chat/completions"),
      ).toBe(true);
      expect(init?.body).toBe(JSON.stringify(body));
      expect(init?.signal).toBe(controller.signal);
    }
  });

  it("shares a host identity across clients and renews the check-in nonce instead of restarting it", async () => {
    let now = 100000;

    {
      const request = vi.fn<typeof fetch>(async () =>
        Response.json({ enabled: true, check_in: { nonce: "a".repeat(32), seconds: 60 } }),
      );
      const client = makeDeepAIClient({ request, machineDigest: "b".repeat(64), now: () => now });
      await Promise.all([client.allowance("key", signal()), client.allowance("key", signal())]);
      expect(request).toHaveBeenCalledTimes(1);
      now += 31000;
      await client.allowance("key", signal());
      const first = new Headers(request.mock.calls[0]![1]?.headers);
      const renewed = new Headers(request.mock.calls[1]![1]?.headers);
      expect(first.get("X-DeepAI-Code-Machine")).toBe("b".repeat(64));
      expect(renewed.get("X-DeepAI-Code-Check-In")).toBe("a".repeat(32));
      const other = makeDeepAIClient({ request });
      await other.models(signal()).catch(() => {});
      expect(
        new Headers(request.mock.calls.at(-1)![1]?.headers).get("X-DeepAI-Code-Instance"),
      ).toBe(first.get("X-DeepAI-Code-Instance"));
    }
  });

  it("reports check-in refusals without relabeling them as sign-in or exposing server messages", async () => {
    const client = makeDeepAIClient({
      request: async () =>
        Response.json(
          {
            error: {
              code: "check_in_refused",
              message: "private-key",
            },
          },
          { status: 403 },
        ),
    });
    await expect(client.allowance("key", signal())).rejects.toThrow("connection check-in");
    await expect(client.allowance("key", signal())).rejects.not.toThrow("private-key");
  });

  it("propagates cancellation instead of retrying a cancelled generation", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      init?.signal?.throwIfAborted();
      throw new Error("unreachable");
    });
    const client = makeDeepAIClient({ request });
    await expect(
      client.completion({
        apiKey: "key",
        api: "openai-completions",
        body: {},
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
