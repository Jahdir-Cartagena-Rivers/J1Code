import { assert, describe, it } from "@effect/vitest";
import { CommandId, EventId, ProjectId, ProviderInstanceId, type ProjectScript } from "@j1code/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import {
  planProjectCommand,
  type ProjectCommand,
  type ProjectCommandState,
} from "./ProjectCommands.ts";
import type { ProjectRow } from "./ProjectStore.ts";

const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const projectId = ProjectId.make("project-scripts");

const row = (overrides: Partial<ProjectRow> = {}): ProjectRow => ({
  projectId,
  title: "Scripts",
  workspaceRoot: "/tmp/scripts",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  hasCustomTitle: false,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
  ...overrides,
});

const script = (id: string): ProjectScript => ({
  id,
  name: "Install dependencies",
  command: "vp i",
  icon: "configure",
  runOnWorktreeCreate: false,
});

const plan = (command: ProjectCommand, state: Partial<ProjectCommandState> = {}) =>
  planProjectCommand({
    command,
    state: { project: undefined, workspaceOwner: undefined, ...state },
    eventId: EventId.make("event:planned"),
    now,
  });

const payloadOf = (result: ReturnType<typeof plan>) => {
  assert.isTrue(Result.isSuccess(result));
  return Result.getOrThrow(result).payload as Record<string, unknown>;
};

const failureOf = (result: ReturnType<typeof plan>) => {
  assert.isTrue(Result.isFailure(result));
  return Result.isFailure(result) ? result.failure : assert.fail("expected a rejection");
};

describe("planProjectCommand", () => {
  it("defaults to empty scripts on creation and preserves scripts on update", () => {
    const created = plan({
      type: "project.create",
      commandId: CommandId.make("cmd-create-scripts"),
      projectId,
      title: "Scripts",
      workspaceRoot: "/tmp/scripts",
    });
    assert.deepEqual(payloadOf(created).scripts, []);
    assert.isNull(payloadOf(created).defaultModelSelection);
    const selection = { instanceId: ProviderInstanceId.make("fixture-provider"), model: "fixture-model" };
    assert.deepEqual(payloadOf(plan({
      type: "project.create",
      commandId: CommandId.make("cmd-create-with-model"),
      projectId,
      title: "With model",
      workspaceRoot: "/tmp/scripts",
      defaultModelSelection: selection,
    })).defaultModelSelection, selection);
    const scripts = [script("lint"), script("a".repeat(24))];
    const updated = plan({
      type: "project.meta.update",
      commandId: CommandId.make("cmd-add-scripts"),
      projectId,
      scripts,
    }, { project: row() });
    assert.deepEqual(payloadOf(updated).scripts, scripts);
  });

  it.each(["install-javascript-dependencies", "A", "a.b", "a b", "-a", "a".repeat(25)])(
    "rejects a new script ID that cannot be a shortcut (%s)",
    (id) => {
      const current = row();
      const error = failureOf(plan({
        type: "project.meta.update",
        commandId: CommandId.make("cmd-bad-script"),
        projectId,
        scripts: [script("lint"), script(id)],
      }, { project: current }));
      assert.equal(error._tag, "ProjectCommandInvariantError");
      assert.include(error.message, "Script IDs must be 1-24");
      assert.deepEqual(current.scripts, []);
    },
  );

  it("preserves icon metadata and enforces the two-grapheme monogram limit", () => {
    const update = (projectIcon: NonNullable<ProjectRow["projectIcon"]>) => plan({
      type: "project.meta.update",
      commandId: CommandId.make("cmd-project-icon"),
      projectId,
      faviconPath: "brand/icon.svg",
      projectIcon,
    }, { project: row() });
    const icon = { kind: "lucide", name: "alarm-clock", color: "violet" } as const;
    assert.deepInclude(payloadOf(update(icon)), { faviconPath: "brand/icon.svg", projectIcon: icon });
    for (const text of ["J1", "e\u0301", "किखि", "क्ष्म", "\u1100\u1161\u11a8"]) {
      const monogram = { kind: "monogram", text, color: "violet" } as const;
      assert.deepEqual(payloadOf(update(monogram)).projectIcon, monogram);
    }
    for (const text of ["ABC", "किखिगि", "J1 Code"]) {
      assert.equal(failureOf(update({ kind: "monogram", text, color: "violet" }))._tag,
        "ProjectCommandInvariantError");
    }
  });

  it("keeps legacy scripts editable and removable while rejecting new invalid ones", () => {
    const legacy = script("install-javascript-dependencies");
    const withLegacy = (scripts: ReadonlyArray<ProjectScript>) =>
      plan(
        {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-repair-script"),
          projectId,
          scripts,
        },
        { project: row({ scripts: [legacy] }) },
      );
    for (const scripts of [[{ ...legacy, command: "vp install" }, script("lint")], []]) {
      assert.deepEqual(payloadOf(withLegacy(scripts)).scripts, scripts);
    }
    assert.equal(
      failureOf(withLegacy([legacy, script("another.invalid.id")]))._tag,
      "ProjectCommandInvariantError",
    );
  });

  it("keeps the first pin and archive time, and clears both on undo", () => {
    const earlier = "2025-12-01T00:00:00.000Z";
    const update = (project: ProjectRow, change: { pinned?: boolean; archived?: boolean }) =>
      payloadOf(
        plan(
          {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-organize"),
            projectId,
            ...change,
          },
          { project },
        ),
      );
    assert.deepInclude(update(row(), { pinned: true, archived: true }), {
      pinnedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: "2026-01-01T00:00:00.000Z",
    });
    const organized = row({ pinnedAt: earlier, archivedAt: earlier });
    assert.deepInclude(update(organized, { pinned: true, archived: true }), {
      pinnedAt: earlier,
      archivedAt: earlier,
    });
    assert.deepInclude(update(organized, { pinned: false, archived: false }), {
      pinnedAt: null,
      archivedAt: null,
    });
    const untouched = update(organized, {});
    assert.notProperty(untouched, "pinnedAt");
    assert.notProperty(untouched, "archivedAt");
  });

  it("rejects a workspace root held by another active project", () => {
    const owner = row({
      projectId: ProjectId.make("project-existing"),
      workspaceRoot: "/tmp/project",
    });
    const create = failureOf(
      plan(
        {
          type: "project.create",
          commandId: CommandId.make("cmd-duplicate-root"),
          projectId: ProjectId.make("project-duplicate-root"),
          title: "Duplicate",
          workspaceRoot: "/tmp/project",
        },
        { workspaceOwner: owner },
      ),
    );
    assert.equal(create._tag, "ProjectWorkspaceConflictError");
    assert.equal(
      create.message,
      "Active project 'project-existing' already exists for workspace root '/tmp/project'.",
    );
    const move = failureOf(
      plan(
        {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-move-root"),
          projectId,
          workspaceRoot: "/tmp/project",
        },
        { project: row(), workspaceOwner: owner },
      ),
    );
    assert.equal(move._tag, "ProjectWorkspaceConflictError");
  });

  it("requires the project to exist, and to be absent on create", () => {
    const create: ProjectCommand = {
      type: "project.create",
      commandId: CommandId.make("cmd-create-twice"),
      projectId,
      title: "Twice",
      workspaceRoot: "/tmp/twice",
    };
    assert.include(failureOf(plan(create, { project: row() })).message, "cannot be created twice");
    const deleted = row({ deletedAt: "2026-01-01T00:00:00.000Z" });
    assert.include(
      failureOf(plan(create, { project: deleted })).message,
      "cannot be created twice",
    );
    for (const command of [
      { type: "project.meta.update", commandId: CommandId.make("cmd-missing"), projectId },
      { type: "project.delete", commandId: CommandId.make("cmd-missing"), projectId },
    ] as const) {
      for (const project of [undefined, deleted]) {
        assert.equal(
          failureOf(plan(command, { project }))._tag,
          "ProjectCommandMissingProjectError",
        );
      }
    }
  });
});
