// @vitest-environment jsdom
import { cloneElement, type ReactElement, type ReactNode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { RouteRequestControl } from "./RouteRequestControl";

const commands = vi.hoisted(() => ({ list: vi.fn(), prepare: vi.fn(), confirm: vi.fn() }));
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
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => children,
  SelectTrigger: "div",
  SelectValue: "span",
  SelectPopup: "div",
  SelectItem: "div",
}));
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
        destination: { threadId: "target" },
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
        destination: { threadId: "target" },
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
