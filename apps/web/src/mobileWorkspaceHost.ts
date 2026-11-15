declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}

export const isMobileWorkspace = () =>
  typeof window !== "undefined" && Boolean(window.ReactNativeWebView);

export function openMobileWorkspacePage(type: "open-connections" | "open-app-tools") {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ source: "j1-workspace", type }));
}
