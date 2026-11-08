import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import {
  callMausbotRouting,
  isMausbotRoutingMethod,
} from "@t3tools/client-runtime/mausbot-routing";
import { CommonActions, useNavigation } from "@react-navigation/native";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { useLayoutEffect, useRef, useState } from "react";
import { Modal, View } from "react-native";
import { WebView } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { connectionAtomRuntime } from "../../connection/runtime";
import { usePreparedConnection } from "../../state/session";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { MaterialButton } from "../../components/MaterialButton";
import { AppText } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";

const openWorkspace = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile-mausbot-open",
  tag: WS_METHODS.mausbotOpen,
});
export function MausbotWorkspace({
  environmentId,
  initialConversation,
  label = "Bots",
}: {
  environmentId: EnvironmentId | null;
  initialConversation?: { botId: string; threadId: string };
  label?: string;
}) {
  const navigation = useNavigation();
  const webView = useRef<WebView>(null);
  const list = useAtomCommand(serverEnvironment.routingList, { reportFailure: false });
  const prepare = useAtomCommand(serverEnvironment.routingPrepare, { reportFailure: false });
  const confirm = useAtomCommand(serverEnvironment.routingConfirm, { reportFailure: false });
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
  const activeUrl = useRef(url);
  useLayoutEffect(() => {
    activeUrl.current = url;
  }, [url]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const insets = useSafeAreaInsets();
  const mobileMessage = (value: unknown) =>
    `window.dispatchEvent(new CustomEvent("j1-mobile-host", { detail: ${JSON.stringify(value)} })); true;`;
  const nativeNavigation = (conversation?: { botId: string; threadId: string }) => ({
    navigation: {
      active: conversation ? "/assistants" : "/",
      sidebarOpen: true,
      mobileOpen: false,
      conversation,
    },
  });
  const hostCall = async (method: string, args: unknown) => {
    if (!environmentId) throw new Error("Routing unavailable.");
    return callMausbotRouting(method, args, {
      environmentId,
      list: async (source) => {
        const result = await list({ environmentId, input: { source } });
        if (result._tag !== "Success") throw new Error("Routing unavailable.");
        return result.value;
      },
      prepare: async (input) => {
        const result = await prepare({ environmentId, input });
        if (result._tag !== "Success") throw new Error("Review the changed request.");
        return result.value;
      },
      confirm: async (token) => {
        const result = await confirm({ environmentId, input: { token } });
        if (result._tag !== "Success") throw new Error("Could not approve this request.");
      },
      label: () => "Open destination conversation",
      open: async (endpoint) => {
        const native = /^mausbot:([\w-]{1,120}):([\w-]{1,120})$/.exec(endpoint.threadId);
        if (native)
          webView.current?.injectJavaScript(
            mobileMessage(nativeNavigation({ botId: native[1]!, threadId: native[2]! })),
          );
        else {
          setView(null);
          navigation.dispatch(
            CommonActions.navigate("Thread", {
              environmentId: endpoint.environmentId,
              threadId: endpoint.threadId,
            }),
          );
        }
      },
    });
  };
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
        label={busy ? "Opening bots…" : label}
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
              ref={webView}
              source={{ uri: url }}
              injectedJavaScript={mobileMessage(nativeNavigation(initialConversation))}
              onMessage={(event) => {
                if (!event.nativeEvent.url.startsWith(url)) return;
                let message: {
                  source?: string;
                  type?: string;
                  requestId?: string;
                  method?: string;
                  args?: unknown;
                };
                try {
                  message = JSON.parse(event.nativeEvent.data);
                } catch {
                  return;
                }
                if (
                  !message ||
                  message.source !== "j1-mausbot" ||
                  message.type !== "host-call" ||
                  typeof message.method !== "string" ||
                  !isMausbotRoutingMethod(message.method) ||
                  !/^desktop-\d+$/.test(message.requestId ?? "")
                )
                  return;
                const requestId = message.requestId;
                void hostCall(message.method, message.args).then(
                  (value) => {
                    if (activeUrl.current === url)
                      webView.current?.injectJavaScript(mobileMessage({ requestId, value }));
                  },
                  () => {
                    if (activeUrl.current === url)
                      webView.current?.injectJavaScript(
                        mobileMessage({
                          requestId,
                          error: "Routing request unavailable. Review it again.",
                        }),
                      );
                  },
                );
              }}
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
