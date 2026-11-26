import type { FileDiffMetadata, CodeViewScrollTarget } from "@pierre/diffs";
import { FileTree } from "@pierre/trees";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { DiffFileTree, type DiffFileTreeEntry } from "./DiffFileTree";
import { createCodeViewFileReveal } from "./useCodeViewFileReveal";
import { diffFileTreeEntries } from "./diffFileTree.logic";

const FOLDERS = 300;

it("expands every folder without asking the tree about all folders for each one", async () => {
  // Two levels, so flattening empty folders cannot merge them into one.
  const entries: DiffFileTreeEntry[] = Array.from({ length: FOLDERS }, (_, index) => [
    { path: `package-${index}/a.ts`, status: "modified" as const },
    { path: `package-${index}/lib/b.ts`, status: "modified" as const },
  ]).flat();
  using getItem = vi.spyOn(FileTree.prototype, "getItem");
  await using _screen = await render(
    <div className="flex h-[600px] flex-col">
      <DiffFileTree entries={entries} onSelectFile={() => {}} ariaLabel="Changed files" />
    </div>,
  );
  const collapseAll = page.getByRole("button", { name: "Collapse all folders" });
  await expect.element(collapseAll).toBeVisible();
  await userEvent.click(collapseAll);
  const expandAll = page.getByRole("button", { name: "Expand all folders" });
  await expect.element(expandAll).toBeVisible();
  getItem.mockClear();
  await userEvent.click(expandAll);
  await expect.element(page.getByRole("button", { name: "Collapse all folders" })).toBeVisible();
  // Each of the expansions used to look up the folders again from the first one, so the lookups
  // grew with the square of the folder count (hundreds of thousands at 600 folders).
  expect(getItem.mock.calls.length).toBeLessThan(FOLDERS * 2 * 20);
});

function activationFixture(entries: DiffFileTreeEntry[] = [
    { path: "01-tall.ts", status: "modified" },
    { path: "02-short.ts", status: "modified" },
  ]) {
  const targets: CodeViewScrollTarget[] = [];
  const reveal = createCodeViewFileReveal();
  const instance = {};
  reveal.attach({
    getInstance: () => instance,
    getItem: (id) => entries.some(({ path }) => id === path) ? {} : undefined,
    scrollTo: (target) => targets.push(target),
  });
  return { entries, targets, reveal };
}

it("reveals a clicked file again without duplicating a newly selected neighbor", async () => {
  const { entries, targets, reveal } = activationFixture();
  await using _screen = await render(
    <div className="flex h-[300px] flex-col">
      <DiffFileTree entries={entries} onSelectFile={(path) => reveal.request(path)} ariaLabel="Changed files" />
    </div>,
  );
  const short = page.getByText("02-short.ts", { exact: true });
  await userEvent.click(short);
  await vi.waitFor(() => expect(targets).toEqual([{ type: "item", id: "02-short.ts", align: "start" }]));
  await userEvent.click(short);
  await vi.waitFor(() => expect(targets).toHaveLength(2));
  await userEvent.click(page.getByText("01-tall.ts", { exact: true }));
  await vi.waitFor(() => expect(targets).toEqual([
    { type: "item", id: "02-short.ts", align: "start" },
    { type: "item", id: "02-short.ts", align: "start" },
    { type: "item", id: "01-tall.ts", align: "start" },
  ]));
  await userEvent.click(short);
  await vi.waitFor(() => expect(targets).toHaveLength(4));
  expect(targets.at(-1)).toEqual({ type: "item", id: "02-short.ts", align: "start" });
});

it.each(["Control", "Meta"])("does not reveal a file when %s-click deselects it", async (modifier) => {
  const { entries, targets, reveal } = activationFixture();
  await using _screen = await render(
    <div className="flex h-[300px] flex-col">
      <DiffFileTree entries={entries} onSelectFile={(path) => reveal.request(path)} ariaLabel="Changed files" />
    </div>,
  );
  const short = page.getByText("02-short.ts", { exact: true });
  await userEvent.click(short);
  await vi.waitFor(() => expect(targets).toHaveLength(1));
  await userEvent.keyboard(`{${modifier}>}`);
  try {
    await userEvent.click(short);
  } finally {
    await userEvent.keyboard(`{/${modifier}}`);
  }
  expect(targets).toHaveLength(1);
  await userEvent.click(short);
  await vi.waitFor(() => expect(targets).toHaveLength(2));
});

it("shows one activatable file row for a file-to-symlink type change", async () => {
  const { entries, targets, reveal } = activationFixture([...diffFileTreeEntries([
    { type: "deleted", name: "AGENTS.md", prevName: "AGENTS.md" } as FileDiffMetadata,
    { type: "new", name: "AGENTS.md", prevName: "AGENTS.md" } as FileDiffMetadata,
    { type: "modified", name: "CLAUDE.md", prevName: "CLAUDE.md" } as FileDiffMetadata,
  ])]);
  await using _screen = await render(
    <div className="flex h-[300px] flex-col">
      <DiffFileTree entries={entries} onSelectFile={(path) => reveal.request(path)} ariaLabel="Changed files" />
    </div>,
  );
  await expect.element(page.getByText("AGENTS.md", { exact: true })).toBeVisible();
  await expect.element(page.getByText("CLAUDE.md", { exact: true })).toBeVisible();
  await userEvent.click(page.getByText("AGENTS.md", { exact: true }));
  await vi.waitFor(() => expect(targets).toEqual([{ type: "item", id: "AGENTS.md", align: "start" }]));
});

it("does not echo controlled selection but still reveals the selected row on activation", async () => {
  const { entries, targets, reveal } = activationFixture();
  const view = (selectedPath: string) => (
    <div className="flex h-[300px] flex-col">
      <DiffFileTree entries={entries} selectedPath={selectedPath} onSelectFile={(path) => reveal.request(path)} ariaLabel="Changed files" />
    </div>
  );
  await using screen = await render(view("02-short.ts"));
  expect(targets).toEqual([]);
  await userEvent.click(page.getByText("02-short.ts", { exact: true }));
  await vi.waitFor(() => expect(targets).toEqual([{ type: "item", id: "02-short.ts", align: "start" }]));
  await screen.rerender(view("01-tall.ts"));
  expect(targets).toHaveLength(1);
  await userEvent.click(page.getByText("01-tall.ts", { exact: true }));
  await vi.waitFor(() => expect(targets).toEqual([
    { type: "item", id: "02-short.ts", align: "start" },
    { type: "item", id: "01-tall.ts", align: "start" },
  ]));
});

it("keeps focus-only movement separate from Enter activation", async () => {
  const { entries, targets, reveal } = activationFixture();
  await using _screen = await render(
    <div className="flex h-[300px] flex-col">
      <DiffFileTree entries={entries} onSelectFile={(path) => reveal.request(path)} ariaLabel="Changed files" />
    </div>,
  );
  await userEvent.click(page.getByText("02-short.ts", { exact: true }));
  await vi.waitFor(() => expect(targets).toHaveLength(1));
  const row = page.getByText("01-tall.ts", { exact: true }).element().closest<HTMLElement>("[data-item-path]");
  expect(row).not.toBeNull();
  row!.focus();
  expect(targets).toHaveLength(1);
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(targets).toHaveLength(2));
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(targets).toHaveLength(3));
});

it("narrows a multiselection with one reveal", async () => {
  const { entries, targets, reveal } = activationFixture();
  await using _screen = await render(
    <div className="flex h-[300px] flex-col">
      <DiffFileTree entries={entries} onSelectFile={(path) => reveal.request(path)} ariaLabel="Changed files" />
    </div>,
  );
  await userEvent.click(page.getByText("02-short.ts", { exact: true }));
  await vi.waitFor(() => expect(targets).toHaveLength(1));
  await userEvent.keyboard("{Control>}");
  try {
    await userEvent.click(page.getByText("01-tall.ts", { exact: true }));
  } finally {
    await userEvent.keyboard("{/Control}");
  }
  targets.length = 0;
  await userEvent.click(page.getByText("02-short.ts", { exact: true }));
  await vi.waitFor(() => expect(targets).toEqual([{ type: "item", id: "02-short.ts", align: "start" }]));
});

it("preserves collapsed folders when refreshed files reorder", async () => {
  const files: DiffFileTreeEntry[] = [
    { path: "src/app.ts", status: "modified" },
    { path: "src/other.ts", status: "added" },
  ];
  const { targets, reveal } = activationFixture(files);
  const view = (entries: DiffFileTreeEntry[]) => (
    <div className="flex h-[300px] flex-col">
      <DiffFileTree entries={entries} onSelectFile={(path) => reveal.request(path)} ariaLabel="Changed files" />
    </div>
  );
  await using screen = await render(view(files));
  const folder = page.getByText("src", { exact: true });
  await expect.element(page.getByText("app.ts", { exact: true })).toBeVisible();
  await userEvent.click(folder);
  await expect.element(page.getByText("app.ts", { exact: true })).not.toBeVisible();
  expect(targets).toEqual([]);
  await screen.rerender(view([files[1]!, files[0]!]));
  await expect.element(page.getByText("app.ts", { exact: true })).not.toBeVisible();
  await userEvent.click(folder);
  await expect.element(page.getByText("app.ts", { exact: true })).toBeVisible();
  expect(targets).toEqual([]);
});
