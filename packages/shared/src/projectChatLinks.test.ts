import { describe, expect, it } from "vitest";
import { parseProjectChatLink } from "./projectChatLinks";

describe("project handoff links", () => {
  const threadId = `j1-handoff-${"a".repeat(32)}`;
  it("opens the same thread independently of browser origin", () => {
    expect(parseProjectChatLink(`/my%3Aserver/${threadId}`)).toEqual({
      environmentId: "my:server",
      threadId,
    });
  });
  it("leaves file paths and external or malformed destinations alone", () => {
    for (const href of [
      "/src/index.ts",
      `https://example.com/env/${threadId}`,
      `/a%2fb/${threadId}`,
      `/%zz/${threadId}`,
      `/env/${threadId}?token=x`,
    ]) {
      expect(parseProjectChatLink(href)).toBeNull();
    }
  });
});
