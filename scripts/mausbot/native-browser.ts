import * as NodeCrypto from "node:crypto";
import { LightpandaPool } from "./LightpandaProcess.ts";
import { MausbotLightpandaAdapter } from "./LightpandaAdapter.ts";
import { browserPageScript, browserActionScript } from "./page-scripts.ts";

// Consumed before provider children start. This path is supplied by J1's packaged resolver.
let executable = process.env.J1_MAUSBOT_LIGHTPANDA_PATH ?? "";
export const managed = process.env.J1_MAUSBOT_MANAGED === "1";
delete process.env.J1_MAUSBOT_LIGHTPANDA_PATH;
delete process.env.J1_MAUSBOT_MANAGED;
export let ready = managed && executable.trim().length > 0;
export const command = "j1-lightpanda";
const pool = new LightpandaPool();
let adapter = new MausbotLightpandaAdapter(pool, executable);
export function configure(path: string) {
  if (path === executable) return;
  pool.closeAll();
  executable = path;
  adapter = new MausbotLightpandaAdapter(pool, path);
  ready = managed && path.trim().length > 0;
}
const busy = new Set<string>();

export function working(session: string) {
  return busy.has(session);
}
export function close(session: string) {
  adapter.close("managed", session);
}
export function closeAll() {
  pool.closeAll();
}
export const prompt = `Your browser is J1's native lightweight Lightpanda browser. Discover the available tools and follow their schemas. Use CSS selectors or backendNodeId from the page tree, not @eN references. The browser window and your tools share the same page. It has no Chromium/CDP, tab management, file upload, persistent sign-in profiles or pixel-accurate screenshot support. Do not install or launch a replacement browser. Unsupported actions must be reported to the person. Read the current page again after navigation or another participant changes it.`;

export async function rpc(
  session: string,
  method: "tools/list" | "tools/call",
  params: unknown,
  dispatch?: () => void,
) {
  if (!ready) throw new Error("J1's lightweight browser is disabled or unavailable.");
  if (busy.has(session))
    throw new Error("A browser operation is still in progress. Try again after it finishes.");
  busy.add(session);
  try {
    dispatch?.();
    return await adapter.request("managed", session, method, params);
  } finally {
    busy.delete(session);
  }
}

function text(result: unknown): string {
  const value = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
  if (value?.isError)
    throw new Error("The page changed or this browser action failed. Refresh before retrying.");
  const item = value?.content?.find((entry) => entry.type === "text");
  if (typeof item?.text !== "string") throw new Error("The browser returned an invalid page view.");
  return item.text;
}

/** Called only after the upstream viewer route checks bot, audience, origin and live sign-in. */
export async function page(session: string, body?: unknown) {
  if (!ready) throw new Error("J1's lightweight browser is disabled or unavailable.");
  if (busy.has(session))
    throw new Error("The agent is using the browser. Refresh when its action finishes.");
  busy.add(session);
  try {
    const action = body as { type?: unknown; url?: unknown; revision?: unknown } | undefined;
    if (action?.type === "open") {
      // A window attaches first; an explicit Start creates a page only if none exists.
      try {
        await adapter.view("managed", session, "tools/call", { name: "getUrl", arguments: {} });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "The bot browser is not running.")
          throw error;
        await adapter.request("managed", session, "tools/call", {
          name: "agent_browser_open",
          arguments: { url: "about:blank" },
        });
      }
    } else if (action?.type === "navigate") {
      if (typeof action.url !== "string") throw new Error("Enter a web address.");
      const url = new URL(action.url);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
        throw new Error("Only HTTP and HTTPS addresses are supported.");
      await adapter.request("managed", session, "tools/call", {
        name: "agent_browser_open",
        arguments: { url: url.href },
      });
    } else if (action !== undefined) {
      if (
        !action ||
        !["click", "fill"].includes(String(action.type)) ||
        typeof action.revision !== "string"
      )
        throw new Error("Invalid page action.");
      await adapter.view("managed", session, "tools/call", {
        name: "evaluate",
        arguments: { script: browserActionScript(action) },
      });
    }
    return JSON.parse(
      text(
        await adapter.view("managed", session, "tools/call", {
          name: "evaluate",
          arguments: { script: browserPageScript(NodeCrypto.randomBytes(16).toString("hex")) },
        }),
      ),
    );
  } finally {
    busy.delete(session);
  }
}
