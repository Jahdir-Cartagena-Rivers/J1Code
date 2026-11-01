import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildHomeProjectScopes, selectHomeThread, sortHomeProjectScopes } from "./homeThreadList";
import { groupHomeList } from "./groupedHomeList";
import type { ThreadListV2ListItem } from "../threads/threadListV2";

function makeProject(
  input: Partial<EnvironmentProject> & Pick<EnvironmentProject, "environmentId" | "id" | "title">,
): EnvironmentProject {
  return {
    workspaceRoot: `/workspaces/${input.id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...input,
  };
}

function makeThread(
  input: Partial<EnvironmentThreadShell> &
    Pick<EnvironmentThreadShell, "environmentId" | "id" | "projectId" | "title">,
): EnvironmentThreadShell {
  return {
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
    settledOverride: input.settledOverride ?? null,
    settledAt: input.settledAt ?? null,
  };
}

describe("grouped home list", () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  const projects = [
    makeProject({ environmentId: local, id: ProjectId.make("a"), title: "Auto Apply" }),
    makeProject({ environmentId: local, id: ProjectId.make("b"), title: "MediaApp" }),
    makeProject({ environmentId: remote, id: ProjectId.make("a"), title: "Other repository" }),
  ];
  const scopes = buildHomeProjectScopes({
    projects,
    environmentId: null,
    projectGroupingMode: "separate",
  });
  it("excludes the Home conversation from project pickers", () => {
    const home = makeProject({
      environmentId: local,
      id: ProjectId.make("j1-home"),
      title: "Home",
    });
    expect(
      buildHomeProjectScopes({
        projects: [...projects, home],
        environmentId: null,
        projectGroupingMode: "separate",
      }).some((scope) => scope.projects.some((project) => project.id === home.id)),
    ).toBe(false);
  });
  it("selects the original Home even when archived", () => {
    const old = makeThread({
      environmentId: local,
      id: ThreadId.make("home-old"),
      projectId: ProjectId.make("j1-home"),
      title: "Home",
      createdAt: "2026-01-01T00:00:00.000Z",
      archivedAt: "2026-02-01T00:00:00.000Z",
    });
    const newer = makeThread({
      environmentId: local,
      id: ThreadId.make("home-new"),
      projectId: ProjectId.make("j1-home"),
      title: "Home",
      createdAt: "2026-03-01T00:00:00.000Z",
    });
    expect(selectHomeThread([newer, old], null)?.id).toBe(old.id);
    expect(selectHomeThread([newer, old], remote)).toBeUndefined();
  });
  function row(id: string, projectId: string, environmentId = local): ThreadListV2ListItem {
    return {
      type: "v2-thread",
      key: id,
      item: {
        thread: makeThread({
          id: ThreadId.make(id),
          projectId: ProjectId.make(projectId),
          environmentId,
          title: id,
        }),
        variant: "card",
        snoozed: false,
        pinned: false,
        isLast: false,
      },
      timeLabel: "1h",
      snoozePresetMinute: undefined,
      snoozeWakeLabelText: undefined,
      showTrailingDivider: false,
      hasQueuedMessages: false,
      canMoveUp: false,
      canMoveDown: false,
    };
  }
  const items = [row("a1", "a"), row("b1", "b"), row("a2", "a"), row("remote", "a", remote)];
  it("keeps each project's chats together without combining unrelated environments", () => {
    const result = groupHomeList({ items, scopes, collapsedKeys: new Set(), searching: false });
    expect(result.filter((item) => item.type === "v2-thread").map((item) => item.key)).toEqual([
      "a1",
      "a2",
      "b1",
      "remote",
    ]);
    expect(
      result
        .filter((item) => item.type === "project-heading")
        .map((item) => [item.title, item.count]),
    ).toEqual([
      ["Auto Apply", 2],
      ["MediaApp", 1],
      ["Other repository", 1],
    ]);
  });
  it("collapses, reopens and reveals search matches without discarding rows", () => {
    const collapsedKeys = new Set([scopes[0]!.key]);
    const collapsed = groupHomeList({ items, scopes, collapsedKeys, searching: false });
    expect(collapsed.some((item) => item.key === "a1")).toBe(false);
    expect(collapsed[0]).toMatchObject({ type: "project-heading", count: 2, expanded: false });
    for (const input of [
      { collapsedKeys: new Set<string>(), searching: false },
      { collapsedKeys, searching: true },
    ]) {
      expect(groupHomeList({ items, scopes, ...input }).some((item) => item.key === "a1")).toBe(
        true,
      );
    }
  });
  it("groups the same repository across environments using scoped project identities", () => {
    const repositoryIdentity = {
      canonicalKey: "github.com/example/project",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/example/project.git",
      },
    };
    const repositoryScopes = buildHomeProjectScopes({
      projects: [projects[0]!, projects[2]!].map((project) => ({ ...project, repositoryIdentity })),
      environmentId: null,
      projectGroupingMode: "repository",
    });
    const result = groupHomeList({
      items: [items[0]!, items[3]!],
      scopes: repositoryScopes,
      collapsedKeys: new Set(),
      searching: false,
    });
    expect(result.filter((item) => item.type === "project-heading")).toHaveLength(1);
    expect(result.filter((item) => item.type === "v2-thread").map((item) => item.key)).toEqual([
      "a1",
      "remote",
    ]);
  });
  it("preserves shelf boundaries and uncatalogued threads", () => {
    const shelf = {
      type: "v2-settled-shelf",
      key: "v2-settled-shelf",
      count: 1,
      expanded: true,
      disabled: false,
    } as const;
    const result = groupHomeList({
      items: [row("active", "a"), shelf, row("settled", "a"), row("unknown", "missing")],
      scopes,
      collapsedKeys: new Set(),
      searching: false,
    });
    expect(result.map((item) => item.type)).toEqual([
      "project-heading",
      "v2-thread",
      "project-heading",
      "project-heading",
      "v2-settled-shelf",
      "project-heading",
      "v2-thread",
      "v2-thread",
    ]);
    expect(new Set(result.map((item) => item.key)).size).toBe(result.length);
    expect(
      result
        .slice(0, 4)
        .filter((item) => item.type === "project-heading")
        .map((item) => item.count),
    ).toEqual([1, 0, 0]);
    expect(result.at(-1)?.key).toBe("unknown");
  });
});

describe("home project scopes", () => {
  it("builds one v2 scope for the same repository across environments", () => {
    const localEnvironmentId = EnvironmentId.make("environment-local");
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const repositoryIdentity = {
      canonicalKey: "github.com/pingdotgg/t3code",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:pingdotgg/t3code.git",
      },
    };
    const projects = [
      makeProject({
        environmentId: localEnvironmentId,
        id: ProjectId.make("project-local"),
        title: "t3code",
        repositoryIdentity,
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: ProjectId.make("project-remote"),
        title: "t3code",
        repositoryIdentity,
      }),
    ];

    const scopes = buildHomeProjectScopes({
      projects,
      environmentId: null,
      projectGroupingMode: "repository",
    });

    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.title).toBe("t3code");
    expect(scopes[0]?.projects).toEqual(projects);
    expect(scopes[0]?.projectRefs).toEqual(
      projects.map((project) => ({
        environmentId: project.environmentId,
        projectId: project.id,
      })),
    );
  });

  it("keeps repository identity from an older duplicate when the freshness winner lacks it", () => {
    const localEnvironmentId = EnvironmentId.make("environment-local");
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const repositoryIdentity = {
      canonicalKey: "github.com/pingdotgg/t3code",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:pingdotgg/t3code.git",
      },
    };
    const projects = [
      makeProject({
        environmentId: localEnvironmentId,
        id: ProjectId.make("project-local"),
        title: "t3code",
        repositoryIdentity,
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: ProjectId.make("project-remote-with-identity"),
        title: "t3code",
        workspaceRoot: "/remote/t3code",
        repositoryIdentity,
        updatedAt: "2026-06-01T00:00:00.000Z",
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: ProjectId.make("project-remote-fresh"),
        title: "t3code",
        workspaceRoot: "/remote/t3code/",
        updatedAt: "2026-06-02T00:00:00.000Z",
      }),
    ];

    const scopes = buildHomeProjectScopes({
      projects,
      environmentId: null,
      projectGroupingMode: "repository",
    });

    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.representative.id).toBe(ProjectId.make("project-local"));
    expect(scopes[0]?.projects.map((project) => project.id)).toContain(
      ProjectId.make("project-remote-fresh"),
    );
    expect(scopes[0]?.projectRefs).toHaveLength(3);
  });

  it("sorts v2 project scopes by their grouped thread activity", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const olderProject = makeProject({
      environmentId,
      id: ProjectId.make("project-older"),
      title: "Older project",
    });
    const newerProject = makeProject({
      environmentId,
      id: ProjectId.make("project-newer"),
      title: "Newer project",
    });
    const scopes = buildHomeProjectScopes({
      projects: [newerProject, olderProject],
      environmentId: null,
      projectGroupingMode: "separate",
    });

    expect(
      sortHomeProjectScopes({
        scopes,
        threads: [
          makeThread({
            environmentId,
            id: ThreadId.make("thread-older-project"),
            projectId: olderProject.id,
            title: "Most recently active",
            updatedAt: "2026-06-03T00:00:00.000Z",
          }),
          makeThread({
            environmentId,
            id: ThreadId.make("thread-newer-project"),
            projectId: newerProject.id,
            title: "Less recently active",
            updatedAt: "2026-06-02T00:00:00.000Z",
          }),
        ],
        pendingTasks: [],
        projectSortOrder: "updated_at",
      }).map((scope) => scope.representative.id),
    ).toEqual([olderProject.id, newerProject.id]);
  });

  it("keeps manually ordered project scopes fixed when threads become active", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const firstProject = makeProject({
      environmentId,
      id: ProjectId.make("project-first"),
      title: "First project",
    });
    const secondProject = makeProject({
      environmentId,
      id: ProjectId.make("project-second"),
      title: "Second project",
    });
    const scopes = buildHomeProjectScopes({
      projects: [firstProject, secondProject],
      environmentId: null,
      projectGroupingMode: "separate",
    });

    expect(
      sortHomeProjectScopes({
        scopes,
        threads: [
          makeThread({
            environmentId,
            id: ThreadId.make("recent-second-thread"),
            projectId: secondProject.id,
            title: "Recent work",
            updatedAt: "2026-06-03T00:00:00.000Z",
          }),
        ],
        pendingTasks: [],
        projectSortOrder: "manual",
      }),
    ).toEqual(scopes);
  });

  it("sorts invalid project creation timestamps after valid ones", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const invalidProject = makeProject({
      environmentId,
      id: ProjectId.make("project-invalid"),
      title: "A invalid timestamp",
      createdAt: "invalid",
    });
    const validProject = makeProject({
      environmentId,
      id: ProjectId.make("project-valid"),
      title: "Z valid timestamp",
      createdAt: "2026-06-02T00:00:00.000Z",
    });
    const scopes = buildHomeProjectScopes({
      projects: [invalidProject, validProject],
      environmentId: null,
      projectGroupingMode: "separate",
    });

    expect(
      sortHomeProjectScopes({
        scopes,
        threads: [],
        pendingTasks: [],
        projectSortOrder: "created_at",
      }).map((scope) => scope.representative.id),
    ).toEqual([validProject.id, invalidProject.id]);
  });

  it("uses the freshest member when a grouped scope has no activity", () => {
    const localEnvironmentId = EnvironmentId.make("environment-local");
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const repositoryIdentity = {
      canonicalKey: "github.com/pingdotgg/t3code",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:pingdotgg/t3code.git",
      },
    };
    const olderMember = makeProject({
      environmentId: localEnvironmentId,
      id: ProjectId.make("project-older-member"),
      title: "t3code",
      updatedAt: "2026-06-01T00:00:00.000Z",
      repositoryIdentity,
    });
    const newerMember = makeProject({
      environmentId: remoteEnvironmentId,
      id: ProjectId.make("project-newer-member"),
      title: "t3code",
      updatedAt: "2026-06-03T00:00:00.000Z",
      repositoryIdentity,
    });
    const otherProject = makeProject({
      environmentId: localEnvironmentId,
      id: ProjectId.make("project-other"),
      title: "other",
      updatedAt: "2026-06-02T00:00:00.000Z",
    });
    const scopes = buildHomeProjectScopes({
      projects: [olderMember, newerMember, otherProject],
      environmentId: null,
      projectGroupingMode: "repository",
    });

    expect(
      sortHomeProjectScopes({
        scopes,
        threads: [],
        pendingTasks: [],
        projectSortOrder: "updated_at",
      })[0]?.key,
    ).toBe(scopes.find((scope) => scope.projects.length === 2)?.key);
  });

  it("does not merge unrelated repositories that share a title", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const projects = ["one", "two"].map((name) =>
      makeProject({
        environmentId,
        id: ProjectId.make(`project-${name}`),
        title: "app",
        repositoryIdentity: {
          canonicalKey: `github.com/example/${name}`,
          locator: {
            source: "git-remote" as const,
            remoteName: "origin",
            remoteUrl: `git@github.com:example/${name}.git`,
          },
        },
      }),
    );

    expect(
      buildHomeProjectScopes({
        projects,
        environmentId: null,
        projectGroupingMode: "repository",
      }),
    ).toHaveLength(2);
  });
});
