import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { ProjectId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Platform, useWindowDimensions } from "react-native";

import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import {
  useProjects,
  useServerConfigs,
  useThreadShells,
  waitForProject,
} from "../../state/entities";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { WorkspaceEmptyDetail } from "../layout/WorkspaceEmptyDetail";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { checkForAppUpdateOnLaunch, startAppUpdateForegroundRecheck } from "../updates/app-updates";
import { AndroidHomeFabLayout } from "./AndroidHomeFab";
import { HomeScreen } from "./HomeScreen";
import { HomeHeader } from "./HomeHeader";
import { useHomeListOptions } from "./home-list-options";
import { useHomeThreadSelection } from "./home-thread-navigation";
import { buildHomeProjectScopes } from "./homeThreadList";
import { usePendingTaskListActions } from "./usePendingTaskListActions";
import { useThreadListActions } from "./useThreadListActions";
import { getConnectionAwareBrandHeaderOptions } from "./WorkspaceConnectionTitle";
import { useArchivedThreadSnapshots } from "../archive/useArchivedThreadSnapshots";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { projectEnvironment } from "../../state/projects";

/* ─── Route screen ───────────────────────────────────────────────────── */

export function HomeRouteScreen() {
  const { width: windowWidth } = useWindowDimensions();
  const { layout, panes } = useAdaptiveWorkspaceLayout();
  const projects = useProjects();
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const { environments: workspaceEnvironments, state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const navigation = useNavigation();
  const [searchQuery, setSearchQuery] = useState("");
  const handleSelectThread = useHomeThreadSelection();
  const unarchiveThread = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });

  useEffect(() => {
    void checkForAppUpdateOnLaunch();
    startAppUpdateForegroundRecheck();
  }, []);

  const {
    archiveThread,
    confirmDeleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    setThreadAutoSettle,
    moveThread,
    renameThread,
    regenerateThreadTitle,
    unsettleThread,
  } = useThreadListActions();
  const pendingTasks = usePendingNewTasks();
  const { openPendingTask, confirmDeletePendingTask } = usePendingTaskListActions();
  const environments = useMemo(() => {
    const connectionStateByEnvironmentId = new Map(
      workspaceEnvironments.map(
        (environment) => [environment.environmentId, environment.connectionState] as const,
      ),
    );
    return Arr.sort(
      Object.values(savedConnectionsById).map((connection) => ({
        environmentId: connection.environmentId,
        label: connection.environmentLabel,
        connectionState:
          connectionStateByEnvironmentId.get(connection.environmentId) ?? "available",
      })),
      Order.mapInput(Order.String, (environment: { readonly label: string }) => environment.label),
    );
  }, [savedConnectionsById, workspaceEnvironments]);
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  // Only Home's owning environment needs archived history. Fetching every
  // remote archive on the landing screen would be expensive and cannot help
  // recover this singleton conversation.
  const homeEnvironmentIds = useMemo(
    () =>
      projects
        .filter((project) => project.id === "j1-home")
        .map((project) => project.environmentId),
    [projects],
  );
  const {
    snapshots: archivedSnapshots,
    error: archivedHomeError,
    isLoading: archivedHomeLoading,
    refresh: refreshArchivedHomes,
  } = useArchivedThreadSnapshots(homeEnvironmentIds);
  const displayThreads = useMemo(
    () => [
      ...threads,
      ...archivedSnapshots.flatMap((entry) =>
        entry.snapshot.threads.map((thread) => ({ ...thread, environmentId: entry.environmentId })),
      ),
    ],
    [archivedSnapshots, threads],
  );
  const selectThread = useCallback(
    (thread: (typeof displayThreads)[number]) => {
      if (thread.projectId !== "j1-home" || thread.archivedAt === null) {
        handleSelectThread(thread);
        return;
      }
      void unarchiveThread({
        environmentId: thread.environmentId,
        input: { threadId: thread.id },
      }).then((result) => {
        if (result._tag === "Success") {
          refreshArchivedHomes();
          handleSelectThread(thread);
        } else {
          Alert.alert("Could not reopen Home", "Try again from the Archive screen.");
        }
      });
    },
    [handleSelectThread, refreshArchivedHomes, unarchiveThread],
  );
  const {
    options: listOptions,
    setSelectedEnvironmentId,
    moveProject,
  } = useHomeListOptions(availableEnvironmentIds);
  const selectedEnvironmentId = listOptions.selectedEnvironmentId;
  const openHome = useCallback(() => {
    const project = projects.find(
      (candidate) =>
        candidate.id === "j1-home" &&
        (selectedEnvironmentId === null || candidate.environmentId === selectedEnvironmentId),
    );
    if (project) {
      if (archivedHomeLoading) {
        Alert.alert("Opening Home", "Checking your existing Home conversation.");
        return;
      }
      if (archivedHomeError !== null) {
        Alert.alert("Could not open Home", "Try again after reconnecting.");
        return;
      }
      navigation.navigate("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: {
          environmentId: String(project.environmentId),
          projectId: String(project.id),
          title: project.title,
        },
      });
      return;
    }
    const homeConfig = [...serverConfigs.entries()].find(
      ([environmentId, config]) =>
        config.homeWorkspaceRoot !== undefined &&
        (selectedEnvironmentId === null || environmentId === selectedEnvironmentId),
    );
    if (!homeConfig) {
      Alert.alert("Home is unavailable", "Reconnect an environment and try again.");
      return;
    }
    const [environmentId, config] = homeConfig;
    const workspaceRoot = config.homeWorkspaceRoot;
    if (workspaceRoot === undefined) return;
    const projectId = ProjectId.make("j1-home");
    void createProject({
      environmentId,
      input: {
        projectId,
        title: "Home",
        workspaceRoot,
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: null,
        createdAt: new Date().toISOString(),
      },
    }).then(async () => {
      // Creation can lose to another device before that project's event arrives.
      const created = await waitForProject({ environmentId, projectId });
      if (!created || created.workspaceRoot !== workspaceRoot) {
        Alert.alert(
          "Could not open Home",
          "The environment has not finished loading the project. Try again.",
        );
        return;
      }
      navigation.navigate("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: {
          environmentId: String(environmentId),
          projectId: String(projectId),
          title: "Home",
        },
      });
    });
  }, [
    archivedHomeError,
    archivedHomeLoading,
    createProject,
    navigation,
    projects,
    selectedEnvironmentId,
    serverConfigs,
  ]);
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const projectFilterOptions = useMemo(
    () =>
      buildHomeProjectScopes({
        projects,
        environmentId: selectedEnvironmentId,
        projectGroupingMode: listOptions.projectGroupingMode,
      }).map((scope) => ({
        key: scope.key,
        label: scope.title,
      })),
    [listOptions.projectGroupingMode, projects, selectedEnvironmentId],
  );
  useEffect(() => {
    if (
      selectedProjectKey !== null &&
      !projectFilterOptions.some((project) => project.key === selectedProjectKey)
    ) {
      setSelectedProjectKey(null);
    }
  }, [projectFilterOptions, selectedProjectKey]);

  // In split layouts the persistent sidebar IS the thread list — Home becomes
  // an empty detail pane so selecting a thread never transitions layouts.
  if (layout.usesSplitView) {
    return (
      <>
        <NativeStackScreenOptions
          options={
            Platform.OS === "android"
              ? { headerShown: false }
              : { title: "", headerTitle: "", unstable_headerLeftItems: () => [] }
          }
        />
        {Platform.OS === "ios" ? (
          <NativeHeaderToolbar placement="left">
            <NativeHeaderToolbar.Button
              accessibilityLabel="New task"
              icon="square.and.pencil"
              onPress={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
            />
          </NativeHeaderToolbar>
        ) : null}
        {Platform.OS === "android" ? <AndroidScreenHeader title="Threads" /> : null}
        <WorkspaceEmptyDetail
          onAddConnection={
            Platform.OS === "android" && !catalogState.hasConnections
              ? () =>
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsContent",
                    params: { screen: "SettingsEnvironmentNew" },
                  })
              : undefined
          }
          onStartNewTask={
            Platform.OS === "android" && panes.primarySidebarVisible
              ? undefined
              : () => navigation.navigate("NewTaskSheet", { screen: "NewTask" })
          }
        />
      </>
    );
  }

  return (
    <AndroidHomeFabLayout
      onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
    >
      <>
        {/* Restore the header after leaving split view; screen options are
            shallow-merged. The brand slot also doubles as the connection
            status surface while an environment reconnects. */}
        <NativeStackScreenOptions
          optionsVersion={windowWidth}
          options={{
            ...getConnectionAwareBrandHeaderOptions({
              headerWidth: windowWidth,
              onOpenEnvironments: () =>
                navigation.navigate("SettingsSheet", {
                  screen: "SettingsContent",
                  params: { screen: "SettingsEnvironments" },
                }),
            }),
            headerShown: true,
          }}
        />
        <HomeHeader
          environments={environments}
          projects={projectFilterOptions}
          searchQuery={searchQuery}
          selectedEnvironmentId={selectedEnvironmentId}
          selectedProjectKey={selectedProjectKey}
          onEnvironmentChange={setSelectedEnvironmentId}
          onProjectChange={setSelectedProjectKey}
          onOpenEnvironments={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "SettingsEnvironments" },
            })
          }
          onOpenSettings={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "Settings" },
            })
          }
          onSearchQueryChange={setSearchQuery}
          onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
        />

        <HomeScreen
          catalogState={catalogState}
          environments={environments}
          onAddConnection={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "SettingsEnvironmentNew" },
            })
          }
          onArchiveThread={archiveThread}
          onDeleteThread={confirmDeleteThread}
          onSettleThread={settleThread}
          onSnoozeThread={snoozeThread}
          onUnsnoozeThread={unsnoozeThread}
          onUnsettleThread={unsettleThread}
          onPinThread={pinThread}
          onUnpinThread={unpinThread}
          onSetThreadAutoSettle={setThreadAutoSettle}
          onMoveThread={moveThread}
          onRenameThread={renameThread}
          onRegenerateThreadTitle={regenerateThreadTitle}
          onEnvironmentChange={setSelectedEnvironmentId}
          onProjectChange={setSelectedProjectKey}
          onOpenSettings={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "Settings" },
            })
          }
          onSearchQueryChange={setSearchQuery}
          onSelectThread={selectThread}
          onSelectPendingTask={openPendingTask}
          onDeletePendingTask={confirmDeletePendingTask}
          onNewThreadOnBranch={(thread) => {
            navigation.navigate("NewTaskSheet", {
              screen: "NewTaskDraft",
              params: {
                environmentId: String(thread.environmentId),
                projectId: String(thread.projectId),
                branch: thread.branch,
                worktreePath: thread.worktreePath,
              },
            });
          }}
          onNewThreadInProject={(project) => {
            navigation.navigate("NewTaskSheet", {
              screen: "NewTaskDraft",
              params: {
                environmentId: String(project.environmentId),
                projectId: String(project.id),
                title: project.title,
              },
            });
          }}
          onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
          onOpenHome={openHome}
          pendingTasks={pendingTasks}
          projectGroupingMode={listOptions.projectGroupingMode}
          projects={projects}
          projectSortOrder={listOptions.projectSortOrder}
          projectOrder={listOptions.projectOrder}
          onMoveProject={moveProject}
          savedConnectionsById={savedConnectionsById}
          searchQuery={searchQuery}
          selectedEnvironmentId={selectedEnvironmentId}
          selectedProjectKey={selectedProjectKey}
          threads={displayThreads}
        />
      </>
    </AndroidHomeFabLayout>
  );
}
