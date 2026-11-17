import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import * as Option from "effect/Option";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { AppText } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { useEnvironments } from "../../state/environments";
import { usePreparedConnection } from "../../state/session";
import { SharedWorkspace } from "../mausbot/SharedWorkspace";
import { selectWorkspaceEnvironment, workspaceConversationUrl } from "../mausbot/workspace-browser";
import { useHomeListOptions } from "./home-list-options";
import { checkForAppUpdateOnLaunch, startAppUpdateForegroundRecheck } from "../updates/app-updates";

export function HomeRouteScreen(
  props: StaticScreenProps<
    { workspaceEnvironmentId?: string; workspaceThreadId?: string } | undefined
  >,
) {
  const navigation = useNavigation();
  useEffect(() => {
    void checkForAppUpdateOnLaunch();
    startAppUpdateForegroundRecheck();
  }, []);
  const { environments } = useEnvironments();
  const availableIds = useMemo(
    () => new Set(environments.map((e) => e.environmentId)),
    [environments],
  );
  const { options } = useHomeListOptions(availableIds);
  const parameters = props.route.params;
  const target =
    parameters?.workspaceEnvironmentId && parameters.workspaceThreadId
      ? { environmentId: parameters.workspaceEnvironmentId, threadId: parameters.workspaceThreadId }
      : undefined;
  const selected = selectWorkspaceEnvironment(
    environments,
    target?.environmentId ?? options.selectedEnvironmentId,
  );
  const prepared = usePreparedConnection(selected?.environmentId ?? null);
  const currentAddress =
    selected &&
    Option.isSome(prepared) &&
    selected.serverConfig?.environment.capabilities.workspaceBrowser === true
      ? { environmentId: selected.environmentId, baseUrl: prepared.value.httpBaseUrl }
      : null;
  const [lastAddress, setLastAddress] = useState(currentAddress);
  if (
    currentAddress &&
    (lastAddress?.environmentId !== currentAddress.environmentId ||
      lastAddress.baseUrl !== currentAddress.baseUrl)
  )
    setLastAddress(currentAddress);
  // Suspension may temporarily clear connection/config snapshots. Keep the same
  // document mounted; the existing session and server still decide authorization.
  const address = lastAddress?.environmentId === selected?.environmentId ? lastAddress : null;
  const openConnections = useCallback(
    () =>
      navigation.navigate("SettingsSheet", {
        screen: "SettingsContent",
        params: { screen: "SettingsEnvironments" },
      }),
    [navigation],
  );
  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: false }} />
      {address ? (
        <SharedWorkspace
          key={`${address.environmentId}:${address.baseUrl}`}
          environmentId={address.environmentId}
          baseUrl={address.baseUrl}
          {...(target ? { initialUrl: workspaceConversationUrl(address.baseUrl, target) } : {})}
          onOpenConnections={openConnections}
          onOpenAppTools={openConnections}
        />
      ) : (
        <View className="flex-1 items-center justify-center gap-4 bg-screen px-6">
          {selected && !selected.serverConfig ? <ActivityIndicator /> : null}
          <AppText className="text-center">
            {selected
              ? selected.serverConfig?.environment.capabilities.workspaceBrowser === false
                ? "Update this server to open J1."
                : "Connecting to J1…"
              : "Choose a server to open J1."}
          </AppText>
          <MaterialButton label="Connections" onPress={openConnections} />
        </View>
      )}
    </>
  );
}
