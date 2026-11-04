import { expect, it } from "vite-plus/test";
import { rankWorkingChats } from "./workingChatSuggestion.ts";
it("prefers related work over an unrelated busy chat", () => {
  expect(
    rankWorkingChats("Improve audio transcription", [
      { thread_id: "audio", title: "Improve Audio Transcription", status: "ready" },
      { thread_id: "other", title: "Credential storage", status: "running" },
    ]),
  ).toBe("audio");
});
it("suggests an active chat when topic evidence is weak, and never arbitrarily selects idle unrelated work", () => {
  expect(
    rankWorkingChats("Include this", [
      { thread_id: "active", title: "Build coordination", status: "running" },
    ]),
  ).toBe("active");
  expect(
    rankWorkingChats("Unrelated request", [
      { thread_id: "idle", title: "Credential storage", status: "ready" },
    ]),
  ).toBeNull();
});
