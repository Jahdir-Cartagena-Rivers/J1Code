import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeMausbotConversationSource } from "./MausbotConversationSource.ts";

const endpoint = { environmentId: "local", projectId: "mausbot:one", threadId: "mausbot:one:main" };
const principal = { kind: "j1", environmentId: "local", threadId: "source" } as const;
const metadata = {
  endpoint,
  title: "Original",
  url: "/assistants?botId=one&conversation=main",
  runtimeMode: "approval-required",
  providerInstanceId: "codex",
  activeTurnId: null,
  approvalPending: false,
  inputPending: false,
};
describe("native conversation response boundary", () => {
  it.effect("rejects another conversation's page and malformed runtime output", () =>
    Effect.gen(function* () {
      const wrong = makeMausbotConversationSource("local", () =>
        Effect.succeed({
          conversation: { ...metadata, endpoint: { ...endpoint, threadId: "mausbot:one:other" } },
          messages: [],
          nextCursor: null,
          textTruncated: false,
        }),
      );
      expect(yield* wrong.read(principal, endpoint).pipe(Effect.flip)).toBe(
        "Conversation source is unavailable.",
      );
      const malformed = makeMausbotConversationSource("local", () =>
        Effect.succeed({ messages: [] }),
      );
      expect(yield* malformed.read(principal, endpoint).pipe(Effect.flip)).toBe(
        "Conversation source is unavailable.",
      );
    }),
  );
  it.effect("rejects mismatched message ids and offsets", () =>
    Effect.gen(function* () {
      const source = makeMausbotConversationSource("local", () =>
        Effect.succeed({
          id: "other",
          role: "assistant",
          text: "Wrong message",
          offset: 0,
          nextOffset: null,
        }),
      );
      expect(yield* source.readMessage(principal, endpoint, "expected", 0).pipe(Effect.flip)).toBe(
        "Conversation source is unavailable.",
      );
      expect(yield* source.readMessage(principal, endpoint, "other", 8_000).pipe(Effect.flip)).toBe(
        "Conversation source is unavailable.",
      );
    }),
  );
});
