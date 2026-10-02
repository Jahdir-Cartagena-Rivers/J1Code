import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  EnvironmentId,
  OrchestrationThreadShell,
  ThreadId,
  DEFAULT_CLIENT_SETTINGS,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as Schema from "effect/Schema";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({ threads: [] as EnvironmentThreadShell[], enabled: true }));
vi.mock("~/state/entities", () => ({ useThreadShells: () => fixture.threads }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector({ ...DEFAULT_CLIENT_SETTINGS, workerChatsInSidebar: fixture.enabled }),
}));
vi.mock("~/uiStateStore", () => ({
  useUiStateStore: (
    selector: (state: { threadLastVisitedAtById: Record<string, string> }) => unknown,
  ) => selector({ threadLastVisitedAtById: {} }),
}));
vi.mock("./ui/sidebar", () => ({ useSidebar: () => ({ setOpenMobile: () => {} }) }));
vi.mock("./Sidebar.logic", () => ({ resolveThreadStatusPill: () => null }));

import { WorkerChatsInChat, WorkerChatTree } from "./WorkerChats";
import { useWorkerChatStore } from "~/workerChatStore";

const parent = { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("parent") };
const decodeThreadShell = Schema.decodeUnknownSync(OrchestrationThreadShell);
function worker(number: number): EnvironmentThreadShell {
  return {
    ...decodeThreadShell({
      id: `worker${number}`,
      parentThreadId: parent.threadId,
      projectId: "project",
      title: `Worker: task ${number}`,
      modelSelection: { instanceId: "codex", model: "test" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      session: null,
      latestUserMessageAt: null,
      createdAt: `2026-10-02T00:00:0${number}Z`,
      updatedAt: `2026-10-02T00:00:0${number}Z`,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    }),
    environmentId: parent.environmentId,
  };
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
const router = createRouter({
  routeTree: createRootRoute({ component: Surface }),
  history: createMemoryHistory(),
});
let renderer: ReactTestRenderer;
let renderKey = 0;
async function render() {
  await act(() => {
    const view = <RouterProvider key={renderKey++} router={router} />;
    if (renderer) renderer.update(view);
    else renderer = create(view);
  });
}
function visibleTitles() {
  return renderer.root
    .findByType("aside")
    .findAllByType("a")
    .map((link) => link.props["aria-label"]);
}
function button(label: string) {
  return renderer.root
    .findAllByType("button")
    .find((entry) => entry.props["aria-label"] === label)!;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.threads = [1, 2, 3, 4, 5].map(worker);
  fixture.enabled = true;
  useWorkerChatStore.setState({ byParentKey: {} });
  await router.load();
  await render();
});
afterEach(async () => {
  await act(() => renderer.unmount());
  renderer = undefined!;
  vi.unstubAllGlobals();
});

describe("worker chat folding controls", () => {
  it("folds and reopens old workers from the parent while keeping the four-chat limit", async () => {
    expect(visibleTitles()).toEqual([
      "Worker: task 2",
      "Worker: task 3",
      "Worker: task 4",
      "Worker: task 5",
    ]);
    expect(renderer.root.findByType("main").findAllByType("a")).toHaveLength(5);
    await act(() => button("Fold Worker: task 3 into parent chat").props.onClick());
    expect(visibleTitles()).toEqual(["Worker: task 2", "Worker: task 4", "Worker: task 5"]);
    await act(() => button("Unfold Worker: task 1 in sidebar").props.onClick());
    expect(visibleTitles()).toEqual([
      "Worker: task 1",
      "Worker: task 2",
      "Worker: task 4",
      "Worker: task 5",
    ]);
    fixture.threads = [...fixture.threads, worker(6)];
    await render();
    expect(visibleTitles()).toEqual([
      "Worker: task 1",
      "Worker: task 4",
      "Worker: task 5",
      "Worker: task 6",
    ]);
    expect(renderer.root.findByType("main").findAllByType("a")).toHaveLength(6);
    await act(() => button("Fold worker chats").props.onClick());
    expect(visibleTitles()).toEqual([]);
    await render();
    expect(visibleTitles()).toEqual([]);
    await act(() => button("Unfold worker chats").props.onClick());
    expect(visibleTitles()).toHaveLength(4);
  });

  it("keeps every worker accessible inside its parent when sidebar folding is disabled", async () => {
    fixture.enabled = false;
    await render();
    expect(visibleTitles()).toEqual([]);
    expect(renderer.root.findAllByType("button")).toEqual([]);
    expect(renderer.root.findByType("main").findAllByType("a")).toHaveLength(5);
    fixture.enabled = true;
    await render();
    expect(visibleTitles()).toHaveLength(4);
  });
});
