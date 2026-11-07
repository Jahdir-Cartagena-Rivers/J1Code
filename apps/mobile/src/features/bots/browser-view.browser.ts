import type { BotBrowserPage } from "@t3tools/contracts";
import { buildBotBrowserDocument } from "@t3tools/client-runtime/bots/browser-document";
export function render(page: BotBrowserPage) {
  const html = buildBotBrowserDocument(page);
  document.open();
  document.write(html);
  document.close();
}
