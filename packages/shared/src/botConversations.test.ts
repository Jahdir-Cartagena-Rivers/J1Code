import { expect, it } from "vite-plus/test";
import { latestBotConversation } from "./botConversations.ts";

it("opens the latest active regular conversation for the selected bot and environment", () => {
  const thread = (id: string, updatedAt: string, overrides = {}) => ({
    id,
    updatedAt,
    environmentId: "local",
    bot: { id: "garden" },
    archivedAt: null,
    ...overrides,
  });
  const threads = [
    thread("older", "2026-01-01"),
    thread("latest", "2026-01-02"),
    thread("bot-routine:abc", "2026-01-08"),
    thread("archived", "2026-01-09", { archivedAt: "2026-01-10" }),
    thread("other-env", "2026-01-10", { environmentId: "remote" }),
    thread("other-bot", "2026-01-11", { bot: { id: "other" } }),
  ];
  expect(latestBotConversation(threads, "local", "garden")?.id).toBe("latest");
  expect(latestBotConversation([threads[2]!], "local", "garden")).toBeUndefined();
});
