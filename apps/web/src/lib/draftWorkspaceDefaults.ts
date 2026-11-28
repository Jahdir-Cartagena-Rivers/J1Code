import { DEFAULT_SERVER_SETTINGS, type ScopedProjectRef } from "@j1code/contracts";
import type { EnvironmentProject } from "@j1code/client-runtime/state/shell";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@j1code/shared/projectSettings";
import { flushSync } from "react-dom";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject, readThreadShells } from "../state/entities";
import { readUnloadedThreadCount } from "../state/olderSettledShelf";
import { environmentSummaries } from "../state/presentation";
import { environmentServerConfigsAtom } from "../state/server";
import { resolveNewDraftStartFromOrigin } from "./chatThreadActions";
import { readJ1ProjectFile } from "./j1ProjectFileDefaults";

export async function readDraftWorkspaceDefault(
  projectRef: ScopedProjectRef,
  project: EnvironmentProject | null | undefined,
) {
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(projectRef.environmentId);
  const serverSettings = config?.settings ?? DEFAULT_SERVER_SETTINGS;
  const projectSettings = resolveProjectSettings(serverSettings, project?.id ?? null, project);
  const projectFile =
    project &&
    projectSettings.settings.defaultThreadEnvMode === null &&
    appAtomRegistry
      .get(environmentSummaries.connectedEnvironmentIdsAtom)
      .includes(projectRef.environmentId)
      ? await readJ1ProjectFile(
          projectRef.environmentId,
          project.workspaceRoot,
          AbortSignal.timeout(5_000),
        )
      : null;
  const settings = resolveProjectSettings(
    serverSettings,
    project?.id ?? null,
    project,
    projectFile,
  );
  const envMode = resolveNewThreadEnvMode({
    projectSettings: settings,
    workspaceRoot: project?.workspaceRoot ?? null,
    newProjectsRoot: config?.newProjectsRoot,
    projectHasThreads:
      readThreadShells().some(
        (thread) =>
          thread.environmentId === projectRef.environmentId &&
          thread.projectId === projectRef.projectId,
      ) ||
      readUnloadedThreadCount(
        [{ environmentId: projectRef.environmentId, id: projectRef.projectId }],
        [],
      ) > 0,
  });
  return {
    envMode,
    startFromOrigin: resolveNewDraftStartFromOrigin({
      envMode,
      newWorktreesStartFromOrigin: settings.settings.newWorktreesStartFromOrigin,
    }),
  };
}

const pendingWorkspaceDefaults = new Map<DraftId, Promise<void>>();

export function readPendingDraftWorkspaceDefault(draftId: DraftId) {
  return pendingWorkspaceDefaults.get(draftId);
}

export function applyMovedDraftWorkspaceDefault(draftId: DraftId, projectRef: ScopedProjectRef) {
  const store = useComposerDraftStore.getState();
  const initial = store.getDraftSession(draftId);
  if (!initial || initial.promotedTo) return;
  const request = readDraftWorkspaceDefault(projectRef, readProject(projectRef))
    .then((workspace) => {
      const current = store.getDraftSession(draftId);
      if (
        pendingWorkspaceDefaults.get(draftId) !== request ||
        !current ||
        current.promotedTo ||
        current.environmentId !== projectRef.environmentId ||
        current.projectId !== projectRef.projectId ||
        current.branch !== initial.branch ||
        current.worktreePath !== initial.worktreePath ||
        current.envMode !== initial.envMode ||
        current.startFromOrigin !== initial.startFromOrigin ||
        current.checkoutPullRequest !== initial.checkoutPullRequest
      )
        return;
      // An awaiting send must see the destination's updated composer before it resumes.
      flushSync(() => store.setDraftThreadContext(draftId, workspace));
    })
    .finally(() => {
      if (pendingWorkspaceDefaults.get(draftId) === request)
        pendingWorkspaceDefaults.delete(draftId);
    });
  pendingWorkspaceDefaults.set(draftId, request);
  return request;
}
