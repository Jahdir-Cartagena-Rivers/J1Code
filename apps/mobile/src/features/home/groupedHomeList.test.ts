import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { groupHomeList } from "./groupedHomeList";
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
});
