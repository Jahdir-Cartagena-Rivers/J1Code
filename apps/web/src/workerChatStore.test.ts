import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createJSONStorage } from "zustand/middleware";
import {
  reconcileWorkerChatExpansion,
  toggleWorkerChats,
  unfoldWorkerChat,
} from "@t3tools/client-runtime/worker-chats";
import { createMemoryStorage } from "./lib/storage";
import { useWorkerChatStore } from "./workerChatStore";

const storage = createMemoryStorage();
beforeEach(() => {
  useWorkerChatStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
  useWorkerChatStore.setState({ byParentKey: {} });
});

describe("worker chat presentation persistence", () => {
  it("ignores malformed saved selections and selections exceeding the four-chat cap", async () => {
    for (const invalid of [
      { folded: false, unfoldedIds: ["1"] },
      {
        folded: false,
        knownIds: ["1", "2", "3", "4", "5"],
        unfoldedIds: ["1", "2", "3", "4", "5"],
      },
    ]) {
      storage.setItem(
        "j1:worker-chats:v1",
        JSON.stringify({ state: { byParentKey: { "local:parent": invalid } }, version: 0 }),
      );
      await useWorkerChatStore.persist.rehydrate();
      expect(useWorkerChatStore.getState().byParentKey).toEqual({});
    }
  });

  it("restores folded parents and selections independently across environments", async () => {
    const state = reconcileWorkerChatExpansion(undefined, ["1", "2", "3", "4", "5"]);
    const local = "local:parent";
    const remote = "remote:parent";
    useWorkerChatStore.getState().setExpansion(local, toggleWorkerChats(state));
    useWorkerChatStore.getState().setExpansion(remote, unfoldWorkerChat(state, "1"));
    const saved = await storage.getItem("j1:worker-chats:v1");
    useWorkerChatStore.setState({ byParentKey: {} });
    storage.setItem("j1:worker-chats:v1", saved!);
    await useWorkerChatStore.persist.rehydrate();
    expect(useWorkerChatStore.getState().byParentKey[local]).toMatchObject({
      folded: true,
      unfoldedIds: ["2", "3", "4", "5"],
    });
    expect(useWorkerChatStore.getState().byParentKey[remote]).toMatchObject({
      folded: false,
      unfoldedIds: ["3", "4", "5", "1"],
    });
  });
});
