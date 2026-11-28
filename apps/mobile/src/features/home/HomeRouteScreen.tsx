import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import * as Option from "effect/Option";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useEnvironments } from "../../state/environments";
import { usePreparedConnection } from "../../state/session";
import { SharedWorkspace } from "../mausbot/SharedWorkspace";
import { selectWorkspaceEnvironment, workspaceConversationUrl } from "../mausbot/workspace-browser";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useHomeListOptions } from "./home-list-options";

export type HomeRouteParameters =
  | { workspaceEnvironmentId?: string; workspaceThreadId?: string }
  | undefined;

export function HomeRouteScreen() {
  const navigation = useNavigation();
  const { setNativeToolsActive } = useAdaptiveWorkspaceLayout();
  const { environments } = useEnvironments();
  const availableIds = useMemo(
    () => new Set(environments.map((e) => e.environmentId)),
    [environments],
  );
  const { options } = useHomeListOptions(availableIds);
  const parameters = useRoute<RouteProp<{ Home: HomeRouteParameters }, "Home">>().params;
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
  const previousEnvironmentId = lastAddress?.environmentId;
  const selectedEnvironmentId = selected?.environmentId;
  const address = previousEnvironmentId === selectedEnvironmentId ? lastAddress : null;
  const openConnections = useCallback(() => navigation.navigate("Connections"), [navigation]);
  return (
    <>
      {address ? (
        <SharedWorkspace
          key={`${address.environmentId}:${address.baseUrl}`}
          environmentId={address.environmentId}
          baseUrl={address.baseUrl}
          {...(target ? { initialUrl: workspaceConversationUrl(address.baseUrl, target) } : {})}
          onOpenConnections={openConnections}
          onOpenAppTools={() => setNativeToolsActive(true)}
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
          <Button label="Connections" onPress={openConnections} />
          <Button label="App tools" onPress={() => setNativeToolsActive(true)} />
        </View>
      )}
    </>
  );
}
