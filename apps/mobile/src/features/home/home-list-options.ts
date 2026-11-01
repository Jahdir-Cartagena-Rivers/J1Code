import type { EnvironmentId, SidebarProjectGroupingMode } from "@t3tools/contracts";
import { DEFAULT_SIDEBAR_PROJECT_SORT_ORDER } from "@t3tools/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
  type Dispatch,
  type SetStateAction,
} from "react";

import type { HomeProjectSortOrder } from "./homeThreadList";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { moveVisibleProjects } from "./projectOrder";

export interface HomeListOptions {
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly projectOrder: ReadonlyArray<string>;
}

export interface ResolvedHomeListOptions extends HomeListOptions {
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}

function defaultHomeListOptions(): HomeListOptions {
  return {
    selectedEnvironmentId: null,
    projectSortOrder: DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
    projectOrder: [],
  };
}

interface HomeListOptionsContextValue {
  readonly options: HomeListOptions;
  readonly setOptions: Dispatch<SetStateAction<HomeListOptions>>;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}

const HomeListOptionsContext = createContext<HomeListOptionsContextValue | null>(null);

/** Keeps list preferences stable while the app moves between compact and split shells. */
export function HomeListOptionsProvider({
  children,
  projectGroupingMode,
}: PropsWithChildren<{
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}>) {
  const [options, setOptions] = useState<HomeListOptions>(defaultHomeListOptions);
  const value = useMemo(
    () => ({ options, setOptions, projectGroupingMode }),
    [options, projectGroupingMode],
  );
  return createElement(HomeListOptionsContext, { value }, children);
}

export function useHomeListOptions(availableEnvironmentIds: ReadonlySet<EnvironmentId>) {
  const shared = useContext(HomeListOptionsContext);
  const [localOptions, setLocalOptions] = useState<HomeListOptions>(defaultHomeListOptions);
  const options = shared?.options ?? localOptions;
  const setOptions = shared?.setOptions ?? setLocalOptions;
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const persistedProjectOrder = AsyncResult.isSuccess(preferences)
    ? (preferences.value.homeProjectOrder ?? [])
    : [];
  const selectedEnvironmentId =
    options.selectedEnvironmentId !== null &&
    availableEnvironmentIds.has(options.selectedEnvironmentId)
      ? options.selectedEnvironmentId
      : null;
  const availableOptions =
    selectedEnvironmentId === options.selectedEnvironmentId
      ? options
      : { ...options, selectedEnvironmentId };
  const resolvedOptions: ResolvedHomeListOptions = {
    ...availableOptions,
    projectOrder: persistedProjectOrder,
    projectGroupingMode: shared?.projectGroupingMode ?? "repository",
  };

  const setSelectedEnvironmentId = useCallback((value: EnvironmentId | null) => {
    setOptions((current) => ({ ...current, selectedEnvironmentId: value }));
  }, []);
  const setProjectSortOrder = useCallback((value: HomeProjectSortOrder) => {
    setOptions((current) => ({ ...current, projectSortOrder: value }));
  }, []);
  const moveProject = useCallback(
    (projectKeys: ReadonlyArray<string>, from: number, to: number) => {
      if (
        from < 0 ||
        to < 0 ||
        from >= projectKeys.length ||
        to >= projectKeys.length ||
        from === to
      )
        return;
      void savePreferences({
        transform: (current) => ({
          homeProjectOrder: moveVisibleProjects(
            current.homeProjectOrder ?? [],
            projectKeys,
            from,
            to,
          ),
        }),
      });
    },
    [savePreferences],
  );
  return {
    options: resolvedOptions,
    setSelectedEnvironmentId,
    setProjectSortOrder,
    moveProject,
  } as const;
}
