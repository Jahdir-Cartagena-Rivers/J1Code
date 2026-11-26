import {
  EnvironmentId,
  OrchestrationV2ThreadShellJson,
  ThreadId,
  DEFAULT_CLIENT_SETTINGS,
} from "@j1code/contracts";
import { scopeThreadShell, type EnvironmentThreadShell } from "@j1code/client-runtime/state/models";
import { useSyncExternalStore } from "react";
import * as Schema from "effect/Schema";
import { act, render } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    threads: [] as EnvironmentThreadShell[],
    enabled: true,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify: () => {
      for (const listener of listeners) listener();
    },
  };
});
vi.mock("~/state/entities", async () => ({
  useThreadShells: () => useSyncExternalStore(fixture.subscribe, () => fixture.threads),
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector({
      ...DEFAULT_CLIENT_SETTINGS,
      workerChatsInSidebar: useSyncExternalStore(fixture.subscribe, () => fixture.enabled),
    }),
}));
vi.mock("~/uiStateStore", () => ({
  useUiStateStore: (
    selector: (state: { threadLastVisitedAtById: Record<string, string> }) => unknown,
  ) => selector({ threadLastVisitedAtById: {} }),
}));
vi.mock("./ui/sidebar", () => ({ useSidebar: () => ({ setOpenMobile: () => {} }) }));
vi.mock("./Sidebar.logic", () => ({ resolveThreadStatusPill: () => null }));

import { getProjectRootChats, WorkerChatsInChat, WorkerChatTree } from "./WorkerChats";
import { useWorkerChatStore } from "~/workerChatStore";

const parent = { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("parent") };
const decodeThreadShell = Schema.decodeUnknownSync(OrchestrationV2ThreadShellJson);
function worker(number: number): EnvironmentThreadShell {
  return scopeThreadShell(
    parent.environmentId,
    decodeThreadShell({
      id: `worker${number}`,
      projectId: "project",
      title: `Worker: task ${number}`,
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "test" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      lineage: {
        rootThreadId: parent.threadId,
        parentThreadId: parent.threadId,
        relationshipToParent: "subagent",
      },
      forkedFrom: null,
      activeProviderThreadId: null,
      createdBy: "user",
      creationSource: "web",
      latestRunId: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      createdAt: `2026-10-02T00:00:0${number}Z`,
      updatedAt: `2026-10-02T00:00:0${number}Z`,
    }),
  );
}

function Surface() {
  return (
    <>
      <aside>
        <WorkerChatTree parent={parent} />
      </aside>
      <main>
        <WorkerChatsInChat parent={parent} />
      </main>
    </>
  );
}

it("does not duplicate bot conversations in lazy project rows and keeps their saved provider workers reachable", () => {
  const bot = {
    ...worker(1),
    id: ThreadId.make("j1-mausbot:bot:thread"),
    lineage: { ...worker(1).lineage, parentThreadId: null },
  };
  const child = { ...worker(2), lineage: { ...worker(2).lineage, parentThreadId: bot.id } };
  const normal = { ...worker(3), lineage: { ...worker(3).lineage, parentThreadId: null } };
  expect(getProjectRootChats([bot, child, normal]).map((thread) => thread.id)).toEqual([
    child.id,
    normal.id,
  ]);
});
let container: HTMLElement;
function visibleTitles() {
  return [...container.querySelectorAll("aside a")].map((link) => link.getAttribute("aria-label"));
}
function button(label: string) {
  const target = [...container.querySelectorAll("button")].find(
    (entry) => entry.getAttribute("aria-label") === label,
  );
  expect(target, `button ${label}`).toBeDefined();
  return target!;
}

function resetFixture() {
  fixture.threads = [1, 2, 3, 4, 5].map(worker);
  fixture.enabled = true;
  useWorkerChatStore.setState({ byParentKey: {} });
}

describe("worker chat folding controls", () => {
  it("folds and reopens old workers from the parent while keeping the four-chat limit", async () => {
    resetFixture();
    await using screen = await render(<Surface />);
    container = screen.container;
    expect(visibleTitles()).toEqual([
      "Worker: task 2",
      "Worker: task 3",
      "Worker: task 4",
      "Worker: task 5",
    ]);
    expect(container.querySelectorAll("main a")).toHaveLength(5);
    await act(() => button("Fold Worker: task 3 into parent chat").click());
    expect(visibleTitles()).toEqual(["Worker: task 2", "Worker: task 4", "Worker: task 5"]);
    await act(() => button("Unfold Worker: task 1 in sidebar").click());
    expect(visibleTitles()).toEqual([
      "Worker: task 1",
      "Worker: task 2",
      "Worker: task 4",
      "Worker: task 5",
    ]);
    fixture.threads = [...fixture.threads, worker(6)];
    await act(() => fixture.notify());
    await screen.rerender(<Surface />);
    expect(visibleTitles()).toEqual([
      "Worker: task 1",
      "Worker: task 4",
      "Worker: task 5",
      "Worker: task 6",
    ]);
    expect(container.querySelectorAll("main a")).toHaveLength(6);
    await act(() => button("Fold worker chats").click());
    expect(visibleTitles()).toEqual([]);
    await act(() => fixture.notify());
    await screen.rerender(<Surface />);
    expect(visibleTitles()).toEqual([]);
    await act(() => button("Unfold worker chats").click());
    expect(visibleTitles()).toHaveLength(4);
  });

  it("keeps every worker accessible inside its parent when sidebar folding is disabled", async () => {
    resetFixture();
    await using screen = await render(<Surface />);
    container = screen.container;
    fixture.enabled = false;
    await act(() => fixture.notify());
    await screen.rerender(<Surface />);
    expect(visibleTitles()).toEqual([]);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll("main a")).toHaveLength(5);
    fixture.enabled = true;
    await act(() => fixture.notify());
    await screen.rerender(<Surface />);
    expect(visibleTitles()).toHaveLength(4);
  });
});
