import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { resolveAssetUrl } from "../assets/assetUrls";
import { useEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import { useActiveEnvironmentId, setActiveEnvironmentId } from "../state/entities";
import { usePreparedConnection } from "../state/session";
import { openMausbot, setMausbotApprovalMode } from "../state/mausbot";
import { useAtomCommand } from "../state/use-atom-command";
import { useSidebar } from "./ui/sidebar";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, MausbotApprovalModeInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { localMausbotHost } from "./mausbotHost";
import { registerMausbotSearch } from "./mausbotSearch";
import { openCommandPalette } from "../commandPaletteBus";
import { randomUUID } from "../lib/utils";
import { SETTINGS_SECTION_LABELS, searchSettings } from "./settings/settingsSearch";
import { useAvailableSettingsSearchItems } from "./settings/useAvailableSettingsSearchItems";
import { useNavigateToMainApp } from "./sidebar/mainAppLocation";
import { createPortal } from "react-dom";
import { useMausbotSettingsPortal } from "./MausbotSettingsPortal";
import { PortalContainer } from "./ui/portal-container";
import { MAUSBOT_THEME_ROLES } from "@t3tools/shared/mausbotAppearance";
import { getThemeColorVariable, setWorkspaceThemes } from "../themePalette";
import { decodeMausbotThemes } from "./mausbotAppearance";
import { useTheme } from "../hooks/useTheme";
import { useClientSettings } from "../hooks/useSettings";
import { installMausbotFonts } from "./mausbotFonts";
import { useMausbotFrameScroll } from "./useMausbotFrameScroll";
const decodeApprovalMode = Schema.decodeUnknownSync(MausbotApprovalModeInput);
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
  left: number;
  top: number;
  projects: ProjectBounds | null;
  footer: ProjectBounds | null;
  modal: boolean;
  settings: ProjectBounds | null;
  settingsCovered: boolean;
  main: { left: number; top: number; width: number; height: number } | null;
};
const WorkspaceState = createContext({
  error: "",
  busy: false,
  retry: () => {},
  settingsHosted: false,
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
  const activeEnvironmentId = useActiveEnvironmentId();
  const requestedEnvironment =
    pathname === "/assistants" ? new URLSearchParams(searchStr).get("environmentId") : null;
  const environmentId = requestedEnvironment
    ? EnvironmentId.make(requestedEnvironment)
    : (activeEnvironmentId ?? primaryEnvironmentId);
  const environment = useEnvironment(environmentId);
  useEffect(() => {
    if (requestedEnvironment && environment && activeEnvironmentId !== environment.environmentId)
      setActiveEnvironmentId(environment.environmentId);
  }, [requestedEnvironment, environment, activeEnvironmentId]);
  const connection = usePreparedConnection(environmentId);
  const base = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const enabled = environment?.serverConfig?.environment.capabilities.mausbot === true;
  const connected = environment?.connection.phase === "connected";
  const open = useAtomCommand(openMausbot, { reportFailure: false });
  const setApprovalMode = useAtomCommand(setMausbotApprovalMode, { reportFailure: false });
  const serverOs = environment?.serverConfig?.environment.platform?.os;
  const serverPlatform = serverOs === "windows" ? "win32" : serverOs;
  const nativeHost = useMemo(
    () => localMausbotHost(window.desktopBridge, base, serverPlatform),
    [base, serverPlatform],
  );
  const capture = useRef<Promise<string | null> | null>(null);
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const settingsSearchItems = useAvailableSettingsSearchItems();
  const { refreshTheme } = useTheme();
  const chatWidth = useClientSettings((settings) => settings.chatWidth);
  const { open: sidebarOpen, openMobile, setOpenMobile } = useSidebar();
  const frame = useRef<HTMLIFrameElement>(null);
  const projectContent = useRef<HTMLDivElement>(null);
  const footerContent = useRef<HTMLDivElement>(null);
  const settingsContent = useRef<HTMLDivElement>(null);
  const [frameAccess, setFrameAccess] = useState(false);
  const [slotHeights, setSlotHeights] = useState({
    projectsHeight: 1,
    footerHeight: 32,
    settingsHeight: 1,
  });
  const handshake = useRef<number | null>(null);
  const [view, setView] = useState<{ key: string; url: string } | null>(null);
  const [bounds, setBounds] = useState<ShellBounds | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(
    () => () => {
      if (handshake.current !== null) window.clearTimeout(handshake.current);
    },
    [],
  );
  const key = environmentId && base ? `${environmentId}:${base}` : "";
  const current = view?.key === key ? view : null;
  const ready = enabled && current !== null && bounds !== null;
  const settingsPortal = useMausbotSettingsPortal(frame, ready && frameAccess);
  const settingsOverlay = Boolean(
    ready && !frameAccess && pathname.startsWith("/settings/") && bounds?.settings,
  );
  const projectsMounted = Boolean(ready && bounds?.projects && sidebarOpen);
  const footerMounted = Boolean(ready && bounds?.footer && sidebarOpen);
  useEffect(() => {
    if (!projectsMounted && !footerMounted && !settingsOverlay) return;
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
        settingsHeight: Math.max(
          1,
          Math.ceil(settingsContent.current?.getBoundingClientRect().height ?? 1),
        ),
      };
      setSlotHeights((previous) =>
        previous.projectsHeight === next.projectsHeight &&
        previous.footerHeight === next.footerHeight &&
        previous.settingsHeight === next.settingsHeight
          ? previous
          : next,
      );
    };
    const observer = new ResizeObserver(measure);
    if (projectContent.current) observer.observe(projectContent.current);
    if (footerContent.current) observer.observe(footerContent.current);
    if (settingsOverlay && settingsContent.current) observer.observe(settingsContent.current);
    measure();
    return () => observer.disconnect();
  }, [projectsMounted, footerMounted, settingsOverlay]);
  const scrollSettings = useCallback(
    (delta: number) => {
      if (current)
        frame.current?.contentWindow?.postMessage(
          { source: "j1-host", type: "settings-scroll", delta },
          new URL(current.url).origin,
        );
    },
    [current],
  );
  useMausbotFrameScroll(settingsContent, settingsOverlay, scrollSettings);
  const scrollNavigation = useCallback(
    (delta: number) => {
      if (!current) return;
      frame.current?.contentWindow?.postMessage(
        { source: "j1-host", type: "sidebar-scroll", delta },
        new URL(current.url).origin,
      );
    },
    [current],
  );
  useEffect(() => {
    const contents = [projectContent.current].filter(
      (node): node is HTMLDivElement => node !== null,
    );
    if (!projectsMounted) return;
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
  }, [projectsMounted, scrollNavigation]);
  const searches = useRef(
    new Map<
      string,
      { resolve: (value: unknown) => void; reject: (error: Error) => void; finish: () => void }
    >(),
  );
  const searchCall = useCallback(
    (method: "search" | "land", input: string, signal?: AbortSignal): Promise<unknown> => {
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
    },
    [current],
  );
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
  const post = useCallback(() => {
    if (!current || !frame.current?.contentWindow) return;
    const root = document.documentElement;
    const colors = getComputedStyle(root);
    frame.current.contentWindow.postMessage(
      {
        source: "j1-host",
        navigation: {
          active: pathname,
          ...(pathname === "/assistants"
            ? {
                conversation: {
                  botId: new URLSearchParams(searchStr).get("botId"),
                  threadId: new URLSearchParams(searchStr).get("conversation"),
                },
              }
            : {}),
          sidebarOpen,
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
          settingsPresentation: frameAccess ? "portal" : "overlay",
          ...slotHeights,
        },
      },
      new URL(current.url).origin,
    );
  }, [
    current,
    pathname,
    searchStr,
    sidebarOpen,
    openMobile,
    nativeHost,
    slotHeights,
    chatWidth,
    frameAccess,
  ]);
  useEffect(() => {
    const observer = new MutationObserver(post);
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, [post]);
  useEffect(() => {
    if (!enabled || !connected || !environmentId || !base) return;
    let live = true;
    setBusy(true);
    setError("");
    void open({ environmentId, input: { frameOrigin: window.location.origin } }).then((result) => {
      if (!live) return;
      setBusy(false);
      if (result._tag !== "Success") {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error ? failure.message : "The assistant runtime could not start.",
        );
        return;
      }
      const resolved = resolveAssetUrl(base, result.value.relativeUrl);
      if (!resolved) return;
      const url = new URL(resolved);
      url.hash = new URLSearchParams({ "j1-origin": location.origin }).toString();
      setBounds(null);
      setView({ key, url: url.href });
    });
    return () => {
      live = false;
    };
  }, [enabled, connected, environmentId, base, key, open, attempt]);
  useEffect(() => {
    post();
  }, [post]);
  useEffect(() => {
    if (!current || !environmentId || !connected) return;
    const viewKey = /\/runtime\/([a-f0-9]{64})\//.exec(new URL(current.url).pathname)?.[1];
    if (!viewKey) return;
    // Refresh the scoped capability without remounting the UI or losing unsent drafts.
    const timer = window.setInterval(() => {
      void open({ environmentId, input: { viewKey } });
    }, 20 * 60_000);
    return () => window.clearInterval(timer);
  }, [current, environmentId, connected, open]);
  useEffect(() => {
    if (!current) return;
    let live = true;
    const hostCall = async (method: string, args: unknown) => {
      const input =
        typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
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
      } else if (data.type === "settings-native") {
        void navigate({ to: "/assistants" });
      } else if (data.type === "settings-close" && pathname.startsWith("/settings/")) {
        void navigateToMainApp();
      } else if (data.type === "settings-focus" && settingsOverlay) {
        const controls = [
          ...(settingsContent.current?.querySelectorAll<HTMLElement>(
            "button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])",
          ) ?? []),
        ].filter((node) => node.checkVisibility());
        (data.edge === "end" ? controls.at(-1) : controls[0])?.focus();
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
          left: Math.max(0, data.left),
          top: Math.max(0, data.top),
          modal: data.modal === true,
          settings: projectBounds(data.settings),
          settingsCovered: data.settingsCovered === true,
          main:
            data.main && ["left", "top", "width", "height"].every((key) => finite(data.main[key]))
              ? data.main
              : null,
          projects: projectBounds(data.projects),
          footer: projectBounds(data.footer),
        });
      } else if (data.type === "native") {
        void navigate({ to: "/assistants", search: environmentId ? { environmentId } : {} });
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
    navigateToMainApp,
    pathname,
    settingsSearchItems,
    refreshTheme,
    settingsOverlay,
  ]);
  const settingsHosted =
    ready && pathname.startsWith("/settings/") && (settingsPortal !== null || settingsOverlay);
  const workspace = useMemo(
    () => ({
      error:
        requestedEnvironment && !environment
          ? "This environment is unavailable. Reconnect it in Settings."
          : error,
      busy,
      retry: () => setAttempt((value) => value + 1),
      settingsHosted,
    }),
    [error, busy, settingsHosted, requestedEnvironment, environment],
  );
  const native = pathname === "/assistants" || pathname === "/";
  return (
    <WorkspaceState value={workspace}>
      <div
        className="relative flex h-full min-h-0 min-w-0 flex-1 overflow-clip"
        data-mausbot-shell={
          !enabled ? "unsupported" : error ? "failed" : ready ? "ready" : "loading"
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
        {ready && bounds.projects && sidebarOpen && (
          <div
            data-merged-project-navigation
            className="merged-j1-navigation absolute z-20 flex min-h-0 flex-col overflow-clip bg-sidebar text-sidebar-foreground"
            style={{
              left: bounds.projects.left,
              top: bounds.projects.top + bounds.projects.clipTop,
              width: bounds.projects.width,
              height: Math.max(
                0,
                bounds.projects.height - bounds.projects.clipTop - bounds.projects.clipBottom,
              ),
              visibility: bounds.modal ? "hidden" : "visible",
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
                if (event.defaultPrevented || (event.key !== "PageDown" && event.key !== "PageUp"))
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
        {ready && bounds.footer && sidebarOpen && (
          <div
            data-merged-j1-utilities
            className="absolute z-20 bg-sidebar text-sidebar-foreground"
            style={{
              left: bounds.footer.left,
              top: bounds.footer.top,
              width: bounds.footer.width,
              visibility: bounds.modal ? "hidden" : "visible",
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
                  ...(settingsOverlay && bounds.settings
                    ? {
                        left: bounds.settings.left,
                        top: bounds.settings.top + bounds.settings.clipTop,
                        width: bounds.settings.width,
                        height: Math.max(
                          0,
                          bounds.settings.height -
                            bounds.settings.clipTop -
                            bounds.settings.clipBottom,
                        ),
                        overflow: "clip",
                      }
                    : bounds.main
                      ? {
                          left: bounds.main.left,
                          top: bounds.main.top,
                          width: bounds.main.width,
                          height: bounds.main.height,
                        }
                      : { inset: `${bounds.top}px 0 0 ${bounds.left}px` }),
                  visibility: pathname.startsWith("/settings/")
                    ? settingsOverlay && !bounds.settingsCovered
                      ? "visible"
                      : "hidden"
                    : native || bounds.modal
                      ? "hidden"
                      : "visible",
                }
              : undefined
          }
        >
          {settingsPortal && settingsHosted ? (
            createPortal(
              <PortalContainer value={settingsPortal ?? undefined}>{children}</PortalContainer>,
              settingsPortal,
            )
          ) : (
            <div
              ref={settingsContent}
              className="flex min-w-0 flex-1 flex-col"
              style={
                settingsOverlay && bounds?.settings
                  ? {
                      flex: "none",
                      alignSelf: "flex-start",
                      display: "block",
                      width: "100%",
                      transform: `translateY(-${bounds.settings.clipTop}px)`,
                    }
                  : undefined
              }
              onFocusCapture={(event) => {
                if (!settingsOverlay || !bounds?.settings) return;
                const rect = event.target.getBoundingClientRect(),
                  top = bounds.settings.top + bounds.settings.clipTop,
                  bottom =
                    bounds.settings.top + bounds.settings.height - bounds.settings.clipBottom;
                if (rect.top < top) scrollSettings(rect.top - top);
                else if (rect.bottom > bottom) scrollSettings(rect.bottom - bottom);
              }}
              onKeyDown={(event) => {
                if (!settingsOverlay || event.defaultPrevented || !current) return;
                if (event.key === "Tab") {
                  const controls = [
                    ...event.currentTarget.querySelectorAll<HTMLElement>(
                      "button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])",
                    ),
                  ].filter((node) => node.checkVisibility());
                  if (
                    (!event.shiftKey && event.target === controls.at(-1)) ||
                    (event.shiftKey && event.target === controls[0])
                  ) {
                    event.preventDefault();
                    frame.current?.contentWindow?.postMessage(
                      {
                        source: "j1-host",
                        type: "settings-focus-source",
                        edge: event.shiftKey ? "before" : "after",
                      },
                      new URL(current.url).origin,
                    );
                  }
                } else if (
                  (event.key === "PageDown" || event.key === "PageUp") &&
                  !(
                    event.target instanceof Element &&
                    event.target.closest("input,textarea,[contenteditable=true]")
                  )
                ) {
                  event.preventDefault();
                  scrollSettings((event.key === "PageDown" ? 1 : -1) * innerHeight * 0.7);
                }
              }}
            >
              {children}
            </div>
          )}
        </div>
      </div>
    </WorkspaceState>
  );
}
