import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@j1code/contracts";

import { groupHomeList } from "./groupedHomeList";
import type { ThreadListV2ListItem } from "../threads/threadListV2";
import type { HomeProjectScope } from "./homeThreadList";

const scope = (id: string): HomeProjectScope => ({
  key: id,
  title: id,
  representative: {
    environmentId: EnvironmentId.make("environment"),
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    defaultModelSelection: null,
    scripts: [],
  },
  projects: [],
  projectRefs: [],
  pinned: false,
  archived: false,
});

describe("groupHomeList", () => {
  it("keeps empty project headings in the active organizer", () => {
    const items = groupHomeList({
      items: [],
      scopes: [scope("first"), scope("second")],
      collapsedKeys: new Set(),
      searching: false,
    });
    expect(items).toMatchObject([
      { type: "project-heading", scopeKey: "first", count: 0 },
      { type: "project-heading", scopeKey: "second", count: 0 },
    ]);
  });
  it("keeps working rows inside their shelf when projects are grouped or collapsed", () => {
    const project = scope("first");
    const scopes = [
      {
        ...project,
        projectRefs: [
          { environmentId: EnvironmentId.make("environment"), projectId: ProjectId.make("first") },
        ],
      },
    ];
    const draft = (key: string): ThreadListV2ListItem => ({
      type: "v2-pending",
      key,
      showPendingDivider: false,
      showTrailingDivider: false,
      pendingTask: {
        kind: "draft",
        key,
        environmentId: EnvironmentId.make("environment"),
        projectId: ProjectId.make("first"),
        projectTitle: undefined,
        projectCwd: undefined,
        title: key,
        createdAt: "2026-01-01T00:00:00.000Z",
        draftKey: key,
        draft: { text: key, attachments: [] },
      },
    });
    const input: ThreadListV2ListItem[] = [
      draft("active"),
      {
        type: "v2-working-shelf",
        key: "v2-working-shelf",
        count: 1,
        expanded: true,
        disabled: false,
      },
      draft("working"),
    ];
    const expanded = groupHomeList({
      items: input,
      scopes,
      collapsedKeys: new Set(),
      searching: false,
    });
    expect(expanded.map((item) => item.key)).toEqual([
      "project:active:first",
      "active",
      "v2-working-shelf",
      "project:v2-working-shelf:first",
      "working",
    ]);
    const collapsed = groupHomeList({
      items: input,
      scopes,
      collapsedKeys: new Set(["first"]),
      searching: false,
    });
    expect(collapsed.map((item) => item.key)).toEqual([
      "project:active:first",
      "v2-working-shelf",
      "project:v2-working-shelf:first",
    ]);
    const searched = groupHomeList({
      items: input,
      scopes,
      collapsedKeys: new Set(["first"]),
      searching: true,
    });
    expect(searched.map((item) => item.key)).toEqual(expanded.map((item) => item.key));
  });
});
