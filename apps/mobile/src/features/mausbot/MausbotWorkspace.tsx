import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { useState } from "react";
import { Modal, View } from "react-native";
import { WebView } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { connectionAtomRuntime } from "../../connection/runtime";
import { usePreparedConnection } from "../../state/session";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { MaterialButton } from "../../components/MaterialButton";
import { AppText } from "../../components/AppText";

const openWorkspace = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile-mausbot-open",
  tag: WS_METHODS.mausbotOpen,
});
export function MausbotWorkspace({ environmentId }: { environmentId: EnvironmentId | null }) {
  const connection = usePreparedConnection(environmentId);
  const { environments } = useEnvironments();
  const command = useAtomCommand(openWorkspace, { reportFailure: false });
  const [view, setView] = useState<{ environmentId: string; base: string; url: string } | null>(
    null,
  );
  const url =
    view &&
    view.environmentId === environmentId &&
    connection._tag === "Some" &&
    view.base === connection.value.httpBaseUrl
      ? view.url
      : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const insets = useSafeAreaInsets();
  const open = async () => {
    if (!environmentId || connection._tag !== "Some" || busy) return;
    setBusy(true);
    try {
      const result = await command({ environmentId, input: {} });
      if (result._tag !== "Success")
        throw new Error(
          "This server could not open the assistant workspace. Check its runtime and connection permissions.",
        );
      const resolved = resolveAssetUrl(connection.value.httpBaseUrl, result.value.relativeUrl);
      if (!resolved) throw new Error("The server returned an invalid workspace address.");
      setView({ environmentId, base: connection.value.httpBaseUrl, url: resolved });
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Assistant workspace unavailable.");
    } finally {
      setBusy(false);
    }
  };
  if (
    !environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.environment.capabilities.mausbot
  )
    return null;
  return (
    <View>
      <MaterialButton
        tone="text"
        label={busy ? "Opening bots…" : "Bots"}
        disabled={busy || !environmentId}
        onPress={() => void open()}
      />
      {error ? <AppText>{error}</AppText> : null}
      {url ? (
        <Modal visible animationType="slide" onRequestClose={() => setView(null)}>
          <View
            className="flex-1 bg-screen"
            style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
          >
            <MaterialButton tone="text" label="Back to J1" onPress={() => setView(null)} />
            <WebView
              source={{ uri: url }}
              originWhitelist={[new URL(url).origin]}
              onShouldStartLoadWithRequest={(request) =>
                request.url === "about:blank" || request.url.startsWith(url)
              }
            />
          </View>
        </Modal>
      ) : null}
    </View>
  );
}
