import type { BotBrowserAction, BotBrowserPage, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { buildBotBrowserDocument } from "@t3tools/client-runtime/bots/browser-document";
import { readBotBrowserEvent } from "@t3tools/client-runtime/bots/browser-event";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { botBrowserPage, actOnBotBrowser } from "../../state/botBrowser";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogPopup } from "../ui/dialog";

export function BotBrowserButton(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Open browser
      </Button>
      {open ? <BotBrowserWindow {...props} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
function BotBrowserWindow({
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
  const frame = useRef<HTMLIFrameElement>(null);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const busyRef = useRef(false);
  const source = useMemo(() => {
    if (!page) return null;
    try {
      return buildBotBrowserDocument(page);
    } catch {
      return null;
    }
  }, [page]);
  const run = async (action: BotBrowserAction) => {
    if (busyRef.current) return;
    busyRef.current = true;
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
      busyRef.current = false;
      setBusy(false);
      query.refresh();
    }
  };
  const onFrameMessage = useEffectEvent((event: MessageEvent) => {
    if (event.source !== frame.current?.contentWindow || !page) return;
    const action = readBotBrowserEvent(event.data, page.revision);
    if (action) void run(action);
  });
  useEffect(() => {
    const listener = (event: MessageEvent) => onFrameMessage(event);
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, []);
  const refreshWhenIdle = useEffectEvent(() => {
    if (!document.hidden && document.activeElement !== frame.current && !busyRef.current)
      query.refresh();
  });
  useEffect(() => {
    const timer = setInterval(refreshWhenIdle, 2000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="w-[min(96vw,1200px)] max-w-none">
        <DialogHeader>
          <DialogTitle>{name}'s browser</DialogTitle>
          <DialogDescription>
            Live page from this conversation's lightweight browser. Page appearance can differ from
            a full browser.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 p-4">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (address.trim()) void run({ type: "navigate", url: address.trim() });
            }}
          >
            <Input
              aria-label="Browser address"
              value={address}
              placeholder={page?.url ?? "https://example.com"}
              onChange={(event) => setAddress(event.target.value)}
            />
            <Button type="submit" variant="outline" size="sm" disabled={busy || !page}>
              Go
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={query.refresh}
            >
              Refresh
            </Button>
          </form>
          {query.error ? (
            <div>
              <p role="status">
                This browser is unavailable. Start it to open a new page, or refresh to reconnect.
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void run({ type: "open" })}
              >
                Start browser
              </Button>
            </div>
          ) : null}
          {error ? (
            <p role="alert">The page may have changed. Refresh before trying that action again.</p>
          ) : null}
          {!source && !query.error ? <p role="status">Loading browser page...</p> : null}
          {source ? (
            <div className="relative">
              <iframe
                ref={frame}
                title={`${name} live browser`}
                sandbox="allow-scripts"
                srcDoc={source}
                className="h-[65vh] w-full border-0"
              />
              {busy ? <div className="absolute inset-0" aria-label="Updating browser" /> : null}
            </div>
          ) : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
