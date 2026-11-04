// @vitest-environment jsdom
import { type ReactNode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { RouteRequestControl } from "./RouteRequestControl";

const commands = vi.hoisted(() => ({ list: vi.fn(), prepare: vi.fn(), confirm: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    params,
    children,
  }: {
    params: { environmentId: string; threadId: string };
    children: ReactNode;
  }) => <a href={`/${params.environmentId}/${params.threadId}`}>{children}</a>,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { routingList: "list", routingPrepare: "prepare", routingConfirm: "confirm" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: keyof typeof commands) => commands[name],
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [{ environmentId: "local", id: "work", title: "J1 Code" }],
  useThreadShells: () => [
    {
      environmentId: "local",
      id: "target",
      projectId: "work",
      title: "Home improvements",
      archivedAt: null,
    },
  ],
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  commands.list.mockResolvedValue({
    _tag: "Success",
    value: [
      {
        requestId: "request",
        status: "suggested",
        summary: "Add the new Home requirements",
        destination: { environmentId: "local", projectId: "work", threadId: "target" },
        reason: "Two possible owners",
      },
    ],
  });
  commands.prepare.mockResolvedValue({ _tag: "Success", value: { token: "connection-bound" } });
  commands.confirm.mockResolvedValue({ _tag: "Success", value: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const render = () =>
  act(async () =>
    root.render(
      <RouteRequestControl
        environmentId={EnvironmentId.make("local")}
        projectId="home"
        threadId="source"
      />,
    ),
  );
const click = async (label: string) => {
  const button = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
};
it("loads pending matches without sending, and sends only after explicit approval", async () => {
  await render();
  expect(container.querySelector('[aria-label="Request approvals"]')).toBeTruthy();
  expect(container.textContent).toContain("Add the new Home requirements");
  expect(commands.prepare).not.toHaveBeenCalled();
  expect(commands.confirm).not.toHaveBeenCalled();
  await click("Approve and send");
  expect(commands.prepare).toHaveBeenCalledWith({
    environmentId: "local",
    input: {
      requestId: "request",
      source: { environmentId: "local", projectId: "home", threadId: "source" },
      destination: { environmentId: "local", projectId: "work", threadId: "target" },
    },
  });
  expect(commands.confirm).toHaveBeenCalledExactlyOnceWith({
    environmentId: "local",
    input: { token: "connection-bound" },
  });
  expect(container.textContent).toContain("Queued for Home improvements");
});
it("keeps the request for review when the destination changes, without confirming", async () => {
  commands.prepare.mockResolvedValue({ _tag: "Failure" });
  await render();
  await click("Approve and send");
  expect(commands.confirm).not.toHaveBeenCalled();
  expect(container.textContent).toContain("conversation is unavailable");
});
it("leaving a suggestion for later never sends it", async () => {
  await render();
  await click("Not now");
  expect(commands.prepare).not.toHaveBeenCalled();
  expect(commands.confirm).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Review request");
});
it("keeps an ordinary chat free of routing controls when there is no request", async () => {
  commands.list.mockResolvedValue({ _tag: "Success", value: [] });
  await render();
  expect(container.textContent).toBe("");
});
it("links completed handoffs and does not ask for a chat selection", async () => {
  commands.list.mockResolvedValue({
    _tag: "Success",
    value: [
      {
        requestId: "done",
        status: "completed",
        summary: "Audio changes",
        destination: { environmentId: "local", projectId: "work", threadId: "target" },
      },
    ],
  });
  await render();
  expect(container.querySelector('a[href="/local/target"]')?.textContent).toContain(
    "Home improvements",
  );
  expect(container.querySelector('[aria-label="Destination conversation"]')).toBeNull();
  expect(container.textContent).not.toContain("Approve and send");
});
it("automatically shows a new source routing notice without opening a control", async () => {
  commands.list.mockResolvedValue({ _tag: "Success", value: [] });
  await render();
  commands.list.mockResolvedValue({
    _tag: "Success",
    value: [
      {
        requestId: "new",
        status: "suggested",
        summary: "Review the audio integration",
        destination: { environmentId: "local", projectId: "work", threadId: "target" },
      },
    ],
  });
  await act(async () =>
    root.render(
      <RouteRequestControl
        environmentId={EnvironmentId.make("local")}
        projectId="home"
        threadId="source"
        revision={1}
      />,
    ),
  );
  expect(container.textContent).toContain("Review the audio integration");
  expect(container.textContent).toContain("Approve and send");
  expect(commands.prepare).not.toHaveBeenCalled();
  expect(commands.confirm).not.toHaveBeenCalled();
});

it("keeps unavailable destination proposals disabled while retaining their link", async () => {
  commands.list.mockResolvedValue({
    _tag: "Success",
    value: [
      {
        requestId: "missing",
        status: "suggested",
        summary: "Audio work",
        destination: { environmentId: "local", projectId: "work", threadId: "unavailable" },
      },
    ],
  });
  await render();
  const approve = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Approve and send",
  );
  expect(approve?.disabled).toBe(true);
  expect(container.querySelector('a[href="/local/unavailable"]')).not.toBeNull();
  expect(commands.prepare).not.toHaveBeenCalled();
  expect(commands.confirm).not.toHaveBeenCalled();
});

it("keeps cards in the original message row as receipts and later messages arrive", async () => {
  const messages = [
    { id: "original", role: "user", createdAt: "2026-11-04T10:00:00Z" },
    { id: "followup", role: "user", createdAt: "2026-11-04T11:00:00Z" },
  ];
  const first = {
    kind: "routing.updated",
    createdAt: "2026-11-04T10:01:00Z",
    payload: { requestId: "request" },
  };
  const mount = (revision: number) => (
    <RouteRequestControl
      environmentId={EnvironmentId.make("local")}
      projectId="home"
      threadId="source"
      messages={messages}
      activities={[first, { ...first, createdAt: "2026-11-04T11:01:00Z" }]}
      revision={revision}
    >
      {(render) => (
        <>
          <article data-anchor="original">{render("original")}</article>
          <article data-anchor="followup">{render("followup")}</article>
        </>
      )}
    </RouteRequestControl>
  );
  await act(async () => root.render(mount(1)));
  expect(container.querySelector('[data-anchor="original"]')?.textContent).toContain(
    "Approve and send",
  );
  expect(container.querySelector('[data-anchor="followup"]')?.textContent).toBe("");
  expect(commands.list).toHaveBeenCalledTimes(1);
  commands.list.mockResolvedValue({
    _tag: "Success",
    value: [
      {
        requestId: "request",
        status: "completed",
        summary: "Completed request",
        destination: { environmentId: "local", projectId: "work", threadId: "target" },
      },
    ],
  });
  await act(async () => root.render(mount(2)));
  expect(container.querySelector('[data-anchor="original"]')?.textContent).toContain("Completed");
  expect(container.querySelector('[data-anchor="followup"]')?.textContent).toBe("");
  expect(commands.prepare).not.toHaveBeenCalled();
});

it("keeps a failed request read visible and retryable in history", async () => {
  commands.list.mockResolvedValue({ _tag: "Failure" });
  await render();
  expect(container.textContent).toContain("Could not load requests");
  expect(container.textContent).toContain("Refresh requests");
  expect(commands.confirm).not.toHaveBeenCalled();
});
