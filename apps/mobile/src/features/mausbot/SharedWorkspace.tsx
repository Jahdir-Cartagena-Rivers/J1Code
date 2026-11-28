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
import { Button } from "../../components/ui/Button";
import { AppText } from "../../components/ui/AppText";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import {
  decodeWorkspaceHostMessage,
  isWorkspaceBrowserUrl,
  workspaceBootstrapScript,
  workspaceBrowserUrls,
  workspaceScopesChanged,
} from "./workspace-browser";
import { WorkspaceLifecycle } from "./workspace-lifecycle";

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
  const webView = useRef<WebView<object>>(null);
  const issue = useAtomCommand(issueWorkspace, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [browserGeneration, setBrowserGeneration] = useState(0);
  const pending = useRef<{ credential: string; navigate: boolean; generation: number } | null>(
    null,
  );
  const loaded = useRef(false);
  const authenticated = useRef(false);
  const lastWorkspaceUrl = useRef(destination);
  const canGoBack = useRef(false);
  const grantedScopes = useRef<ReadonlyArray<string> | null>(null);
  const handoffScopes = useRef<ReadonlyArray<string> | null>(null);
  const navigateAfterAuth = useRef(false);
  const workspaceLifecycle = useRef<WorkspaceLifecycle | null>(null);

  // oxlint-disable-next-line j1code/no-unreasoned-state-sync -- Navigate the mounted WebView when the requested location changes.
  useEffect(() => {
    lastWorkspaceUrl.current = destination;
    if (authenticated.current && loaded.current)
      webView.current?.injectJavaScript(`location.assign(${JSON.stringify(destination)}); true;`);
  }, [destination]);

  const flush = useCallback(() => {
    if (!loaded.current || !pending.current) return;
    const handoff = pending.current;
    pending.current = null;
    navigateAfterAuth.current = handoff.navigate;
    webView.current?.injectJavaScript(
      workspaceBootstrapScript(baseUrl, handoff.credential, false, undefined, handoff.generation),
    );
  }, [baseUrl]);

  const connect = useCallback(
    async (navigate: boolean) => {
      const lifecycle = workspaceLifecycle.current;
      if (lifecycle === null) return;
      const generation = lifecycle.begin();
      if (generation === null) return;
      await issue({ environmentId, input: undefined })
        .then((result) => {
          if (!lifecycle.acceptIssue(generation)) return;
          if (result._tag !== "Success") {
            if (lifecycle.acceptFailure(generation))
              setError("Reconnect this environment to open its workspace.");
            return;
          }
          pending.current = {
            credential: result.value.credential,
            navigate:
              navigate || workspaceScopesChanged(grantedScopes.current, result.value.scopes),
            generation,
          };
          handoffScopes.current = result.value.scopes;
          if (pending.current.navigate) setReady(false);
          flush();
        })
        .catch((cause: unknown) => {
          if (lifecycle.acceptFailure(generation))
            setError(cause instanceof Error ? cause.message : "Workspace unavailable.");
        });
    },
    [environmentId, flush, issue],
  );

  // oxlint-disable-next-line j1code/no-unreasoned-state-sync -- Suspend workspace credentials while the native app is backgrounded.
  useEffect(() => {
    const lifecycle = new WorkspaceLifecycle({
      onHandoffTimeout: () => setError("Workspace sign-in timed out. Try again."),
      onRefreshNeeded: () => void connect(false),
    });
    workspaceLifecycle.current = lifecycle;
    if (AppState.currentState === "active") {
      if (lifecycle.activate()) {
        queueMicrotask(() => {
          if (workspaceLifecycle.current === lifecycle) void connect(true);
        });
      }
    } else lifecycle.background();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        if (lifecycle.foregrounded()) void connect(!authenticated.current);
      } else {
        pending.current = null;
        lifecycle.background();
      }
    });
    return () => {
      workspaceLifecycle.current = null;
      pending.current = null;
      lifecycle.dispose();
      subscription.remove();
    };
  }, [connect]);

  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        if (!canGoBack.current) return false;
        webView.current?.goBack();
        return true;
      });
      return () => subscription.remove();
    }, []),
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#111111" }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <WebView<object>
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
            workspaceLifecycle.current?.invalidate();
            authenticated.current = false;
            setReady(false);
            setError("The workspace stopped. Retry to reopen it.");
          }}
          onRenderProcessGone={() => {
            workspaceLifecycle.current?.invalidate();
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
              if (workspaceLifecycle.current?.rejectHandoff(message.handoffId)) {
                authenticated.current = false;
                setReady(false);
                setError("The workspace sign-in expired. Retry or reconnect this environment.");
              }
              return;
            }
            if (
              !workspaceLifecycle.current?.acceptAuthenticated(message.handoffId, message.expiresAt)
            )
              return;
            grantedScopes.current = handoffScopes.current;
            authenticated.current = true;
            setError(null);
            if (navigateAfterAuth.current) {
              navigateAfterAuth.current = false;
              webView.current?.injectJavaScript(
                `location.replace(${JSON.stringify(lastWorkspaceUrl.current)}); true;`,
              );
            }
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
              <Button
                label="Retry"
                onPress={() => {
                  pending.current = null;
                  workspaceLifecycle.current?.invalidate();
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
            <Button tone="text" label="Connections" onPress={onOpenConnections} />
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
