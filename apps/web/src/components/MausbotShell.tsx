import { recoverMausbotView } from "./mausbotViewRecovery";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { resolveAssetUrl } from "../assets/assetUrls";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { readThreadShell } from "../state/entities";
import { usePreparedConnection } from "../state/session";
import { openMausbot, setMausbotApprovalMode } from "../state/mausbot";
import { useAtomCommand } from "../state/use-atom-command";
import { useSidebar } from "./ui/sidebar";
import { squashAtomCommandFailure } from "@j1code/client-runtime/state/runtime";
import {
  EnvironmentId,
  ThreadId,
  MausbotApprovalModeInput,
  MausbotShortcutRequest,
  mausbotSavedAppLaunchUrl,
} from "@j1code/contracts";
import { routeEndpointUrl } from "@j1code/shared/routeEndpointUrl";
import { callMausbotRouting, isMausbotRoutingMethod } from "@j1code/client-runtime/mausbot-routing";
import { serverEnvironment } from "../state/server";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { localMausbotHost } from "./mausbotHost";
import { registerMausbotSearch } from "./mausbotSearch";
import { openCommandPalette } from "../commandPaletteBus";
import { isWindowsPlatform, randomUUID } from "../lib/utils";
import { SETTINGS_SECTION_LABELS, searchSettings } from "./settings/settingsSearch";
import { useAvailableSettingsSearchItems } from "./settings/useAvailableSettingsSearchItems";
import { getAppModalReturnHref, useNavigateToMainApp } from "./sidebar/mainAppLocation";
import { createPortal } from "react-dom";
import { useMausbotSlotPortal } from "./MausbotSettingsPortal";
import { PortalContainer } from "./ui/portal-container";
import { MAUSBOT_THEME_ROLES } from "@j1code/shared/mausbotAppearance";
import { getThemeColorVariable, setWorkspaceThemes } from "../themePalette";
import { decodeMausbotThemes } from "./mausbotAppearance";
import { useStableCallback } from "../hooks/useStableCallback";
import { useTheme } from "../hooks/useTheme";
import { useClientSettings } from "../hooks/useSettings";
import { installMausbotFonts } from "./mausbotFonts";
import { isElectron } from "../env";
import { WorkspacePageHeader } from "./WorkspacePageHeader";
import { nativeOverlayClip, type FrameOverlay } from "./MausbotShell.layout";
import { useThreadRouteRef } from "../hooks/useThreadRouteTarget";
import { observeResize } from "../lib/observeResize";
import { toastManager } from "./ui/toast";

const decodeApprovalMode = Schema.decodeUnknownSync(MausbotApprovalModeInput);
const decodeShortcutRequest = Schema.decodeUnknownOption(MausbotShortcutRequest);
const viewKeyFromRuntimeUrl = (url: string) =>
  /\/api\/mausbot\/runtime\/([a-f0-9]{64})\//.exec(new URL(url).pathname)?.[1];
const settingsLabels = {
  ...SETTINGS_SECTION_LABELS,
  "/settings/diagnostics": "Diagnostics",
  "/settings/open-source-licenses": "Open source licenses",
};
const settingsPages = Object.entries(settingsLabels).map(([path, label]) => ({ path, label }));
const isSettingsPath = (value: unknown): value is keyof typeof settingsLabels =>
  typeof value === "string" && Object.hasOwn(settingsLabels, value);

type ProjectBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
  clipTop: number;
  clipBottom: number;
};
type ShellBounds = {
  overlays: FrameOverlay[];
  left: number;
  top: number;
  projects: ProjectBounds | null;
  footer: ProjectBounds | null;
  modal: boolean;
  main: { left: number; top: number; width: number; height: number } | null;
};
const WorkspaceState = createContext({
  error: "",
  busy: false,
  retry: () => {},
});
export const useMausbotWorkspaceState = () => useContext(WorkspaceState);
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 100_000;
}
function projectBounds(value: unknown): ProjectBounds | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const keys = ["left", "top", "width", "height", "clipTop", "clipBottom"] as const;
  if (!keys.every((key) => finite(record[key]))) return null;
  const bounds = value as ProjectBounds;
  return bounds.width > 0 && bounds.height > 0 ? bounds : null;
}

/** One upstream sidebar owns navigation; J1's existing project controls occupy its reserved section. */
export function MausbotShell({
  sidebar,
  navigation,
  footer,
  children,
}: {
  sidebar: ReactNode;
  navigation: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const routeEnvironmentId = useThreadRouteRef()?.environmentId ?? null;
  const [activeEnvironmentId, setActiveEnvironmentId] = useState<EnvironmentId | null>(null);
  const requestedEnvironment =
    pathname === "/assistants" ? new URLSearchParams(searchStr).get("environmentId") : null;
  const requestedApp =
    pathname === "/assistants" ? new URLSearchParams(searchStr).get("savedApp") : null;
  const savedApp = requestedApp && mausbotSavedAppLaunchUrl(requestedApp) ? requestedApp : null;
  const environmentId = savedApp
    ? primaryEnvironmentId
    : requestedEnvironment
      ? EnvironmentId.make(requestedEnvironment)
      : (routeEnvironmentId ?? activeEnvironmentId ?? primaryEnvironmentId);
  const environment = useEnvironment(environmentId);
  if (
    (requestedEnvironment || routeEnvironmentId) &&
    environment &&
    activeEnvironmentId !== environment.environmentId
  ) {
    setActiveEnvironmentId(environment.environmentId);
  }
  const connection = usePreparedConnection(environmentId);
  const base = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const enabled = environment?.serverConfig?.environment.capabilities.mausbot === true;
  const connected = environment?.connection.phase === "connected";
  const open = useStableCallback(useAtomCommand(openMausbot, { reportFailure: false }));
  const setApprovalMode = useAtomCommand(setMausbotApprovalMode, { reportFailure: false });
  const routingList = useAtomCommand(serverEnvironment.routingList, { reportFailure: false });
  const routingPrepare = useAtomCommand(serverEnvironment.routingPrepare, { reportFailure: false });
  const routingConfirm = useAtomCommand(serverEnvironment.routingConfirm, { reportFailure: false });
  const serverOs = environment?.serverConfig?.environment.platform?.os;
  const serverPlatform = serverOs === "windows" ? "win32" : serverOs;
  const [observedNativeHost, setObservedNativeHost] = useState<{
    base: string | null;
    platform: string | undefined;
    capabilities: ReturnType<typeof localMausbotHost>;
  } | null>(null);
  // oxlint-disable-next-line j1code/no-unreasoned-state-sync -- Read synchronous Electron IPC when the connected server changes, outside render.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- The initial desktop capability snapshot comes from Electron IPC.
    setObservedNativeHost({
      base,
      platform: serverPlatform,
      capabilities: connected ? localMausbotHost(window.desktopBridge, base, serverPlatform) : null,
    });
  }, [base, connected, serverPlatform]);
  const nativeHost =
    connected && observedNativeHost?.base === base && observedNativeHost.platform === serverPlatform
      ? observedNativeHost.capabilities
      : null;
  const capture = useRef<Promise<string | null> | null>(null);
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const settingsSearchItems = useAvailableSettingsSearchItems();
  const { refreshTheme } = useTheme();
  const chatWidth = useClientSettings((settings) => settings.chatWidth);
  const { open: sidebarOpen, openMobile, setOpenMobile, toggleSidebar } = useSidebar();
  const frame = useRef<HTMLIFrameElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const projectContent = useRef<HTMLDivElement>(null);
  const footerContent = useRef<HTMLDivElement>(null);
  const lastNavigation = useRef("");
  const [frameAccess, setFrameAccess] = useState(false);
  const [slotHeights, setSlotHeights] = useState({
    projectsHeight: 1,
    footerHeight: 32,
  });
  const handshake = useRef<number | null>(null);
  const [view, setView] = useState<{ key: string; url: string } | null>(null);
  const [bounds, setBounds] = useState<ShellBounds | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = environmentId && base ? `${environmentId}:${base}` : "";
  const startupKey = `${key}:${attempt}`;
  const [finishedStartup, setFinishedStartup] = useState("");
  const [errorState, setErrorState] = useState<{ key: string; message: string } | null>(null);
  const error = errorState?.key === startupKey ? errorState.message : "";
  const setError = useStableCallback((message: string) =>
    setErrorState(message ? { key: startupKey, message } : null),
  );
  const busy = enabled && connected && finishedStartup !== startupKey;
  // oxlint-disable-next-line j1code/no-unreasoned-state-sync -- Dispose the iframe handshake timer on unmount.
  useEffect(
    () => () => {
      if (handshake.current !== null) window.clearTimeout(handshake.current);
    },
    [],
  );
  const current = view?.key === key ? view : null;
  const savedAppWindows = nativeHost?.savedAppWindows === true;
  // oxlint-disable-next-line j1code/no-unreasoned-state-sync -- Open a Windows shortcut after its authenticated local runtime is ready.
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!savedApp || !savedAppWindows || !bridge?.openMausbotSavedApp || !current) return;
    const viewKey = viewKeyFromRuntimeUrl(current.url);
    if (viewKey === undefined) return;
    let active = true;
    void bridge
      .openMausbotSavedApp({ appId: savedApp, viewKey })
      .catch(() => false)
      .then((opened) => {
        if (!active) return;
        if (!opened)
          toastManager.add({ type: "error", title: "The saved app could not be opened" });
        void navigate({ to: "/assistants", search: {}, replace: true });
      });
    return () => {
      active = false;
    };
  }, [current, navigate, savedApp, savedAppWindows]);
  const ready = enabled && current !== null && bounds !== null;
  const initializing = !error && (!environment?.serverConfig || (enabled && !ready));
  const hostSettingsOpen = pathname === "/settings" || pathname.startsWith("/settings/");
  const projectPortal = useMausbotSlotPortal(
    frame,
    ready && frameAccess,
    "[data-j1-project-slot]",
    "navigation",
  );
  const footerPortal = useMausbotSlotPortal(
    frame,
    ready && frameAccess,
    "[data-j1-footer-slot]",
    "footer",
  );
  // oxlint-disable-next-line j1code/no-unreasoned-state-sync -- Keep native workspace controls aligned with the measured iframe.
  useEffect(() => {
    if (!ready) return;
    const root = document.documentElement;
    const previous = root.style.getPropertyValue("--workspace-controls-top");
    const measure = () =>
      root.style.setProperty(
        "--workspace-controls-top",
        `${(shell.current?.getBoundingClientRect().top ?? 0) + (bounds?.main?.top ?? bounds?.top ?? 0)}px`,
      );
    measure();
    const stopObserving = shell.current ? observeResize(shell.current, measure) : undefined;
    window.addEventListener("resize", measure);
    return () => {
      stopObserving?.();
      window.removeEventListener("resize", measure);
      if (previous) root.style.setProperty("--workspace-controls-top", previous);
      else root.style.removeProperty("--workspace-controls-top");
    };
  }, [ready, bounds?.top, bounds?.main?.top]);
  const projectsMounted = Boolean(ready && bounds?.projects && sidebarOpen);
  const footerMounted = Boolean(ready && bounds?.footer && sidebarOpen);
  // oxlint-disable-next-line j1code/no-unreasoned-state-sync -- Send measured host portal dimensions to the embedded runtime.
  useEffect(() => {
    if (!projectsMounted && !footerMounted) return;
    const measure = () => {
      const next = {
        projectsHeight: Math.max(
          1,
          Math.ceil(projectContent.current?.getBoundingClientRect().height ?? 1),
        ),
        footerHeight: Math.max(
          1,
          Math.ceil(footerContent.current?.getBoundingClientRect().height ?? 40),
        ),
      };
      setSlotHeights((previous) =>
        previous.projectsHeight === next.projectsHeight &&
        previous.footerHeight === next.footerHeight
          ? previous
          : next,
      );
    };
    const elements = [projectContent.current, footerContent.current].filter(
      (element): element is HTMLDivElement => element !== null,
    );
    measure();
    return observeResize(elements, measure);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Moving a portal changes the underlying observed node.
  }, [projectsMounted, footerMounted, projectPortal, footerPortal]);
  const scrollNavigation = (delta: number) => {
    if (!current) return;
    frame.current?.contentWindow?.postMessage(
      { source: "j1-host", type: "sidebar-scroll", delta },
      new URL(current.url).origin,
    );
  };
  // oxlint-disable-next-line j1code/no-unreasoned-state-sync -- Forward external wheel and touch input to the iframe scrollbar.
  useEffect(() => {
    const contents = [projectContent.current].filter(
      (node): node is HTMLDivElement => node !== null,
    );
    if (!projectsMounted || projectPortal) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      scrollNavigation(
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1),
      );
    };
    let touch: { x: number; y: number } | null = null;
    const touchStart = (event: TouchEvent) => {
      const point = event.touches.length === 1 ? event.touches[0] : undefined;
      touch = point ? { x: point.clientX, y: point.clientY } : null;
    };
    const touchMove = (event: TouchEvent) => {
      const point = event.touches.length === 1 ? event.touches[0] : undefined;
      if (!touch || !point) return;
      const delta = touch.y - point.clientY;
      if (Math.abs(delta) >= Math.abs(touch.x - point.clientX)) {
        event.preventDefault();
        scrollNavigation(delta);
      }
      touch = { x: point.clientX, y: point.clientY };
    };
    for (const content of contents) {
      content.addEventListener("wheel", wheel, { passive: false });
      content.addEventListener("touchstart", touchStart, { passive: true });
      content.addEventListener("touchmove", touchMove, { passive: false });
    }
    return () => {
      for (const content of contents) {
        content.removeEventListener("wheel", wheel);
        content.removeEventListener("touchstart", touchStart);
        content.removeEventListener("touchmove", touchMove);
      }
    };
  }, [projectsMounted, scrollNavigation, projectPortal]);
  const searches = useRef(
    new Map<
      string,
      { resolve: (value: unknown) => void; reject: (error: Error) => void; finish: () => void }
    >(),
  );
  const searchCall = (
    method: "search" | "land",
    input: string,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (!current || !frame.current?.contentWindow || signal?.aborted)
      return Promise.reject(new Error("The bot environment is not connected."));
    if (searches.current.size >= 16)
      return Promise.reject(new Error("Too many search requests are open."));
    const requestId = randomUUID();
    const target = frame.current.contentWindow;
    return new Promise((resolve, reject) => {
      const finish = () => {
        window.clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        searches.current.delete(requestId);
      };
      const abort = () => {
        finish();
        reject(new Error("Search cancelled."));
      };
      const timer = window.setTimeout(() => {
        finish();
        reject(new Error("Bot search timed out."));
      }, 10_000);
      searches.current.set(requestId, { resolve, reject, finish });
      signal?.addEventListener("abort", abort, { once: true });
      target.postMessage(
        { source: "j1-host", type: "search-call", requestId, method, input },
        new URL(current.url).origin,
      );
    });
  };
  // oxlint-disable-next-line j1code/no-unreasoned-state-sync -- Resolve pending searches from the iframe message transport.
  useEffect(() => {
    if (!current) return;
    const pending = searches.current;
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== new URL(current.url).origin ||
        event.data?.source !== "j1-mausbot" ||
        event.data.type !== "search-result" ||
        typeof event.data.requestId !== "string"
      )
        return;
      const request = pending.get(event.data.requestId);
      if (!request) return;
      request.finish();
      if (typeof event.data.error === "string")
        request.reject(new Error(event.data.error.slice(0, 300)));
      else request.resolve(event.data.value);
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      for (const request of pending.values()) {
        request.finish();
        request.reject(new Error("The bot environment changed."));
      }
    };
  }, [current]);
  // oxlint-disable-next-line j1code/no-unreasoned-state-sync -- Register the mounted iframe as a command palette search source.
  useEffect(() => {
    if (!ready || !connected) return;
    return registerMausbotSearch({
      search: (query, signal) => searchCall("search", query, signal),
      land: async (key) => {
        const applied = await searchCall("land", key);
        if (applied !== true) throw new Error("The bot result could not be opened.");
      },
    });
  }, [ready, connected, searchCall]);
  const [providerCatalog, setProviderCatalog] = useState<
    { id: string; label: string; selected?: boolean }[]
  >([]);
  // oxlint-disable-next-line j1code/no-unreasoned-state-sync -- Subscribe to the provider catalog published by the embedded composer.
  useEffect(() => {
    const receive = (event: Event) => {
      const value: unknown = (event as CustomEvent).detail;
      if (
        Array.isArray(value) &&
        value.length <= 100 &&
        value.every((row) => row && typeof row.id === "string" && typeof row.label === "string")
      )
        setProviderCatalog(value);
    };
    window.addEventListener("j1-provider-catalog", receive);
    return () => window.removeEventListener("j1-provider-catalog", receive);
  }, []);
  const post = useStableCallback(() => {
    if (!current || !frame.current?.contentWindow) return;
    const root = document.documentElement;
    const colors = getComputedStyle(root);
    const route = new URL(
      hostSettingsOpen ? getAppModalReturnHref() : pathname + searchStr,
      location.href,
    );
    const message = {
      source: "j1-host",
      navigation: {
        active: route.pathname,
        hostSettingsOpen,
        providers: providerCatalog,
        ...(route.pathname === "/assistants"
          ? {
              conversation: {
                botId: route.searchParams.get("botId"),
                threadId: route.searchParams.get("conversation"),
              },
            }
          : {}),
        sidebarOpen,
        places: environments.map((item) => ({
          id: item.environmentId,
          label: item.environmentId === primaryEnvironmentId ? "This computer" : item.label,
          connected: item.connection.phase === "connected",
        })),
        placeId: environmentId,
        mobileOpen: openMobile,
        nativeHost,
        appearance: {
          skin: root.dataset.themeId,
          dark: root.classList.contains("dark"),
          font: getComputedStyle(document.body).fontFamily,
          mono: colors.getPropertyValue("--font-mono"),
          chatWidth,
          colors: Object.fromEntries(
            Object.entries(MAUSBOT_THEME_ROLES).map(([role, token]) => [
              token,
              colors
                .getPropertyValue(getThemeColorVariable(role as keyof typeof MAUSBOT_THEME_ROLES))
                .trim() || colors.getPropertyValue(`--maus-${token}`).trim(),
            ]),
          ),
        },
        settingsPages,
        ...slotHeights,
      },
    };
    const signature = JSON.stringify([current.url, message]);
    if (signature === lastNavigation.current) return;
    lastNavigation.current = signature;
    frame.current.contentWindow.postMessage(message, new URL(current.url).origin);
  });
  // oxlint-disable-next-line j1code/no-unreasoned-state-sync -- Report external theme changes to the iframe.
  useEffect(() => {
    const observer = new MutationObserver(() => post());
    observer.observe(document.documentElement, {
      attributeFilter: ["class", "style", "data-theme-id"],
    });
    return () => observer.disconnect();
  }, [post]);
  // oxlint-disable-next-line j1code/no-unreasoned-state-sync -- Own the authenticated runtime lease for the selected environment.
  useEffect(() => {
    if (!enabled || !connected || !environmentId || !base) return;
    let live = true;
    void open({ environmentId, input: { frameOrigin: window.location.origin } }).then((result) => {
      if (!live) return;
      setFinishedStartup(startupKey);
      if (result._tag !== "Success") {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error ? failure.message : "The assistant runtime could not start.",
        );
        return;
      }
      const resolved = resolveAssetUrl(base, result.value.relativeUrl);
      if (!resolved) {
        setError("The assistant runtime returned an invalid address.");
        return;
      }
      const url = new URL(resolved);
      url.hash = new URLSearchParams({ "j1-origin": location.origin }).toString();
      setError("");
      setBounds(null);
      setView({ key, url: url.href });
    });
    return () => {
      live = false;
    };
  }, [enabled, connected, environmentId, base, key, open, startupKey, setError]);
  /* oxlint-disable j1code/no-unreasoned-state-sync, react/exhaustive-effect-dependencies -- Send the current payload when an iframe navigation input changes, using the same handler for frame loads and theme events. */
  useEffect(() => {
    post();
  }, [
    post,
    current,
    pathname,
    searchStr,
    hostSettingsOpen,
    providerCatalog,
    sidebarOpen,
    openMobile,
    environments,
    environmentId,
    primaryEnvironmentId,
    nativeHost,
    chatWidth,
    slotHeights,
  ]);
  /* oxlint-enable j1code/no-unreasoned-state-sync, react/exhaustive-effect-dependencies */
  // oxlint-disable-next-line j1code/no-unreasoned-state-sync -- Keep the iframe's server-side session alive across idle and network recovery.
  useEffect(() => {
    if (!current || !environmentId || !connected || !base) return;
    const viewKey = viewKeyFromRuntimeUrl(current.url);
    if (!viewKey) return;
    let live = true;
    let pending = false;
    const refresh = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const replacement = await recoverMausbotView(
          async () => (await open({ environmentId, input: { viewKey } }))._tag === "Success",
          async () => {
            const result = await open({ environmentId, input: { frameOrigin: location.origin } });
            return result._tag === "Success" ? result.value.relativeUrl : null;
          },
          () => live,
        );
        if (!live || !replacement) return;
        const resolved = resolveAssetUrl(base, replacement);
        if (!resolved) return;
        const url = new URL(resolved);
        url.hash = new URLSearchParams({ "j1-origin": location.origin }).toString();
        setError("");
        setBounds(null);
        setView({ key: current.key, url: url.href });
      } finally {
        pending = false;
      }
    };
    const resume = () => void refresh();
    const timer = window.setInterval(resume, 20 * 60_000);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [current, environmentId, connected, base]);
  // oxlint-disable-next-line j1code/no-unreasoned-state-sync -- Receive authenticated messages from the embedded J1 runtime.
  useEffect(() => {
    if (!current) return;
    let live = true;
    const hostCall = async (method: string, args: unknown) => {
      const input =
        typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
      if (isMausbotRoutingMethod(method)) {
        if (!environmentId) throw new Error("Routing unavailable.");
        return callMausbotRouting(method, args, {
          environmentId,
          list: async (source) => {
            const result = await routingList({ environmentId, input: { source } });
            if (result._tag !== "Success") throw new Error("Routing unavailable.");
            return result.value;
          },
          prepare: async (input) => {
            const result = await routingPrepare({ environmentId, input });
            if (result._tag !== "Success") throw new Error("Review the changed request.");
            return result.value;
          },
          confirm: async (token) => {
            const result = await routingConfirm({ environmentId, input: { token } });
            if (result._tag !== "Success") throw new Error("Could not approve this request.");
          },
          open: async (endpoint) => {
            await navigate({ href: routeEndpointUrl(endpoint) });
          },
          label: (endpoint) =>
            readThreadShell({
              environmentId: EnvironmentId.make(endpoint.environmentId),
              threadId: ThreadId.make(endpoint.threadId),
            })?.title || "Open destination conversation",
        });
      }
      if (
        method === "settingsSearch" &&
        typeof input.query === "string" &&
        input.query.length <= 1000
      )
        return searchSettings(input.query, settingsSearchItems)
          .slice(0, 20)
          .map((item) => ({ path: item.to, label: item.title, hash: item.targetId ?? item.id }));
      const bridge = window.desktopBridge;
      if (!nativeHost || !bridge || !environmentId)
        throw new Error("This action is available only in the local J1 desktop.");
      if (method === "openSavedAppWindow") {
        const viewKey = viewKeyFromRuntimeUrl(current.url);
        if (!viewKey || typeof input.appId !== "string" || !mausbotSavedAppLaunchUrl(input.appId))
          return false;
        return (await bridge.openMausbotSavedApp?.({ appId: input.appId, viewKey })) ?? false;
      }
      if (method === "savedAppShortcut") {
        const request = decodeShortcutRequest(input);
        if (
          Option.isNone(request) ||
          !nativeHost.savedAppShortcuts ||
          !bridge.manageMausbotShortcuts
        )
          throw new Error("Saved-app shortcuts are unavailable.");
        return bridge.manageMausbotShortcuts(request.value);
      }
      if (method === "screenFrame") {
        if (!bridge.captureMausbotScreenFrame) return null;
        capture.current ??= bridge.captureMausbotScreenFrame().finally(() => {
          capture.current = null;
        });
        return capture.current;
      }
      if (
        method === "openExternal" &&
        typeof input.url === "string" &&
        input.url.length <= 16_384
      ) {
        await bridge.openExternal(input.url);
        return true;
      }
      if (
        method === "pickFolder" &&
        (input.current === undefined || typeof input.current === "string")
      )
        return bridge.pickFolder({
          initialPath: typeof input.current === "string" ? input.current : null,
          targetEnvironmentId: "primary",
        });
      if (method === "approvalMode") {
        const input = decodeApprovalMode(args);
        const result = await setApprovalMode({ environmentId, input });
        if (result._tag !== "Success") throw squashAtomCommandFailure(result);
        return result.value;
      }
      throw new Error("Unsupported desktop request.");
    };
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== new URL(current.url).origin ||
        event.data?.source !== "j1-mausbot"
      )
        return;
      const data = event.data;
      if (data.type === "bootstrap") {
        post();
      } else if (data.type === "skin-catalog") {
        installMausbotFonts(data.fonts, current.url);
        const themes = decodeMausbotThemes(data.skins);
        if (themes.length && setWorkspaceThemes(themes)) refreshTheme({ preservePreview: true });
      } else if (data.type === "search-open") {
        openCommandPalette();
      } else if (data.type === "settings-navigate" && isSettingsPath(data.path)) {
        void navigate({
          to: data.path,
          hash: typeof data.hash === "string" && data.hash.length <= 300 ? data.hash : "",
          hashScrollIntoView: false,
        });
      } else if (
        pathname === "/settings/providers" &&
        (data.type === "provider-select" ||
          data.type === "provider-add" ||
          data.type === "provider-refresh")
      ) {
        if (
          data.type === "provider-add" ||
          data.type === "provider-refresh" ||
          (typeof data.instanceId === "string" &&
            providerCatalog.some((row) => row.id === data.instanceId))
        ) {
          window.dispatchEvent(
            new CustomEvent("j1-provider-select", {
              detail:
                data.type === "provider-add"
                  ? null
                  : data.type === "provider-refresh"
                    ? { action: "refresh" }
                    : data.instanceId,
            }),
          );
        }
      } else if (data.type === "settings-native" && !hostSettingsOpen) {
        void navigate({ to: "/assistants" });
      } else if (data.type === "settings-close" && pathname.startsWith("/settings/")) {
        void navigateToMainApp();
      } else if (
        data.type === "host-call" &&
        typeof data.requestId === "string" &&
        /^[A-Za-z0-9_-]{1,80}$/.test(data.requestId) &&
        typeof data.method === "string"
      ) {
        const target = frame.current?.contentWindow;
        const respond = (value?: unknown, error?: string) => {
          if (live)
            target?.postMessage(
              { source: "j1-host", type: "host-result", requestId: data.requestId, value, error },
              event.origin,
            );
        };
        void hostCall(data.method, data.args).then(
          (value) => respond(value),
          (error) =>
            respond(
              undefined,
              error instanceof Error ? error.message : "The desktop request failed.",
            ),
        );
      } else if (data.type === "ready" && finite(data.left) && finite(data.top)) {
        if (data.navigationReady === false) {
          post();
          return;
        }
        if (handshake.current !== null) window.clearTimeout(handshake.current);
        handshake.current = null;
        setError("");
        setBounds({
          overlays: Array.isArray(data.overlays)
            ? data.overlays
                .slice(0, 16)
                .filter((rect: unknown): rect is ShellBounds["overlays"][number] =>
                  Boolean(
                    rect &&
                    typeof rect === "object" &&
                    ["left", "top", "width", "height"].every((key) =>
                      finite((rect as Record<string, unknown>)[key]),
                    ),
                  ),
                )
            : [],
          left: Math.max(0, data.left),
          top: Math.max(0, data.top),
          modal: data.modal === true,
          main:
            data.main && ["left", "top", "width", "height"].every((key) => finite(data.main[key]))
              ? data.main
              : null,
          projects: projectBounds(data.projects),
          footer: projectBounds(data.footer),
        });
      } else if (data.type === "native" && !hostSettingsOpen) {
        void navigate({ to: "/assistants", search: environmentId ? { environmentId } : {} });
      } else if (data.type === "sidebar-toggle") {
        toggleSidebar();
      } else if (data.type === "place" && typeof data.id === "string") {
        const selected = environments.find((item) => item.environmentId === data.id);
        if (selected) {
          setActiveEnvironmentId(selected.environmentId);
          void navigate({ to: "/assistants", search: { environmentId: selected.environmentId } });
        }
      } else if (data.type === "sidebar" && typeof data.open === "boolean") {
        setOpenMobile(data.open);
      } else if (data.type === "navigate" && data.path === "/") {
        void navigate({ to: "/" });
      }
    };
    window.addEventListener("message", receive);
    return () => {
      live = false;
      window.removeEventListener("message", receive);
    };
  }, [
    current,
    navigate,
    post,
    setOpenMobile,
    nativeHost,
    environmentId,
    setApprovalMode,
    routingList,
    routingPrepare,
    routingConfirm,
    navigateToMainApp,
    pathname,
    hostSettingsOpen,
    settingsSearchItems,
    refreshTheme,
    environments,
    toggleSidebar,
    providerCatalog,
    setError,
  ]);
  const workspace = {
    error:
      requestedEnvironment && !environment
        ? "This environment is unavailable. Reconnect it in Settings."
        : error,
    busy,
    retry: () => setAttempt((value) => value + 1),
  };
  const shownPath = hostSettingsOpen
    ? new URL(getAppModalReturnHref(), location.href).pathname
    : pathname;
  const native = shownPath === "/assistants" || shownPath === "/";
  return (
    <WorkspaceState value={workspace}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {isElectron && !isWindowsPlatform(navigator.platform) && !ready && (
          <WorkspacePageHeader electron aria-label="Window title bar" />
        )}
        <div
          ref={shell}
          className="relative flex h-full min-h-0 min-w-0 flex-1 overflow-clip"
          data-mausbot-modal={ready && bounds?.modal ? "true" : undefined}
          data-mausbot-shell={
            initializing
              ? "loading"
              : !enabled
                ? "unsupported"
                : error
                  ? "failed"
                  : ready
                    ? "ready"
                    : "loading"
          }
        >
          {current && (
            <iframe
              ref={frame}
              src={current.url}
              title="J1 workspace"
              allow="microphone"
              sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
              onLoad={() => {
                lastNavigation.current = "";
                try {
                  setFrameAccess(
                    Boolean(
                      frame.current?.contentDocument &&
                      frame.current.contentDocument.URL !== "about:blank",
                    ),
                  );
                } catch {
                  setFrameAccess(false);
                }
                setBounds(null);
                if (handshake.current !== null) window.clearTimeout(handshake.current);
                handshake.current = window.setTimeout(() => {
                  handshake.current = null;
                  setError("The bot window could not reconnect. Reopen it to continue.");
                }, 15_000);
                post();
              }}
              className="absolute inset-0 h-full w-full border-0"
              style={{ visibility: ready ? "visible" : "hidden" }}
            />
          )}
          {!ready && sidebar}
          {projectPortal &&
            sidebarOpen &&
            createPortal(
              <PortalContainer value={projectPortal}>
                <div
                  ref={projectContent}
                  data-merged-project-navigation
                  className="flex shrink-0 flex-col"
                >
                  {navigation}
                </div>
              </PortalContainer>,
              projectPortal,
            )}
          {footerPortal &&
            sidebarOpen &&
            createPortal(
              <PortalContainer value={footerPortal}>
                <div ref={footerContent} data-merged-j1-utilities>
                  {footer}
                </div>
              </PortalContainer>,
              footerPortal,
            )}
          {ready && !projectPortal && bounds.projects && sidebarOpen && (
            <div
              data-merged-project-navigation
              inert={bounds.modal}
              className="merged-j1-navigation absolute z-20 flex min-h-0 flex-col overflow-clip bg-sidebar text-sidebar-foreground"
              style={{
                left: bounds.projects.left,
                top: bounds.projects.top + bounds.projects.clipTop,
                width: bounds.projects.width,
                height: Math.max(
                  0,
                  bounds.projects.height - bounds.projects.clipTop - bounds.projects.clipBottom,
                ),
                clipPath: nativeOverlayClip(
                  {
                    ...bounds.projects,
                    top: bounds.projects.top + bounds.projects.clipTop,
                    height: Math.max(
                      0,
                      bounds.projects.height - bounds.projects.clipTop - bounds.projects.clipBottom,
                    ),
                  },
                  bounds.overlays,
                  "navigation",
                ),
                // These overlays sit above the iframe backdrop; retain and dim them with it.
                filter: bounds.modal ? "brightness(0.35)" : undefined,
                pointerEvents: bounds.modal ? "none" : undefined,
              }}
            >
              <div
                ref={projectContent}
                className="flex shrink-0 flex-col"
                style={{ transform: `translateY(-${bounds.projects.clipTop}px)` }}
                onFocusCapture={(event) => {
                  const rect = event.target.getBoundingClientRect();
                  const top = bounds.projects!.top + bounds.projects!.clipTop;
                  const bottom =
                    bounds.projects!.top + bounds.projects!.height - bounds.projects!.clipBottom;
                  if (rect.top < top) scrollNavigation(rect.top - top);
                  else if (rect.bottom > bottom) scrollNavigation(rect.bottom - bottom);
                }}
                onKeyDown={(event) => {
                  if (
                    event.defaultPrevented ||
                    (event.key !== "PageDown" && event.key !== "PageUp")
                  )
                    return;
                  event.preventDefault();
                  scrollNavigation(
                    (event.key === "PageDown" ? 1 : -1) * Math.max(100, innerHeight * 0.7),
                  );
                }}
              >
                {navigation}
              </div>
            </div>
          )}
          {ready && !footerPortal && bounds.footer && sidebarOpen && (
            <div
              data-merged-j1-utilities
              inert={bounds.modal}
              className="absolute z-20 bg-sidebar text-sidebar-foreground"
              style={{
                left: bounds.footer.left,
                top: bounds.footer.top,
                width: bounds.footer.width,
                clipPath: nativeOverlayClip(bounds.footer, bounds.overlays, "navigation"),
                // These overlays sit above the iframe backdrop; retain and dim them with it.
                filter: bounds.modal ? "brightness(0.35)" : undefined,
                pointerEvents: bounds.modal ? "none" : undefined,
              }}
            >
              <div ref={footerContent}>{footer}</div>
            </div>
          )}
          <div
            data-merged-j1-content
            className="relative z-10 flex min-h-0 min-w-0 flex-1"
            style={
              ready
                ? {
                    position: "absolute",
                    ...(bounds.main
                      ? {
                          left: bounds.main.left,
                          top: bounds.main.top,
                          width: bounds.main.width,
                          height: bounds.main.height,
                          clipPath: nativeOverlayClip(bounds.main, bounds.overlays),
                        }
                      : { inset: `${bounds.top}px 0 0 ${bounds.left}px` }),
                    visibility: native || bounds.modal ? "hidden" : "visible",
                  }
                : undefined
            }
          >
            {pathname === "/assistants" && initializing ? (
              <div
                role="status"
                className="flex flex-1 items-center justify-center text-sm text-muted-foreground"
              >
                Opening bots…
              </div>
            ) : (
              children
            )}
          </div>
        </div>
      </div>
    </WorkspaceState>
  );
}
