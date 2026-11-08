// J1's navigation is added to the real upstream sidebar; all Mausbot features keep their original handlers.
import { useEffect, useRef, useState } from "react";
import { openBot, openBotThread, useStore } from "@/state/store";
import { applyJ1Appearance, nativeSkinCatalog, nativeFontCatalog } from "./J1Appearance";

type Navigation = {
  active: string;
  conversation?: { botId?: string | null; threadId?: string | null };
  sidebarOpen: boolean;
  mobileOpen: boolean;
  appearance?: unknown;
  settingsHeight?: number;
  settingsPresentation?: "portal" | "overlay";
  settingsPages?: { path: string; label: string }[];
  projectsHeight?: number;
  footerHeight?: number;
};
let navigation: Navigation | undefined;
let parentOrigin: string | undefined;
let nativeSettingsSelected = false;
const listeners = new Set<() => void>();
const configuredOrigin =
  typeof location === "undefined"
    ? null
    : new URLSearchParams(location.hash.slice(1)).get("j1-origin");
export function j1Post(value: object) {
  if (parentOrigin) window.parent.postMessage({ ...value, source: "j1-mausbot" }, parentOrigin);
}
export function j1SettingsClosed() {
  if (navigation?.active.startsWith("/settings/")) j1Post({ type: "settings-close" });
}
export function j1NativeSettings() {
  if (navigation?.active.startsWith("/settings/")) {
    nativeSettingsSelected = true;
    j1Post({ type: "settings-native" });
  }
}
export function consumeNativeSettingsSelection() {
  const selected = nativeSettingsSelected;
  nativeSettingsSelected = false;
  return selected;
}
export function useJ1Navigation() {
  const [value, setValue] = useState(navigation);
  useEffect(() => {
    const update = () => setValue(navigation);
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
    };
  }, []);
  return value;
}
if (typeof window !== "undefined" && window.parent !== window && configuredOrigin) {
  window.addEventListener("message", (event) => {
    if (
      event.source !== window.parent ||
      event.origin !== configuredOrigin ||
      event.data?.source !== "j1-host"
    )
      return;
    if (event.data.type === "sidebar-scroll" && Number.isFinite(event.data.delta)) {
      const scroller = document.querySelector("[data-j1-sidebar-scroll]");
      scroller?.scrollBy({
        top: Math.max(-100_000, Math.min(100_000, event.data.delta)),
        behavior: "instant",
      });
      window.dispatchEvent(new Event("j1-navigation"));
      return;
    }
    if (event.data.type === "settings-scroll" && Number.isFinite(event.data.delta)) {
      document.querySelector("[data-j1-settings-slot]")?.parentElement?.scrollBy({
        top: Math.max(-100_000, Math.min(100_000, event.data.delta)),
        behavior: "instant",
      });
      window.dispatchEvent(new Event("j1-navigation"));
      return;
    }
    const value = event.data.navigation;
    if (!value || typeof value.active !== "string" || typeof value.sidebarOpen !== "boolean")
      return;
    parentOrigin = event.origin;
    navigation = value;
    applyJ1Appearance(value.appearance);
    document.documentElement.dataset.j1View = ["/", "/assistants"].includes(value.active)
      ? "native"
      : "project";
    for (const listener of listeners) listener();
    window.dispatchEvent(new Event("j1-navigation"));
  });
}

/** Reports the actual upstream sidebar bounds, including its native resize/collapse behavior. */
export function J1ShellBridge() {
  const currentNavigation = useJ1Navigation();
  const { state, dispatch } = useStore();
  const chief = state.bots.find((bot) => bot.chiefOfStaff && !bot.hidden);
  const openedChief = useRef(false);
  const openedConversation = useRef("");
  const connected = Boolean(currentNavigation);
  useEffect(() => {
    if (connected)
      j1Post({ type: "skin-catalog", skins: nativeSkinCatalog(), fonts: nativeFontCatalog() });
  }, [connected]);
  useEffect(() => {
    if (currentNavigation?.active !== "/") {
      openedChief.current = false;
      return;
    }
    if (chief && !openedChief.current) {
      openedChief.current = true;
      openBot(dispatch, chief, false);
    }
  }, [currentNavigation?.active, chief, dispatch]);
  const destination =
    currentNavigation?.active === "/assistants" ? currentNavigation.conversation : undefined;
  useEffect(() => {
    if (!destination?.botId || !destination.threadId) {
      openedConversation.current = "";
      return;
    }
    const id = /^[A-Za-z0-9_-]{1,120}$/;
    if (!id.test(destination.botId) || !id.test(destination.threadId)) return;
    const key = `${destination.botId}:${destination.threadId}`;
    if (openedConversation.current === key) return;
    const owner = state.bots.find((bot) => bot.id === destination.botId && !bot.hidden);
    if (!owner || !owner.tasks?.some((task) => task.threadId === destination.threadId)) return;
    openedConversation.current = key;
    // The original switchTask path loads history and enforces native access; no transcript is copied.
    openBotThread(dispatch, owner, destination.threadId, true);
  }, [destination?.botId, destination?.threadId, state.bots, dispatch]);
  useEffect(() => {
    if (!configuredOrigin || window.parent === window) return;
    const sidebar = document.querySelector<HTMLElement>("[data-sidebar]");
    let previous = "";
    const report = () => {
      const rect = sidebar?.getBoundingClientRect();
      const main = document
        .querySelector<HTMLElement>("[data-j1-main-slot]")
        ?.getBoundingClientRect();
      const slot = document.querySelector<HTMLElement>("[data-j1-project-slot]");
      const projects = slot?.getBoundingClientRect();
      const footer = document.querySelector("[data-j1-footer-slot]")?.getBoundingClientRect();
      const settings = document.querySelector<HTMLElement>("[data-j1-settings-slot]");
      const settingsRect = settings?.getBoundingClientRect();
      const settingsDialog = settings?.closest('[role="dialog"]');
      const settingsViewport = settings?.parentElement?.getBoundingClientRect();
      const scrollRect = slot?.closest("[data-j1-sidebar-scroll]")?.getBoundingClientRect() ?? rect;
      const message = {
        source: "j1-mausbot",
        type: "ready",
        navigationReady: navigation !== undefined,
        footer: footer
          ? {
              left: footer.left,
              top: footer.top,
              width: footer.width,
              height: footer.height,
              clipTop: 0,
              clipBottom: 0,
            }
          : null,
        modal: [...document.querySelectorAll('[aria-modal="true"]')].some(
          (node) => node.getClientRects().length > 0,
        ),
        settings: settingsRect
          ? {
              left: settingsRect.left,
              top: settingsRect.top,
              width: settingsRect.width,
              height: settingsRect.height,
              clipTop: Math.max(0, (settingsViewport?.top ?? 0) - settingsRect.top),
              clipBottom: Math.max(
                0,
                settingsRect.bottom - (settingsViewport?.bottom ?? innerHeight),
              ),
            }
          : null,
        settingsCovered: Boolean(
          settingsRect &&
          [
            [settingsRect.left + 2, Math.max(settingsRect.top, settingsViewport?.top ?? 0) + 2],
            [
              settingsRect.right - 2,
              Math.min(settingsRect.bottom, settingsViewport?.bottom ?? innerHeight) - 2,
            ],
            [
              settingsRect.left + settingsRect.width / 2,
              (Math.max(settingsRect.top, settingsViewport?.top ?? 0) +
                Math.min(settingsRect.bottom, settingsViewport?.bottom ?? innerHeight)) /
                2,
            ],
          ].some(
            ([x, y]) =>
              document.elementFromPoint(x!, y!)?.closest('[aria-modal="true"]') !== settingsDialog,
          ),
        ),
        left: rect ? Math.max(0, rect.right) : 0,
        top: rect ? rect.top : 0,
        main: main
          ? { left: main.left, top: main.top, width: main.width, height: main.height }
          : null,
        projects: projects
          ? {
              left: projects.left,
              top: projects.top,
              width: projects.width,
              height: projects.height,
              clipTop: Math.max(0, (scrollRect?.top ?? 0) - projects.top),
              clipBottom: Math.max(0, projects.bottom - (scrollRect?.bottom ?? innerHeight)),
            }
          : null,
      };
      const encoded = JSON.stringify(message);
      if (encoded === previous) return;
      previous = encoded;
      window.parent.postMessage(message, configuredOrigin);
    };
    const acknowledge = () => {
      previous = "";
      report();
    };
    const resize = new ResizeObserver(report);
    if (sidebar) resize.observe(sidebar);
    // Scroll events are already coalesced by the browser. An extra animation frame
    // can be suspended in an embedded view while the host's form keeps receiving input.
    const scroll = report;
    const mutation = new MutationObserver(() => {
      const slot = document.querySelector("[data-j1-project-slot]");
      if (slot) resize.observe(slot);
      const main = document.querySelector("[data-j1-main-slot]");
      if (main) resize.observe(main);
      const settings = document.querySelector("[data-j1-settings-slot]");
      if (settings) resize.observe(settings);
      const footer = document.querySelector("[data-j1-footer-slot]");
      if (footer) resize.observe(footer);
      // MutationObserver already batches DOM commits. Critical slot geometry must
      // also arrive when Chromium suspends animation frames in a hidden view.
      report();
    });
    mutation.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", report);
    // Startup waits for this acknowledgement while the frame is still hidden;
    // animation frames are suspended there. Later layout changes can be coalesced.
    window.addEventListener("j1-navigation", acknowledge);
    sidebar?.addEventListener("transitionend", report);
    const activate = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-j1-navigation], [data-j1-shared-search]")) return;
      // Original sidebar, command palette and overlays retain upstream navigation behavior.
      if (target?.closest("[data-sidebar], [data-sidebar-rail], [data-window-frame-bar]")) {
        if (navigation) navigation = { ...navigation, active: "/assistants" };
        for (const listener of listeners) listener();
        j1Post({ type: "native" });
      }
    };
    document.addEventListener("click", activate, true);
    report();
    return () => {
      resize.disconnect();
      mutation.disconnect();
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", report);
      window.removeEventListener("j1-navigation", acknowledge);
      sidebar?.removeEventListener("transitionend", report);
      document.removeEventListener("click", activate, true);
    };
  }, []);
  return null;
}

export function J1Navigation() {
  const value = useJ1Navigation();
  if (!value) return null;
  return (
    <section data-j1-navigation className="pb-2" aria-label="J1 projects">
      {value.sidebarOpen && (
        <div
          data-j1-project-slot
          className="mt-2"
          style={{ height: value.projectsHeight ?? 1 }}
          aria-label="J1 projects and chats"
        />
      )}
    </section>
  );
}
export function J1Footer() {
  const navigation = useJ1Navigation();
  if (!navigation || !navigation.sidebarOpen) return null;
  return (
    <div
      data-j1-navigation
      data-j1-footer-slot
      className="shrink-0"
      style={{ height: 32, width: 108 }}
      aria-label="J1 utilities"
    />
  );
}
