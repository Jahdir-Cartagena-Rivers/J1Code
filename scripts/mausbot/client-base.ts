// This module runs only inside J1's embedded OSS workspace, before upstream UI startup.
import { prepareNativeHost } from "./j1-native-client";
const match = /^(?:\/[^?#]*)?\/api\/mausbot\/runtime\/[a-f0-9]{64}(?=\/|$)/.exec(location.pathname);
if (!match) throw new Error("Open this workspace from J1.");
const prefix = match[0];
function localUrl(value: string | URL) {
  const url = new URL(String(value), location.href);
  if (
    url.origin !== location.origin ||
    url.pathname === prefix ||
    url.pathname.startsWith(`${prefix}/`)
  )
    return url.href;
  url.pathname = prefix + url.pathname;
  return url.href;
}
const originalFetch = window.fetch.bind(window);
window.fetch = (input, init) =>
  originalFetch(
    input instanceof Request ? new Request(localUrl(input.url), input) : localUrl(input),
    init,
  );
const OriginalEventSource = window.EventSource;
window.EventSource = class extends OriginalEventSource {
  constructor(url: string | URL, options?: EventSourceInit) {
    super(localUrl(url), options);
  }
};
await prepareNativeHost();
const observer = new MutationObserver((records) => {
  for (const record of records) {
    const roots = record.type === "attributes" ? [record.target] : [...record.addedNodes];
    for (const root of roots) {
      if (!(root instanceof Element)) continue;
      for (const node of [root, ...root.querySelectorAll("[src],[href],[poster]")]) {
        if (node instanceof HTMLIFrameElement) continue;
        for (const attr of ["src", "href", "poster"]) {
          const value = node.getAttribute(attr);
          if (value?.startsWith("/") && !value.startsWith("//") && !value.startsWith(`${prefix}/`))
            node.setAttribute(attr, prefix + value);
        }
      }
    }
  }
});
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["src", "href", "poster"],
});
