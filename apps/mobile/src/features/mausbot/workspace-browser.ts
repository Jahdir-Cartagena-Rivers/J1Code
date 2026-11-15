import * as Schema from "effect/Schema";

const WorkspaceHostMessage = Schema.Union([
  Schema.Struct({
    source: Schema.Literal("j1-workspace"),
    type: Schema.Literal("authenticated"),
    expiresAt: Schema.String,
  }),
  Schema.Struct({
    source: Schema.Literal("j1-workspace"),
    type: Schema.Literal("authentication-failed"),
  }),
  Schema.Struct({
    source: Schema.Literal("j1-workspace"),
    type: Schema.Literal("open-connections"),
  }),
  Schema.Struct({ source: Schema.Literal("j1-workspace"), type: Schema.Literal("open-app-tools") }),
]);
export const decodeWorkspaceHostMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(WorkspaceHostMessage),
);

export function workspaceScopesChanged(
  previous: ReadonlyArray<string> | null,
  next: ReadonlyArray<string>,
) {
  return previous !== null && [...previous].sort().join(" ") !== [...next].sort().join(" ");
}

export interface WorkspaceConversationTarget {
  readonly environmentId: string;
  readonly threadId: string;
}

export function workspaceConversationUrl(baseUrl: string, target: WorkspaceConversationTarget) {
  const home = workspaceBrowserUrls(baseUrl).home;
  const bot = /^mausbot:([\w-]{1,120}):([\w-]{1,120})$/.exec(target.threadId);
  if (bot) {
    const url = new URL("assistants", home);
    url.searchParams.set("environmentId", target.environmentId);
    url.searchParams.set("botId", bot[1]!);
    url.searchParams.set("conversation", bot[2]!);
    return url.toString();
  }
  return new URL(
    `${encodeURIComponent(target.environmentId)}/${encodeURIComponent(target.threadId)}`,
    home,
  ).toString();
}

export function selectWorkspaceEnvironment<
  T extends { environmentId: string; entry: { enabled: boolean } },
>(environments: ReadonlyArray<T>, selectedId: string | null): T | null {
  const enabled = environments.filter((environment) => environment.entry.enabled);
  if (selectedId !== null)
    return enabled.find((environment) => environment.environmentId === selectedId) ?? null;
  return enabled.length === 1 ? enabled[0]! : null;
}

export function workspaceBrowserUrls(baseUrl: string) {
  const base = new URL(baseUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:")
    throw new Error("Unsupported environment address.");
  if (base.username || base.password) throw new Error("Invalid environment address.");
  base.search = "";
  base.hash = "";
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return {
    home: base.toString(),
    pair: new URL("pair", base).toString(),
    redeem: new URL("api/auth/workspace-session", base).toString(),
  };
}

export function isWorkspaceBrowserUrl(baseUrl: string, target: string) {
  try {
    const base = new URL(workspaceBrowserUrls(baseUrl).home);
    const url = new URL(target);
    const resource = url.pathname.slice(base.pathname.length).split("/")[0];
    return (
      !["api", "attachments", "assets", "mausbot"].includes(resource ?? "") &&
      url.origin === base.origin &&
      (url.pathname === base.pathname.slice(0, -1) || url.pathname.startsWith(base.pathname)) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/** Only the one-use handoff is injected; the native access token stays native. */
export function workspaceBootstrapScript(
  baseUrl: string,
  credential: string,
  navigate: boolean,
  resumeUrl?: string,
) {
  const urls = workspaceBrowserUrls(baseUrl);
  const destination =
    resumeUrl && isWorkspaceBrowserUrl(baseUrl, resumeUrl) ? resumeUrl : urls.home;
  return `(() => {
    const config = ${JSON.stringify({ ...urls, credential, navigate, destination })};
    const home = new URL(config.home);
    if (location.origin !== home.origin || !(location.pathname === home.pathname.slice(0, -1) || location.pathname.startsWith(home.pathname))) return true;
    if (window.__j1WorkspaceHandoff === config.credential) return true;
    window.__j1WorkspaceHandoff = config.credential;
    const send = (value) => window.ReactNativeWebView?.postMessage(JSON.stringify({source:"j1-workspace",...value}));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55_000);
    void fetch(config.redeem, {
      signal:controller.signal, method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({credential:config.credential})
    }).then(async response => {
      if (!response.ok) throw new Error("Workspace authentication failed");
      const result = await response.json();
      if (result.authenticated !== true || !Number.isFinite(Date.parse(result.expiresAt))) throw new Error("Invalid workspace session");
      send({type:"authenticated",expiresAt:result.expiresAt});
      if (config.navigate) location.replace(config.destination);
    }).catch(() => send({type:"authentication-failed"})).finally(() => clearTimeout(timeout));
    return true;
  })(); true;`;
}
