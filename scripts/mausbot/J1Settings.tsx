import { useEffect, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { consumeNativeSettingsSelection, j1Post, useJ1Navigation } from "./J1Navigation";
import { j1Request } from "../j1-native-client";

export function J1SettingsBridge() {
  const navigation = useJ1Navigation();
  const { dispatch } = useStore();
  const active = navigation?.active;
  const previous = useRef(active);
  useEffect(() => {
    if (!active) return;
    const leavingJ1Settings = previous.current?.startsWith("/settings/");
    previous.current = active;
    if (active.startsWith("/settings/")) {
      consumeNativeSettingsSelection();
      dispatch({ type: "toggleAppSettings", open: true, section: "general" });
    } else if (
      active !== "/assistants" ||
      (leavingJ1Settings && !consumeNativeSettingsSelection())
    ) {
      dispatch({ type: "toggleAppSettings", open: false });
    }
  }, [active, dispatch]);
  useEffect(() => {
    const origin = new URLSearchParams(location.hash.slice(1)).get("j1-origin");
    const focus = (event: MessageEvent) => {
      if (
        !origin ||
        event.origin !== origin ||
        event.source !== parent ||
        event.data?.source !== "j1-host" ||
        event.data.type !== "settings-focus-source"
      )
        return;
      const dialog = document.querySelector('[data-settings-sheet] [role="dialog"]');
      const controls = [
        ...(dialog?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]",
        ) ?? []),
      ].filter((node) => node.checkVisibility());
      (event.data.edge === "end" ? controls.at(-1) : controls[0])?.focus();
    };
    window.addEventListener("message", focus);
    return () => window.removeEventListener("message", focus);
  }, []);
  return null;
}

type Result = { path: string; hash: string; label: string };
export function J1SettingsLinks({ query }: { query: string }) {
  const navigation = useJ1Navigation();
  const embedded = Boolean(navigation);
  const [result, setResult] = useState<{ query: string; rows: Result[]; error?: string } | null>(
    null,
  );
  useEffect(() => {
    if (!embedded || query.trim().length < 2) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void j1Request("settingsSearch", { query: query.slice(0, 1000) })
        .then((value) => {
          if (
            !Array.isArray(value) ||
            value.length > 20 ||
            value.some(
              (row) =>
                !row ||
                typeof row.path !== "string" ||
                typeof row.hash !== "string" ||
                typeof row.label !== "string",
            )
          )
            throw new Error("Invalid settings results.");
          if (active) setResult({ query, rows: value });
        })
        .catch(() => {
          if (active)
            setResult({
              query,
              rows: [],
              error: "Chat settings search is unavailable. Browse the sections below.",
            });
        });
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query, embedded]);
  if (!navigation) return null;
  const pages = navigation.settingsPages ?? [];
  const results = result?.query === query ? result.rows : [];
  const error = result?.query === query ? result.error : undefined;
  const filtered = pages.filter(
    (page) => !query.trim() || page.label.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <div role="group" aria-label="Chat and project settings" className="flex flex-col gap-0.5 pb-2">
      <div className="px-[9px] pb-1 pt-2 text-[12px] font-medium leading-4 text-ink-tertiary">
        Chats and projects
      </div>
      {error && <p className="px-[9px] text-[12px] text-danger">{error}</p>}
      {query.trim().length >= 2 && !error && filtered.length === 0 && (
        <p role="status" className="px-[9px] text-[12px] text-ink-secondary">
          {result?.query !== query
            ? "Searching chat settings…"
            : results.length === 0
              ? "No matching chat settings."
              : ""}
        </p>
      )}
      {[...filtered.map((page) => ({ ...page, hash: "" })), ...results].map((page) => (
        <button
          key={`${page.path}#${page.hash}`}
          type="button"
          data-j1-settings-link={page.path}
          onClick={() => j1Post({ type: "settings-navigate", path: page.path, hash: page.hash })}
          aria-current={navigation.active === page.path ? "page" : undefined}
          className={cn(
            "flex min-h-8 shrink-0 cursor-pointer items-center gap-[9px] rounded-lg px-[9px] py-1 text-left text-[13px] text-ink transition-colors motion-reduce:transition-none",
            navigation.active === page.path ? "bg-ink/[0.08]" : "hover:bg-ink/[0.06]",
          )}
        >
          <Settings2 size={15} className="shrink-0" />
          {page.label}
        </button>
      ))}
    </div>
  );
}

/** J1 renders its original settings forms in this rectangle; the upstream modal owns the shell and navigation. */
export function J1SettingsSlot() {
  const reverse = useRef(false);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Tab") reverse.current = event.shiftKey;
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  return (
    <div
      data-j1-settings-slot
      tabIndex={0}
      className="h-full min-h-0 flex-1 outline-none"
      aria-label="Chat and project settings content"
      onFocus={() => j1Post({ type: "settings-focus", edge: reverse.current ? "end" : "start" })}
    />
  );
}
