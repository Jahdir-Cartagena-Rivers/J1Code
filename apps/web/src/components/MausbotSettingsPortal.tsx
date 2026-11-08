import { useEffect, useState, type RefObject } from "react";

/** Host the existing forms in the native modal's flow without mixing the two CSS bundles. */
export function useMausbotSettingsPortal(
  frame: RefObject<HTMLIFrameElement | null>,
  enabled: boolean,
) {
  return useMausbotSlotPortal(frame, enabled, "[data-j1-settings-slot]", "settings");
}

/** Keep integrated navigation in the native document's scrolling and overlay stack. */
export function useMausbotSlotPortal(
  frame: RefObject<HTMLIFrameElement | null>,
  enabled: boolean,
  selector: string,
  kind: "settings" | "navigation" | "footer",
) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
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
        if (kind === "settings") root.dataset.mergedSettings = "";
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
      const stylesheet = new MutationObserver(() => mirrorStyles());
      stylesheet.observe(document.head, { childList: true, subtree: true, characterData: true });
      sync();
      detach = () => {
        observer.disconnect();
        theme.disconnect();
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
