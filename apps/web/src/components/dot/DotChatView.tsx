import { DotIntegrationError, type DotChatMessage, type DotChatSnapshot } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { isElectron } from "../../env";
import { runPrimaryHttp } from "../../lib/runtime";
import { cn, randomUUID } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { mergeDotMessages, nextDotSend } from "./dotChat.logic";
import { useDotChatDraftStore } from "./dotChatDraftStore";

const subscribeVisibility = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};
const readVisible = () => document.visibilityState === "visible";

const isDotIntegrationError = Schema.is(DotIntegrationError);
const describeError = (error: unknown, fallback: string) =>
  isDotIntegrationError(error) ? error.message : fallback;

const STATUS_LABEL: Record<DotChatMessage["status"], string> = {
  queued: "Waiting for Dot to pick this up",
  delivered: "Delivered to Dot",
  answered: "Answered",
  failed: "Not delivered",
};

/** Native chat with the user's own ChatGPT Dot, relayed through its plugin subscription. */
export function DotChatView() {
  const environmentId = usePrimaryEnvironmentId() ?? undefined;
  const visible = useSyncExternalStore(subscribeVisibility, readVisible, () => true);
  // A new object reloads; a null connection asks the server for its default chat connection.
  const [loadRequest, setLoadRequest] = useState<{ connectionId: string | null }>({
    connectionId: null,
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [connections, setConnections] = useState<DotChatSnapshot["connections"]>([]);
  const [messages, setMessages] = useState<readonly DotChatMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [liveStopped, setLiveStopped] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const draftKey = JSON.stringify([environmentId ?? "primary", activeId ?? "unpaired"]);
  const draft = useDotChatDraftStore((state) => state.drafts[draftKey]?.text ?? "");
  const setDraft = (text: string) => {
    const store = useDotChatDraftStore.getState();
    store.put(draftKey, { text, pending: store.drafts[draftKey]?.pending ?? null });
  };
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  const revisionRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Returns false when the snapshot belongs to a connection the user switched away from.
  const applySnapshot = useEffectEvent((snapshot: DotChatSnapshot, replace: boolean) => {
    if (activeRef.current !== null && snapshot.connectionId !== activeRef.current) return false;
    activeRef.current = snapshot.connectionId;
    revisionRef.current = snapshot.revision;
    setActiveId(snapshot.connectionId);
    setConnections(snapshot.connections);
    setMessages((current) =>
      replace ? snapshot.messages : mergeDotMessages(current, snapshot.messages),
    );
    if (replace) setOlderCursor(snapshot.beforeCursor);
    return true;
  });
  const reload = () => {
    setLoadError(null);
    setLoadRequest({ connectionId: activeRef.current });
  };

  useEffect(() => {
    let current = true;
    const { connectionId } = loadRequest;
    void runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) =>
          client.dot.chat({ headers: {}, query: connectionId ? { connectionId } : {} }),
        ),
      ),
    )
      .then((snapshot) => {
        if (!current || !applySnapshot(snapshot, true)) return;
        setLoadError(null);
        setLiveStopped(false);
        setLoadedKey((key) => key + 1);
      })
      .catch((error: unknown) => {
        if (current) setLoadError(describeError(error, "Could not load your Dot chat."));
      });
    return () => {
      current = false;
    };
  }, [loadRequest]);

  // One long wait at a time while the page is visible; the server answers on change or after
  // its timeout. Any failure stops the loop until the user refreshes.
  useEffect(() => {
    if (loadedKey === 0 || !visible) return;
    let current = true;
    void (async () => {
      for (;;) {
        const connectionId = activeRef.current;
        const update = await runPrimaryHttp(
          PrimaryEnvironmentHttpClient.pipe(
            Effect.flatMap((client) =>
              client.dot.waitChat({
                headers: {},
                payload: connectionId
                  ? { connectionId, revision: revisionRef.current }
                  : { revision: revisionRef.current },
              }),
            ),
          ),
        );
        if (!current) return;
        if (update.snapshot) applySnapshot(update.snapshot, false);
      }
    })().catch(() => {
      if (current) setLiveStopped(true);
    });
    return () => {
      current = false;
    };
  }, [loadedKey, visible]);

  const lastMessageId = messages.at(-1)?.id;
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && lastMessageId) element.scrollTop = element.scrollHeight;
  }, [lastMessageId]);

  const switchConnection = (id: string) => {
    if (id === activeRef.current) return;
    activeRef.current = id;
    setActiveId(id);
    setMessages([]);
    setOlderCursor(null);
    setSendError(null);
    setLoadError(null);
    setLoadRequest({ connectionId: id });
  };

  const loadOlder = async () => {
    const connectionId = activeRef.current;
    if (!connectionId || !olderCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            client.dot.chat({ headers: {}, query: { connectionId, before: olderCursor } }),
          ),
        ),
      );
      if (activeRef.current !== connectionId) return;
      setMessages((current) => mergeDotMessages(page.messages, current));
      setOlderCursor(page.beforeCursor);
    } catch (error) {
      setLoadError(describeError(error, "Could not load older messages."));
    } finally {
      setLoadingOlder(false);
    }
  };

  const send = async () => {
    const text = draft.trim();
    const connectionId = activeRef.current;
    if (
      !text ||
      !connectionId ||
      sending ||
      !connections.some((c) => c.id === connectionId && c.connected)
    )
      return;
    const store = useDotChatDraftStore.getState();
    const request = nextDotSend(
      store.drafts[draftKey]?.pending ?? null,
      connectionId,
      text,
      randomUUID,
    );
    store.put(draftKey, { text: draft, pending: request });
    setSending(true);
    setSendError(null);
    try {
      const message = await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) => client.dot.sendChat({ headers: {}, payload: request })),
        ),
      );
      const current = useDotChatDraftStore.getState().drafts[draftKey];
      if (current?.pending?.requestId === request.requestId)
        useDotChatDraftStore
          .getState()
          .put(draftKey, { text: current.text.trim() === text ? "" : current.text, pending: null });
      if (activeRef.current === message.connectionId)
        setMessages((current) => mergeDotMessages(current, [message]));
    } catch (error) {
      setSendError(
        describeError(
          error,
          "Message not sent. Your draft is kept, and sending it again will not duplicate it.",
        ),
      );
    } finally {
      setSending(false);
    }
  };

  const active = connections.find((connection) => connection.id === activeId);
  const connected = active?.connected === true;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <span className="text-sm font-medium text-foreground">Dot</span>
          {active ? (
            <span className="text-xs text-muted-foreground">
              {connected ? "Connected" : "Not connected"}
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-2 [-webkit-app-region:no-drag]">
            {connections.length > 1 ? (
              <Select
                value={activeId ?? ""}
                onValueChange={(value) => {
                  if (value) switchConnection(value);
                }}
              >
                <SelectTrigger size="sm" aria-label="Dot connection">
                  <SelectValue>{active?.label ?? "Choose a connection"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {connections.map((connection) => (
                    <SelectItem key={connection.id} value={connection.id}>
                      {connection.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            <Button size="icon-sm" variant="ghost" aria-label="Refresh Dot chat" onClick={reload}>
              <RefreshIcon size="md" />
            </Button>
          </div>
        </WorkspacePageHeader>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
            {olderCursor ? (
              <Button
                size="sm"
                variant="ghost"
                className="self-center"
                disabled={loadingOlder}
                onClick={() => void loadOlder()}
              >
                {loadingOlder ? "Loading…" : "Load older messages"}
              </Button>
            ) : null}
            {messages.map((message) => (
              <DotMessage key={message.id} message={message} environmentId={environmentId} />
            ))}
            {loadedKey > 0 && !connected ? (
              <DotOnboarding connectionId={activeId} hasHistory={messages.length > 0} />
            ) : null}
          </div>
        </div>

        <div className="mx-auto w-full max-w-3xl space-y-2 px-4 pb-4">
          {loadError || liveStopped ? (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 text-sm text-destructive"
            >
              <span>{loadError ?? "Live updates stopped. Refresh to reconnect."}</span>
              <Button size="xs" variant="outline" onClick={reload}>
                Refresh
              </Button>
            </div>
          ) : null}
          {sendError ? (
            <p role="alert" className="text-sm text-destructive">
              {sendError}
            </p>
          ) : null}
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <Textarea
              aria-label="Message Dot"
              placeholder={connected ? "Message Dot" : "Connect Dot to send messages"}
              value={draft}
              maxLength={40000}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <Button type="submit" disabled={!connected || sending || !draft.trim()}>
              {sending ? "Sending…" : "Send"}
            </Button>
          </form>
        </div>
      </div>
    </SidebarInset>
  );
}

function DotMessage({
  message,
  environmentId,
}: {
  message: DotChatMessage;
  environmentId: Parameters<typeof ChatMarkdown>[0]["environmentId"];
}) {
  const user = message.role === "user";
  const failed = message.status === "failed";
  return (
    <div className={cn("flex flex-col gap-1", user && "items-end")}>
      {user ? (
        <div className="max-w-[85%] rounded-2xl bg-secondary px-3 py-2 text-sm whitespace-pre-wrap">
          {message.text}
        </div>
      ) : (
        <ChatMarkdown text={message.text} cwd={undefined} environmentId={environmentId} />
      )}
      {user || failed ? (
        <span className={cn("text-xs", failed ? "text-destructive" : "text-muted-foreground")}>
          {failed ? (message.error ?? STATUS_LABEL.failed) : STATUS_LABEL[message.status]}
        </span>
      ) : null}
    </div>
  );
}

function DotOnboarding({
  connectionId,
  hasHistory,
}: {
  connectionId: string | null;
  hasHistory: boolean;
}) {
  return (
    <div className="space-y-2 rounded-xl border border-border p-4 text-sm">
      <p className="font-medium">
        {hasHistory ? "Dot is disconnected" : "Connect your Dot to chat here"}
      </p>
      <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
        <li>
          Open{" "}
          <Link to="/settings/connections" className="underline">
            Settings › Connections › ChatGPT Dot
          </Link>{" "}
          and prepare a connection with Native Dot chat enabled.
        </li>
        <li>In ChatGPT, connect or reconnect the J1 plugin for your Dot.</li>
        <li>
          Ask your Dot to subscribe to the <code>j1.dot.message</code> event
          {connectionId ? (
            <>
              {" "}
              with connectionId <code className="select-all">{connectionId}</code>
            </>
          ) : null}{" "}
          and answer each message with <code>post_dot_reply(messageId, text)</code>, without
          workers.
        </li>
      </ol>
    </div>
  );
}
