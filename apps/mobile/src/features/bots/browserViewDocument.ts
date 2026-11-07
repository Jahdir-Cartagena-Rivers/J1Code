import type { BotBrowserPage } from "@t3tools/contracts";
/** The bundle sanitizes the page in the WebView before any website markup is rendered. */
export function browserViewDocument(page: BotBrowserPage, script: string) {
  const data = JSON.stringify(page).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script>${script.replace(/<\/script/gi, "<\\/script")}\ntry{J1BotBrowser.render(${data});}catch{window.ReactNativeWebView.postMessage(JSON.stringify({type:'j1-bot-browser-error'}));}</script></body></html>`;
}
