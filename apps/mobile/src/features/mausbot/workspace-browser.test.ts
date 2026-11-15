import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import {
  isWorkspaceBrowserUrl,
  workspaceBootstrapScript,
  workspaceBrowserUrls,
  selectWorkspaceEnvironment,
  workspaceConversationUrl,
  workspaceScopesChanged,
} from "./workspace-browser";

describe("shared workspace navigation", () => {
  it("refreshes an active connection when permissions change, without reloading for their order", () => {
    expect(workspaceScopesChanged(["read", "write"], ["read"])).toBe(true);
    expect(workspaceScopesChanged(["read"], ["read", "write"])).toBe(true);
    expect(workspaceScopesChanged(["read", "write"], ["write", "read"])).toBe(false);
    expect(workspaceScopesChanged(null, ["read"])).toBe(false);
  });
  it("opens notification targets in the shared project or bot conversation", () => {
    const base = "https://relay.example/environments/one/";
    expect(workspaceConversationUrl(base, { environmentId: "env", threadId: "thread" })).toBe(
      `${base}env/thread`,
    );
    const bot = new URL(
      workspaceConversationUrl(base, {
        environmentId: "env",
        threadId: "mausbot:bot:conversation",
      }),
    );
    expect(bot.pathname).toBe("/environments/one/assistants");
    expect(bot.searchParams.get("botId")).toBe("bot");
    expect(bot.searchParams.get("conversation")).toBe("conversation");
  });
  it("honors the selected environment and never reopens a disabled connection", () => {
    const one = { environmentId: "one", entry: { enabled: true } };
    const two = { environmentId: "two", entry: { enabled: true } };
    const disabled = { environmentId: "disabled", entry: { enabled: false } };
    expect(selectWorkspaceEnvironment([one, two], null)).toBeNull();
    expect(selectWorkspaceEnvironment([one, two], "two")).toBe(two);
    expect(selectWorkspaceEnvironment([one, disabled], "disabled")).toBeNull();
    expect(selectWorkspaceEnvironment([one, disabled], null)).toBe(one);
  });
  it("preserves remote environment prefixes and confines the native bridge", () => {
    const base = "https://relay.example/environments/one";
    expect(workspaceBrowserUrls(base).redeem).toBe(
      "https://relay.example/environments/one/api/auth/workspace-session",
    );
    expect(isWorkspaceBrowserUrl(base, `${base}/settings/connections`)).toBe(true);
    expect(isWorkspaceBrowserUrl(base, `${base}/assistants?thread=one`)).toBe(true);
    for (const target of [
      "https://other.example/",
      `${base}-other/settings`,
      "javascript:alert(1)",
      "file:///tmp/a",
      `${base}/api/attachments/a.html`,
      `${base}/attachments/a.html`,
    ]) {
      expect(isWorkspaceBrowserUrl(base, target)).toBe(false);
    }
    expect(() => workspaceBrowserUrls("file:///tmp/a")).toThrow();
    expect(() => workspaceBrowserUrls("https://user:pass@relay.example/")).toThrow();
  });
});

describe("workspace handoff script", () => {
  function fixture(ok = true, origin = "https://j1.example") {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const redirects: string[] = [];
    const messages: Array<{ type: string; expiresAt?: string }> = [];
    let received!: () => void;
    const receipt = new Promise<void>((resolve) => {
      received = resolve;
    });
    const context = NodeVM.createContext({
      URL,
      AbortController,
      setTimeout,
      clearTimeout,
      Date,
      JSON,
      location: { origin, pathname: "/pair", replace: (url: string) => redirects.push(url) },
      window: {
        ReactNativeWebView: {
          postMessage: (message: string) => {
            messages.push(JSON.parse(message));
            received();
          },
        },
      },
      fetch: async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return {
          ok,
          json: async () => ({ authenticated: true, expiresAt: "2030-01-01T00:00:00Z" }),
        };
      },
    });
    return { context, requests, redirects, messages, receipt };
  }

  it("redeems once, keeps credentials out of the URL, and opens the workspace after authentication", async () => {
    const f = fixture();
    const script = workspaceBootstrapScript("https://j1.example/", "one-use-handoff", true);
    NodeVM.runInContext(script, f.context);
    await f.receipt;
    NodeVM.runInContext(script, f.context);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.url).toBe("https://j1.example/api/auth/workspace-session");
    expect(f.requests[0]?.init.credentials).toBe("include");
    expect(JSON.parse(String(f.requests[0]?.init.body))).toEqual({ credential: "one-use-handoff" });
    expect(f.messages[0]?.type).toBe("authenticated");
    expect(f.redirects).toEqual(["https://j1.example/"]);
  });

  it("refreshes without navigating away from a draft", async () => {
    const f = fixture();
    NodeVM.runInContext(
      workspaceBootstrapScript("https://j1.example/", "refresh-handoff", false),
      f.context,
    );
    await f.receipt;
    expect(f.messages[0]?.type).toBe("authenticated");
    expect(f.redirects).toEqual([]);
  });

  it("returns to the current conversation after a sign-in renewal", async () => {
    const f = fixture();
    const conversation = "https://j1.example/environment/thread?panel=files";
    NodeVM.runInContext(
      workspaceBootstrapScript("https://j1.example/", "renew", true, conversation),
      f.context,
    );
    await f.receipt;
    expect(f.redirects).toEqual([conversation]);
  });

  it("reports rejection without navigating or revealing the handoff", async () => {
    const f = fixture(false);
    NodeVM.runInContext(
      workspaceBootstrapScript("https://j1.example/", "private-handoff", true),
      f.context,
    );
    await f.receipt;
    expect(f.messages).toEqual([{ source: "j1-workspace", type: "authentication-failed" }]);
    expect(f.redirects).toEqual([]);
  });

  it("aborts a stalled handoff and reports a retryable failure", async () => {
    const f = fixture();
    let timeout!: () => void;
    let aborted = false;
    Object.assign(f.context, {
      setTimeout: (callback: () => void, delay: number) => {
        expect(delay).toBe(55_000);
        timeout = callback;
        return 1;
      },
      clearTimeout: () => {},
      fetch: (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("Aborted"));
          });
        }),
    });
    NodeVM.runInContext(
      workspaceBootstrapScript("https://j1.example/", "handoff", true),
      f.context,
    );
    timeout();
    await f.receipt;
    expect(aborted).toBe(true);
    expect(f.messages).toEqual([{ source: "j1-workspace", type: "authentication-failed" }]);
    expect(f.redirects).toEqual([]);
  });

  it("does not inject a handoff into another origin", () => {
    const f = fixture(true, "https://other.example");
    NodeVM.runInContext(
      workspaceBootstrapScript("https://j1.example/", "handoff", true),
      f.context,
    );
    expect(f.requests).toEqual([]);
    expect(f.messages).toEqual([]);
  });
});
