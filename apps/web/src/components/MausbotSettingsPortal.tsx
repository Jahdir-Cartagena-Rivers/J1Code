import { useEffect, useState, type RefObject } from "react";

/** Keep integrated navigation in the native document's scrolling and overlay stack. */
export function useMausbotSlotPortal(
  frame: RefObject<HTMLIFrameElement | null>,
  enabled: boolean,
  selector: string,
  kind: "navigation" | "footer",
) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  // oxlint-disable-next-line j1code/no-unreasoned-state-sync -- Track the embedded document and dispose its observers when it changes.
  useEffect(() => {
    if (!enabled) return;
    const iframe = frame.current;
    if (!iframe) return;
    let detach = () => {};
    const connect = () => {
      detach();
      const source = iframe.contentDocument;
      if (!source) return;
      let slot: HTMLElement | null = null;
      let mirrorStyles = () => {};
      let mirrorTheme = () => {};
      const sync = () => {
        if (slot?.isConnected) return;
        const next = source.querySelector<HTMLElement>(selector);
        if (next === slot) return;
        slot = next;
        if (!slot) {
          mirrorStyles = () => {};
          mirrorTheme = () => {};
          setTarget(null);
          return;
        }
        const shadow = slot.shadowRoot ?? slot.attachShadow({ mode: "open" });
        const styles = source.createElement("div");
        styles.dataset.j1SettingsStyles = "";
        const root = source.createElement("div");
        root.className =
          kind === "navigation"
            ? "merged-j1-navigation bg-sidebar text-sidebar-foreground"
            : "text-foreground";
        shadow.replaceChildren(styles, root);
        mirrorStyles = () => {
          styles.replaceChildren(
            ...[...document.head.querySelectorAll("style, link[rel=stylesheet]")].map((node) => {
              const clone = node.cloneNode(true);
              if (clone instanceof HTMLLinkElement && node instanceof HTMLLinkElement)
                clone.href = node.href;
              return clone;
            }),
          );
        };
        mirrorTheme = () => {
          const values = getComputedStyle(document.documentElement);
          root.style.cssText = "";
          for (const name of values)
            if (name.startsWith("--")) root.style.setProperty(name, values.getPropertyValue(name));
          if (kind === "navigation" || kind === "footer") {
            const native = source.defaultView?.getComputedStyle(slot!);
            for (const [token, nativeToken] of Object.entries({
              "--sidebar": "--color-app",
              "--sidebar-foreground": "--color-ink",
              "--sidebar-muted-foreground": "--color-ink-secondary",
              "--sidebar-icon-color": "--color-ink-secondary",
              "--sidebar-row-hover": "--color-raised",
              "--sidebar-row-active": "--color-raised",
              "--sidebar-row-selected": "--color-raised",
            })) {
              const color = native?.getPropertyValue(nativeToken).trim();
              if (color) root.style.setProperty(token, color);
            }
          }
          root.classList.toggle("dark", document.documentElement.classList.contains("dark"));
        };
        mirrorStyles();
        mirrorTheme();
        setTarget(root);
      };
      const observer = new MutationObserver(sync);
      observer.observe(source.body, { childList: true, subtree: true });
      const theme = new MutationObserver(() => mirrorTheme());
      theme.observe(document.documentElement, { attributes: true });
      const nativeTheme = new MutationObserver(() => mirrorTheme());
      nativeTheme.observe(source.documentElement, { attributes: true });
      const stylesheet = new MutationObserver(() => mirrorStyles());
      stylesheet.observe(document.head, { childList: true, subtree: true, characterData: true });
      sync();
      detach = () => {
        observer.disconnect();
        theme.disconnect();
        nativeTheme.disconnect();
        stylesheet.disconnect();
        setTarget(null);
      };
    };
    iframe.addEventListener("load", connect);
    connect();
    return () => {
      iframe.removeEventListener("load", connect);
      detach();
    };
  }, [frame, enabled, selector, kind]);
  return enabled ? target : null;
}
