import { expect, it } from "vite-plus/test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { recoverDeepAIImageHistory } from "./DeepAIImageHistory.ts";
const oldImage = {
  role: "user",
  content: [{ type: "image", data: "old", mimeType: "image/png" }],
  timestamp: 0,
} satisfies AgentSession["messages"][number];
const failure = {
  role: "assistant",
  content: [],
  api: "openai-completions",
  provider: "deepai",
  model: "fixture",
  stopReason: "error",
  errorMessage: "multimodal processing is not enabled",
  timestamp: 1,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
} satisfies AgentSession["messages"][number];
it("recovers later text turns from rejected image history without changing stored messages", () => {
  const text = {
    role: "user",
    content: "Hello",
    timestamp: 2,
  } satisfies AgentSession["messages"][number];
  const messages = [oldImage, failure, text];
  const original = JSON.stringify(messages);
  const recovered = recoverDeepAIImageHistory(messages);
  expect(recovered[0]).toMatchObject({ content: [{ type: "text" }] });
  expect(recovered[2]).toBe(text);
  expect(JSON.stringify(messages)).toBe(original);
});
it("keeps new image attempts and unrelated chats intact", () => {
  const fresh = { ...oldImage, timestamp: 3 };
  expect(recoverDeepAIImageHistory([oldImage, failure, fresh])[2]).toBe(fresh);
  const other = [oldImage];
  expect(recoverDeepAIImageHistory(other)).toBe(other);
  expect(
    recoverDeepAIImageHistory([oldImage, { ...failure, errorMessage: "network failure" }])[0],
  ).toBe(oldImage);
});
