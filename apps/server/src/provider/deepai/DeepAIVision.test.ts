import { expect, it, vi } from "vite-plus/test";
import { makeDeepAIVision } from "./DeepAIVision.ts";
it("sends images and the question to the configured vision model with explicit attribution", async () => {
  const request = vi.fn(async () =>
    Response.json({ message: { content: "A red square is left of a blue circle." } }),
  );
  const describe = makeDeepAIVision({
    endpoint: "http://127.0.0.1:11434",
    model: "local-vision",
    request,
  });
  expect(await describe("Which object is left?", [{ data: "aW1hZ2U=" }])).toContain(
    "vision model local-vision",
  );
  const init = request.mock.calls[0] as unknown as [URL, RequestInit];
  const payload = JSON.parse(String(init[1].body));
  expect(payload.messages[0].images).toEqual(["aW1hZ2U="]);
  expect(payload.messages[0].content).toContain("Which object is left?");
  expect(payload.think).toBe(false);
});
it("rejects failed, empty and malformed reports instead of sending a text-only turn", async () => {
  for (const reply of [
    new Response(null, { status: 503 }),
    Response.json({ message: { content: " " } }),
    Response.json({ message: {} }),
  ]) {
    await expect(
      makeDeepAIVision({
        endpoint: "http://localhost:11434",
        model: "fixture",
        request: async () => reply,
      })("Inspect", [{ data: "fixture" }]),
    ).rejects.toThrow();
  }
});
