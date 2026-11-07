import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Bot } from "@/state/store";
import { browserScope, withBrowserScope } from "@/lib/team-browser";
import { useStore } from "@/state/store";
import { buildBotBrowserDocument, type BotBrowserPage } from "./j1-browser-document";

/** The frame is a sanitized view of the original native page, never a second navigation. */
export function LightpandaPanel({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const [page, setPage] = useState<BotBrowserPage | null>(null);
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const pending = useRef(false);
  const currentPage = useRef(page);
  currentPage.current = page;
  const scope = browserScope(state.config?.team, bot.threadId);
  const path = withBrowserScope(`/api/bots/${encodeURIComponent(bot.id)}/browser/native`, scope);
  const source = useMemo(() => (page ? buildBotBrowserDocument(page) : undefined), [page]);
  const load = useCallback(
    async (action?: unknown) => {
      if (pending.current) return;
      pending.current = true;
      setBusy(true);
      try {
        const result = await api(
          path,
          action === undefined ? undefined : { method: "POST", body: JSON.stringify(action) },
        );
        if (
          !result ||
          typeof result.revision !== "string" ||
          typeof result.html !== "string" ||
          result.html.length > 500000 ||
          typeof result.url !== "string" ||
          typeof result.title !== "string"
        )
          throw new Error("The browser returned an invalid page view.");
        setPage((previous) => (previous?.revision === result.revision ? previous : result));
        setError("");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Browser unavailable.");
      } finally {
        pending.current = false;
        setBusy(false);
      }
    },
    [path],
  );
  useEffect(() => {
    setPage(null);
    void load();
    const timer = setInterval(() => {
      if (!document.hidden && document.activeElement !== frame.current) void load();
    }, 2000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const data = event.data;
      const current = currentPage.current;
      if (
        event.source !== frame.current?.contentWindow ||
        !current ||
        data?.type !== "j1-bot-browser" ||
        data.revision !== current.revision ||
        data.action?.revision !== current.revision ||
        !["click", "fill"].includes(data.action?.type)
      )
        return;
      void load(data.action);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [load]);
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2 p-3" aria-label="J1 lightweight browser">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (address.trim()) void load({ type: "navigate", url: address.trim() });
        }}
      >
        <input
          className="min-w-0 flex-1 rounded-lg bg-inset px-3 py-2 text-sm"
          aria-label="Browser address"
          placeholder={page?.url ?? "https://example.com"}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        <button
          className="rounded-lg bg-inset px-3 text-sm disabled:opacity-50"
          disabled={busy || !address.trim()}
          type="submit"
        >
          Go
        </button>
        <button
          className="rounded-lg bg-inset px-3 text-sm disabled:opacity-50"
          disabled={busy}
          type="button"
          onClick={() => void load()}
        >
          Refresh
        </button>
      </form>
      <p className="text-xs text-ink-secondary">
        Shared native Lightpanda page. Appearance can differ from a full browser.
      </p>
      {error && (
        <p role="status" className="text-xs text-ink-secondary">
          {error}
        </p>
      )}
      {!page && (
        <button
          className="self-start rounded-lg bg-accent px-3 py-2 text-sm text-accent-ink disabled:opacity-50"
          disabled={busy}
          onClick={() => void load({ type: "open" })}
        >
          Start browser
        </button>
      )}
      {source && (
        <div className="relative min-h-0 flex-1">
          <iframe
            ref={frame}
            title={`${bot.name} shared browser`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={source}
            className="h-full min-h-64 w-full border-0 bg-white"
          />
          {busy && <div className="absolute inset-0" aria-label="Updating browser" />}
        </div>
      )}
    </section>
  );
}
