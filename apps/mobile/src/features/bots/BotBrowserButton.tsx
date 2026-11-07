import script from "@t3tools/mobile-bot-browser";
import type { BotBrowserAction, BotBrowserPage, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { readBotBrowserEvent } from "@t3tools/client-runtime/bots/browser-event";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { AppState, Modal, TextInput, View } from "react-native";
import { WebView } from "react-native-webview";
import { botBrowserPage, actOnBotBrowser } from "../../state/botBrowser";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { AppText } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { browserViewDocument } from "./browserViewDocument";

export function BotBrowserButton(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <MaterialButton tone="text" label="Open browser" onPress={() => setOpen(true)} />
      {open ? <BrowserWindow {...props} onClose={() => setOpen(false)} /> : null}
    </View>
  );
}
function BrowserWindow({
  environmentId,
  threadId,
  name,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  name: string;
  onClose: () => void;
}) {
  const [page, setPage] = useState<BotBrowserPage | null>(null);
  const query = useEnvironmentQuery(
    botBrowserPage({
      environmentId,
      input: { threadId, ...(page ? { revision: page.revision } : {}) },
    }),
  );
  useEffect(() => {
    if (query.data) setPage(query.data);
  }, [query.data]);
  const command = useAtomCommand(actOnBotBrowser, { reportFailure: false });
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const editing = useRef(false),
    pending = useRef(false);
  const source = useMemo(
    () =>
      page ? { html: browserViewDocument(page, script), baseUrl: "https://localhost/" } : null,
    [page],
  );
  const run = async (action: BotBrowserAction) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(false);
    try {
      const result = await command({ environmentId, input: { threadId, action } });
      if (result._tag !== "Success") setError(true);
      else {
        setPage((previous) =>
          previous?.revision === result.value.revision && previous.url === result.value.url
            ? previous
            : result.value,
        );
        if (action.type === "navigate") setAddress("");
      }
    } catch {
      setError(true);
    } finally {
      pending.current = false;
      setBusy(false);
      editing.current = false;
      query.refresh();
    }
  };
  const refreshWhenIdle = useEffectEvent(() => {
    if (AppState.currentState === "active" && !editing.current && !pending.current) query.refresh();
  });
  useEffect(() => {
    const timer = setInterval(refreshWhenIdle, 2000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 bg-screen pt-12">
        <View className="flex-row items-center justify-between px-4">
          <AppText>{name}'s browser</AppText>
          <MaterialButton label="Close" onPress={onClose} />
        </View>
        <AppText className="px-4">
          Live lightweight page. Appearance may differ from a full browser.
        </AppText>
        <View className="flex-row items-center gap-2 px-4">
          <TextInput
            className="flex-1 rounded-lg border border-border px-3 py-2 text-foreground"
            accessibilityLabel="Browser address"
            value={address}
            placeholder={page?.url ?? "https://example.com"}
            onChangeText={setAddress}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <MaterialButton
            label="Go"
            disabled={busy || !page}
            onPress={() => {
              if (address.trim()) void run({ type: "navigate", url: address.trim() });
            }}
          />
          <MaterialButton
            label="Refresh"
            disabled={busy}
            onPress={() => {
              editing.current = false;
              query.refresh();
            }}
          />
        </View>
        {query.error ? (
          <View className="px-4">
            <AppText>
              This browser is unavailable. Start it to open a new page, or refresh to reconnect.
            </AppText>
            <MaterialButton
              label="Start browser"
              disabled={busy}
              onPress={() => void run({ type: "open" })}
            />
          </View>
        ) : null}
        {error ? (
          <AppText className="px-4" accessibilityRole="alert">
            The page may have changed. Refresh before trying again.
          </AppText>
        ) : null}
        {source ? (
          <View className="flex-1" pointerEvents={busy ? "none" : "auto"}>
            <WebView
              source={source}
              originWhitelist={["https://localhost"]}
              onError={() => setError(true)}
              onMessage={(event) => {
                try {
                  const message: unknown = JSON.parse(event.nativeEvent.data);
                  const action = page ? readBotBrowserEvent(message, page.revision) : null;
                  if (action) void run(action);
                  if (
                    typeof message === "object" &&
                    message !== null &&
                    "type" in message &&
                    message.type === "j1-bot-browser-focus" &&
                    "editing" in message
                  )
                    editing.current = message.editing === true;
                } catch {
                  setError(true);
                }
              }}
              onShouldStartLoadWithRequest={(request) =>
                request.url === "about:blank" || request.url.startsWith("https://localhost/")
              }
            />
          </View>
        ) : (
          <AppText className="px-4">Loading browser...</AppText>
        )}
      </View>
    </Modal>
  );
}
