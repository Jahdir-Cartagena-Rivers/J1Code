import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { scopedThreadKey } from "./environment/scoped.ts";

export const MAX_UNFOLDED_WORKER_CHATS = 4;

type WorkerChat = {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly parentThreadId?: ThreadId | null | undefined;
  readonly createdAt: string;
  readonly archivedAt: string | null;
};

export function workerChatKey(thread: Pick<WorkerChat, "environmentId" | "id">): string {
  return scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id });
}

/** Build once per shell snapshot, rather than scanning every chat for each sidebar row. */
export function createWorkerChatLookup<T extends WorkerChat>() {
  let snapshot: readonly T[] | undefined;
  let byParent = new Map<string, T[]>();
  const empty: readonly T[] = [];
  return (
    threads: readonly T[],
    parent: Pick<WorkerChat, "environmentId" | "id">,
  ): readonly T[] => {
    if (snapshot !== threads) {
      snapshot = threads;
      byParent = new Map();
      for (const thread of threads) {
        if (
          !thread.parentThreadId ||
          thread.parentThreadId === thread.id ||
          thread.archivedAt !== null
        )
          continue;
        const key = workerChatKey({
          environmentId: thread.environmentId,
          id: thread.parentThreadId,
        });
        const siblings = byParent.get(key) ?? [];
        siblings.push(thread);
        byParent.set(key, siblings);
      }
      for (const siblings of byParent.values()) {
        siblings.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      }
    }
    return byParent.get(workerChatKey(parent)) ?? empty;
  };
}

/** Orphans stay reachable when their parent is archived, deleted, or unavailable. */
export function getRootChats<T extends WorkerChat>(threads: readonly T[]): T[] {
  const byKey = new Map(threads.map((thread) => [workerChatKey(thread), thread]));
  return threads.filter((thread) => {
    if (!thread.parentThreadId) return true;
    const seen = new Set([workerChatKey(thread)]);
    let current = thread;
    while (current.parentThreadId) {
      const key = workerChatKey({
        environmentId: current.environmentId,
        id: current.parentThreadId,
      });
      const parent = byKey.get(key);
      if (!parent || parent.archivedAt !== null) return current === thread;
      if (seen.has(key)) return true;
      seen.add(key);
      current = parent;
    }
    return current === thread;
  });
}

export const WorkerChatExpansion = Schema.Struct({
  folded: Schema.Boolean,
  knownIds: Schema.Array(Schema.String),
  // Oldest unfold first, so a new worker replaces the oldest visible worker.
  unfoldedIds: Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_UNFOLDED_WORKER_CHATS)),
});
export type WorkerChatExpansion = typeof WorkerChatExpansion.Type;

export function reconcileWorkerChatExpansion(
  previous: WorkerChatExpansion | undefined,
  orderedIds: readonly string[],
): WorkerChatExpansion {
  if (!previous) {
    return {
      folded: false,
      knownIds: orderedIds,
      unfoldedIds: orderedIds.slice(-MAX_UNFOLDED_WORKER_CHATS),
    };
  }
  if (
    orderedIds.length === previous.knownIds.length &&
    orderedIds.every((id, index) => id === previous.knownIds[index])
  )
    return previous;
  const available = new Set(orderedIds);
  const known = new Set(previous.knownIds);
  return {
    folded: previous.folded,
    knownIds: orderedIds,
    unfoldedIds: [
      ...previous.unfoldedIds.filter((id) => available.has(id)),
      ...orderedIds.filter((id) => !known.has(id)),
    ].slice(-MAX_UNFOLDED_WORKER_CHATS),
  };
}

export function unfoldWorkerChat(state: WorkerChatExpansion, id: string): WorkerChatExpansion {
  if (!state.knownIds.includes(id)) return state;
  return {
    ...state,
    folded: false,
    unfoldedIds: [...state.unfoldedIds.filter((entry) => entry !== id), id].slice(
      -MAX_UNFOLDED_WORKER_CHATS,
    ),
  };
}

export function foldWorkerChat(state: WorkerChatExpansion, id: string): WorkerChatExpansion {
  return { ...state, unfoldedIds: state.unfoldedIds.filter((entry) => entry !== id) };
}

export function toggleWorkerChats(state: WorkerChatExpansion): WorkerChatExpansion {
  return {
    ...state,
    folded: !state.folded,
    unfoldedIds:
      state.unfoldedIds.length > 0
        ? state.unfoldedIds
        : state.knownIds.slice(-MAX_UNFOLDED_WORKER_CHATS),
  };
}
