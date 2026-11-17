import type { EnvironmentId } from "@j1code/contracts";
import { createWorkspaceBrowserSessionCommand } from "@j1code/client-runtime/state/session";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  KeyboardAvoidingView,
  Linking,
  Platform,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { useFocusEffect } from "@react-navigation/native";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { MaterialButton } from "../../components/MaterialButton";
import { AppText } from "../../components/AppText";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import {
  decodeWorkspaceHostMessage,
  isWorkspaceBrowserUrl,
  workspaceBootstrapScript,
  workspaceBrowserUrls,
  workspaceScopesChanged,
} from "./workspace-browser";

const issueWorkspace = createWorkspaceBrowserSessionCommand(connectionAtomRuntime);

export function SharedWorkspace(props: {
  readonly environmentId: EnvironmentId;
  readonly baseUrl: string;
  readonly initialUrl?: string;
  readonly onOpenConnections: () => void;
  readonly onOpenAppTools: () => void;
}) {
  const { environmentId, baseUrl, onOpenConnections, onOpenAppTools } = props;
  const { setSharedWorkspaceActive } = useAdaptiveWorkspaceLayout();
  useFocusEffect(
    useCallback(() => {
      setSharedWorkspaceActive(true);
      return () => setSharedWorkspaceActive(false);
    }, [setSharedWorkspaceActive]),
  );
  const urls = useMemo(() => workspaceBrowserUrls(baseUrl), [baseUrl]);
  const destination =
    props.initialUrl && isWorkspaceBrowserUrl(baseUrl, props.initialUrl)
      ? props.initialUrl
      : urls.home;
  const source = useMemo(() => ({ uri: urls.pair }), [urls.pair]);
  const webView = useRef<WebView>(null);
  const issue = useAtomCommand(issueWorkspace, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [browserGeneration, setBrowserGeneration] = useState(0);
  const pending = useRef<{ credential: string; navigate: boolean } | null>(null);
  const loaded = useRef(false);
  const authenticated = useRef(false);
  const lastWorkspaceUrl = useRef(destination);
  const canGoBack = useRef(false);
  const active = useRef(true);
  const inFlight = useRef(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const grantedScopes = useRef<ReadonlyArray<string> | null>(null);
  const handoffTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigateAfterAuth = useRef(false);
  const handoffGeneration = useRef(0);
  const finishHandoff = useCallback(() => {
    inFlight.current = false;
    handoffGeneration.current++;
    if (handoffTimer.current) clearTimeout(handoffTimer.current);
    handoffTimer.current = null;
  }, []);

  useEffect(() => {
    lastWorkspaceUrl.current = destination;
    if (authenticated.current && loaded.current)
      webView.current?.injectJavaScript(`location.assign(${JSON.stringify(destination)}); true;`);
  }, [destination]);

  const flush = useCallback(() => {
    if (!loaded.current || !pending.current || !active.current) return;
    const handoff = pending.current;
    pending.current = null;
    navigateAfterAuth.current = handoff.navigate;
    webView.current?.injectJavaScript(workspaceBootstrapScript(baseUrl, handoff.credential, false));
  }, [baseUrl]);

  const connect = useCallback(
    async (navigate: boolean) => {
      if (inFlight.current || !active.current) return;
      inFlight.current = true;
      const generation = ++handoffGeneration.current;
      handoffTimer.current = setTimeout(() => {
        pending.current = null;
        finishHandoff();
        if (active.current) setError("Workspace sign-in timed out. Try again.");
      }, 65_000);
      try {
        const result = await issue({ environmentId, input: undefined });
        if (!active.current || generation !== handoffGeneration.current) return;
        if (result._tag !== "Success")
          throw new Error("Reconnect this environment to open its workspace.");
        pending.current = {
          credential: result.value.credential,
          navigate: navigate || workspaceScopesChanged(grantedScopes.current, result.value.scopes),
        };
        grantedScopes.current = result.value.scopes;
        if (pending.current.navigate) setReady(false);
        flush();
      } catch (cause) {
        if (generation !== handoffGeneration.current) return;
        if (active.current)
          setError(cause instanceof Error ? cause.message : "Workspace unavailable.");
        finishHandoff();
      }
    },
    [environmentId, finishHandoff, flush, issue],
  );

  useEffect(() => {
    active.current = true;
    void connect(true);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void connect(!authenticated.current);
      else if (refreshTimer.current) clearTimeout(refreshTimer.current);
    });
    return () => {
      active.current = false;
      pending.current = null;
      finishHandoff();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      subscription.remove();
    };
  }, [connect, finishHandoff]);

  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        if (canGoBack.current) webView.current?.goBack();
        else onOpenAppTools();
        return true;
      });
      return () => subscription.remove();
    }, [onOpenAppTools]),
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#111111" }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <WebView
          key={browserGeneration}
          ref={webView}
          source={source}
          style={{ flex: 1, backgroundColor: "#111111", opacity: ready ? 1 : 0 }}
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          allowsBackForwardNavigationGestures
          allowsInlineMediaPlayback
          setSupportMultipleWindows={false}
          originWhitelist={["http://*", "https://*"]}
          onShouldStartLoadWithRequest={(request) => {
            if (
              request.isTopFrame === false ||
              request.url === "about:blank" ||
              isWorkspaceBrowserUrl(baseUrl, request.url)
            )
              return true;
            if (/^https?:|^mailto:|^tel:/.test(request.url))
              void Linking.openURL(request.url).catch(() => setError("Could not open this link."));
            return false;
          }}
          onOpenWindow={(event) => {
            if (/^https?:/.test(event.nativeEvent.targetUrl))
              void Linking.openURL(event.nativeEvent.targetUrl).catch(() =>
                setError("Could not open this link."),
              );
          }}
          onLoadStart={() => {
            loaded.current = false;
          }}
          onLoadEnd={(event) => {
            if (!isWorkspaceBrowserUrl(baseUrl, event.nativeEvent.url)) return;
            loaded.current = true;
            if (
              authenticated.current &&
              new URL(event.nativeEvent.url).pathname !== new URL(urls.pair).pathname
            )
              setReady(true);
            flush();
            if (
              authenticated.current &&
              new URL(event.nativeEvent.url).pathname === new URL(urls.pair).pathname
            )
              void connect(true);
          }}
          onNavigationStateChange={(state) => {
            canGoBack.current = state.canGoBack;
            if (
              isWorkspaceBrowserUrl(baseUrl, state.url) &&
              new URL(state.url).pathname !== new URL(urls.pair).pathname
            )
              lastWorkspaceUrl.current = state.url;
          }}
          onContentProcessDidTerminate={() => {
            finishHandoff();
            authenticated.current = false;
            setReady(false);
            setError("The workspace stopped. Retry to reopen it.");
          }}
          onRenderProcessGone={() => {
            finishHandoff();
            authenticated.current = false;
            setReady(false);
            setError("The workspace stopped. Retry to reopen it.");
          }}
          onError={() =>
            setError("Could not load this environment. Check its connection and try again.")
          }
          onHttpError={(event) => {
            if (event.nativeEvent.statusCode >= 400)
              setError("This environment could not load the workspace.");
          }}
          onMessage={(event) => {
            if (!isWorkspaceBrowserUrl(baseUrl, event.nativeEvent.url)) return;
            const decoded = decodeWorkspaceHostMessage(event.nativeEvent.data);
            if (Option.isNone(decoded)) return;
            const message = decoded.value;
            if (message.type === "open-connections") {
              onOpenConnections();
              return;
            }
            if (message.type === "open-app-tools") {
              onOpenAppTools();
              return;
            }
            if (message.type === "authentication-failed") {
              finishHandoff();
              setError("The workspace sign-in expired. Retry or reconnect this environment.");
              return;
            }
            finishHandoff();
            authenticated.current = true;
            setError(null);
            if (navigateAfterAuth.current) {
              navigateAfterAuth.current = false;
              webView.current?.injectJavaScript(
                `location.replace(${JSON.stringify(lastWorkspaceUrl.current)}); true;`,
              );
            }
            if (refreshTimer.current) clearTimeout(refreshTimer.current);
            const delay = Date.parse(message.expiresAt) - Date.now() - 60_000;
            if (Number.isFinite(delay) && delay > 0)
              refreshTimer.current = setTimeout(() => void connect(false), delay);
          }}
        />
        {!ready || error ? (
          <View className="absolute inset-0 items-center justify-center gap-4 bg-screen px-6">
            {error ? (
              <AppText className="text-center">{error}</AppText>
            ) : (
              <>
                <ActivityIndicator />
                <AppText>Opening J1…</AppText>
              </>
            )}
            {error ? (
              <MaterialButton
                label="Retry"
                onPress={() => {
                  pending.current = null;
                  finishHandoff();
                  loaded.current = false;
                  authenticated.current = false;
                  setReady(false);
                  setError(null);
                  // A terminated Android renderer needs a new WebView, not reload().
                  setBrowserGeneration((generation) => generation + 1);
                  void connect(true);
                }}
              />
            ) : null}
            <MaterialButton tone="text" label="Connections" onPress={onOpenConnections} />
            <MaterialButton tone="text" label="Projects and app tools" onPress={onOpenAppTools} />
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
