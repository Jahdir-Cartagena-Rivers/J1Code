import { useEffect, useRef, useState } from "react";
import {
  Archive,
  Camera,
  Database,
  Folder,
  GitBranch,
  Keyboard,
  Scale,
  Settings2,
} from "lucide-react";
import type { AppSettingsSection } from "@/state/store";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import {
  consumeNativeSettingsSelection,
  j1Post,
  j1NativeSettings,
  useJ1Navigation,
} from "./J1Navigation";
import { j1Request } from "../j1-native-client";

// One native category owns each purpose. Original J1 URLs remain valid deep links.
const sections = {
  "/settings/general": "general",
  "/settings/appearance": "appearance",
  "/settings/providers": "engines",
  "/settings/connections": "companion",
  "/settings/diagnostics": "activity",
  "/settings/integrations": "computer",
  "/settings/storage": "backups",
} as const satisfies Record<string, AppSettingsSection>;
export const j1SettingsSection = (path: string) => sections[path as keyof typeof sections];
export const j1SettingsPath = (section: AppSettingsSection) =>
  Object.entries(sections).find(([, value]) => value === section)?.[0];
export const j1SettingsLabel = (section: AppSettingsSection, original: string) =>
  section === "computer"
    ? "Browser & devices"
    : section === "backups"
      ? "Storage & backups"
      : original;
const extraPages = {
  "/settings/projects": { group: "computers", icon: Folder },
  "/settings/keybindings": { group: "you", icon: Keyboard },
  "/settings/snap-shot": { group: "computers", icon: Camera },
  "/settings/hive-mind": { group: "ai", icon: Database },
  "/settings/source-control": { group: "computers", icon: GitBranch },
  "/settings/archived": { group: "account", icon: Archive },
  "/settings/open-source-licenses": { group: "account", icon: Scale },
} as const;
export function j1ExtraPages(pages: { path: string; label: string }[] = [], group: string) {
  return pages.filter((page) => extraPages[page.path as keyof typeof extraPages]?.group === group);
}
export function j1OpenSettings(section: AppSettingsSection) {
  const path = j1SettingsPath(section);
  if (path) j1Post({ type: "settings-navigate", path });
  else j1NativeSettings();
}
export function j1Focusable(root: ParentNode): HTMLElement[] {
  const result: HTMLElement[] = [];
  for (const node of root.querySelectorAll<HTMLElement>("*")) {
    if (
      node.matches(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      ) &&
      node.checkVisibility()
    )
      result.push(node);
    if (node.shadowRoot) result.push(...j1Focusable(node.shadowRoot));
  }
  return result;
}
export function j1SettingsPopupOpen(dialog: HTMLElement | null) {
  return [
    ...(dialog
      ?.querySelector("[data-j1-settings-slot]")
      ?.shadowRoot?.querySelectorAll<HTMLElement>(
        '[data-slot$="-popup"], [data-slot="select-positioner"]',
      ) ?? []),
  ].some((node) => node.checkVisibility());
}
export function j1ActiveElement(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}
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
      dispatch({
        type: "toggleAppSettings",
        open: true,
        section: j1SettingsSection(active) ?? "general",
      });
    } else if (
      active !== "/assistants" ||
      (leavingJ1Settings && !consumeNativeSettingsSelection())
    ) {
      dispatch({ type: "toggleAppSettings", open: false });
    }
  }, [active, dispatch]);
  useEffect(() => {
    const origin = new URLSearchParams(location.hash.slice(1)).get("j1-origin");
    const receive = (event: MessageEvent) => {
      if (
        !origin ||
        event.origin !== origin ||
        event.source !== parent ||
        event.data?.source !== "j1-host" ||
        event.data.type !== "settings-focus-source"
      )
        return;
      const slot = document.querySelector<HTMLElement>("[data-j1-settings-slot]");
      const dialog = slot?.closest<HTMLElement>('[role="dialog"]');
      if (!slot || !dialog) return;
      const controls = j1Focusable(dialog),
        index = controls.indexOf(slot);
      controls[
        (index + (event.data.edge === "before" ? -1 : 1) + controls.length) % controls.length
      ]?.focus();
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  return null;
}

type Result = { path: string; hash: string; label: string };
export function J1SettingsLinks({ query, group }: { query: string; group: string }) {
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
              error: "Additional settings search is unavailable. Browse the sections below.",
            });
        });
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query, embedded]);
  if (!navigation) return null;
  const pages = j1ExtraPages(navigation.settingsPages, group);
  const results =
    result?.query === query
      ? result.rows.filter((row) => {
          const section = j1SettingsSection(row.path);
          return section
            ? {
                general: "you",
                appearance: "you",
                engines: "ai",
                companion: "you",
                activity: "account",
                computer: "computers",
                backups: "account",
              }[section] === group
            : extraPages[row.path as keyof typeof extraPages]?.group === group;
        })
      : [];
  const error = result?.query === query ? result.error : undefined;
  const filtered = pages.filter(
    (page) => !query.trim() || page.label.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <div className="flex flex-col gap-0.5">
      {error && <p className="px-[9px] text-[12px] text-danger">{error}</p>}
      {[...filtered.map((page) => ({ ...page, hash: "" })), ...results].map((page) => {
        const Icon = extraPages[page.path as keyof typeof extraPages]?.icon ?? Settings2;
        return (
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
            <Icon size={15} className="shrink-0" />
            {page.label}
          </button>
        );
      })}
    </div>
  );
}

/** The host portals its existing forms here, in the native modal's single scroll flow. */
export function J1SettingsSlot() {
  const navigation = useJ1Navigation();
  const reverse = useRef(false);
  const overlay = navigation?.settingsPresentation === "overlay";
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
      className="min-h-px shrink-0 outline-none"
      tabIndex={overlay ? 0 : undefined}
      style={
        overlay
          ? { height: Math.max(1, Math.min(100_000, navigation?.settingsHeight ?? 1)) }
          : undefined
      }
      onFocus={() => {
        if (overlay) j1Post({ type: "settings-focus", edge: reverse.current ? "end" : "start" });
      }}
    />
  );
}
