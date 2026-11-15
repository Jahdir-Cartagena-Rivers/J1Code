import type { BotBrowserPage } from "@j1code/contracts";
import { buildBotBrowserDocument } from "@j1code/client-runtime/bots/browser-document";
export function render(page: BotBrowserPage) {
  const html = buildBotBrowserDocument(page);
  document.open();
  document.write(html);
  document.close();
}
