import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  foldWorkerChat,
  getRootChats,
  createWorkerChatLookup,
  reconcileWorkerChatExpansion,
  toggleWorkerChats,
  unfoldWorkerChat,
  workerChatKey,
} from "./workerChats.ts";

const local = EnvironmentId.make("local");
function chat(id: string, parent?: string, environmentId = local) {
  return {
    id: ThreadId.make(id),
    environmentId,
    parentThreadId: parent ? ThreadId.make(parent) : null,
    createdAt: `2026-10-02T00:00:0${id.at(-1)}Z`,
    archivedAt: null as string | null,
  };
}

const getWorkerChats = createWorkerChatLookup<ReturnType<typeof chat>>();

describe("saved worker chat navigation", () => {
  it("groups direct children by parent and environment in spawn order", () => {
    const parent = chat("parent0");
    const threads = [
      parent,
      chat("child2", parent.id),
      chat("child1", parent.id),
      chat("grandchild3", "child1"),
      chat("remote1", parent.id, EnvironmentId.make("remote")),
    ];
    expect(getWorkerChats(threads, parent).map((thread) => thread.id)).toEqual([
      "child1",
      "child2",
    ]);
    expect(getRootChats(threads).map((thread) => thread.id)).toEqual(["parent0", "remote1"]);
  });

  it("keeps orphaned workers reachable and never drops an invalid cycle", () => {
    const parent = { ...chat("parent0"), archivedAt: "2026-10-02T01:00:00Z" };
    expect(
      getRootChats([parent, chat("child1", parent.id), chat("missing2", "deleted")]).map(
        (thread) => thread.id,
      ),
    ).toEqual(["parent0", "child1", "missing2"]);
    expect(getRootChats([chat("cycle1", "cycle2"), chat("cycle2", "cycle1")])).toHaveLength(2);
    expect(workerChatKey(chat("same1"))).not.toBe(
      workerChatKey(chat("same1", undefined, EnvironmentId.make("remote"))),
    );
  });

  it("starts with the newest four, then a fifth worker replaces the oldest visible chat", () => {
    const before = reconcileWorkerChatExpansion(undefined, ["1", "2", "3", "4"]);
    const after = reconcileWorkerChatExpansion(before, ["1", "2", "3", "4", "5"]);
    expect(after.unfoldedIds).toEqual(["2", "3", "4", "5"]);
    expect(after.knownIds).toEqual(["1", "2", "3", "4", "5"]);
    expect(reconcileWorkerChatExpansion(undefined, after.knownIds).unfoldedIds).toEqual(
      after.unfoldedIds,
    );
    expect(reconcileWorkerChatExpansion(after, after.knownIds)).toBe(after);
  });

  it("folds one worker without filling its slot, and can unfold an older worker at the cap", () => {
    const initial = reconcileWorkerChatExpansion(undefined, ["1", "2", "3", "4", "5"]);
    const folded = foldWorkerChat(initial, "3");
    expect(reconcileWorkerChatExpansion(folded, initial.knownIds).unfoldedIds).toEqual([
      "2",
      "4",
      "5",
    ]);
    const reopened = unfoldWorkerChat(initial, "1");
    expect(reopened.unfoldedIds).toEqual(["3", "4", "5", "1"]);
    expect(unfoldWorkerChat(reopened, "missing")).toBe(reopened);
    expect(
      reconcileWorkerChatExpansion(reopened, ["1", "2", "3", "4", "5", "6"]).unfoldedIds,
    ).toEqual(["4", "5", "1", "6"]);
  });

  it("preserves a folded parent across new spawns and reload, then reopens its selection", () => {
    const initial = reconcileWorkerChatExpansion(undefined, ["1", "2", "3", "4"]);
    const folded = toggleWorkerChats(initial);
    const next = reconcileWorkerChatExpansion(JSON.parse(JSON.stringify(folded)), [
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(next.folded).toBe(true);
    expect(toggleWorkerChats(next)).toMatchObject({
      folded: false,
      unfoldedIds: ["2", "3", "4", "5"],
    });
    const allFolded = initial.unfoldedIds.reduce(foldWorkerChat, initial);
    expect(toggleWorkerChats({ ...allFolded, folded: true }).unfoldedIds).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
  });

  it("drops archived or deleted workers from the visible selection", () => {
    const initial = reconcileWorkerChatExpansion(undefined, ["1", "2", "3", "4"]);
    expect(reconcileWorkerChatExpansion(initial, ["1", "3", "4"]).unfoldedIds).toEqual([
      "1",
      "3",
      "4",
    ]);
    expect(
      getWorkerChats(
        [chat("parent0"), { ...chat("child1", "parent0"), archivedAt: "2026-10-02T01:00:00Z" }],
        chat("parent0"),
      ),
    ).toEqual([]);
  });
});
