import { useCallback, useEffect, useState } from "react";
import * as Effect from "effect/Effect";
import {
  type DotConnection,
  type ProjectId,
  RuntimeMode,
  type RuntimeMode as RuntimeModeType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { runPrimaryHttp } from "../../lib/runtime";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsSection } from "./settingsLayout";

const modes: Record<RuntimeModeType, string> = {
  "approval-required": "Ask for approval",
  "auto-accept-edits": "Accept edits automatically",
  auto: "Automatic permissions",
  "full-access": "Full access",
};
const isRuntimeMode = Schema.is(RuntimeMode);

export function DotConnectionsSettings({
  canManage,
  canReadProjects,
  canCreateTasks,
}: {
  canManage: boolean;
  canReadProjects: boolean;
  canCreateTasks: boolean;
}) {
  const [connections, setConnections] = useState<readonly DotConnection[]>([]);
  const [projects, setProjects] = useState<readonly { id: ProjectId; title: string }[]>([]);
  const [selected, setSelected] = useState<ProjectId[]>([]);
  const [label, setLabel] = useState("My Dot");
  const [read, setRead] = useState(canReadProjects);
  const [tasks, setTasks] = useState(false);
  const [memoryRead, setMemoryRead] = useState(false);
  const [memoryWrite, setMemoryWrite] = useState(false);
  const [mode, setMode] = useState<RuntimeModeType>("approval-required");
  const [credential, setCredential] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  const [oauthIssuer, setOAuthIssuer] = useState("");
  const [oauthResource, setOAuthResource] = useState("");
  const [oauthClient, setOAuthClient] = useState("j1-chatgpt-dot");
  const [oauthCallback, setOAuthCallback] = useState(
    "https://chatgpt.com/connector_platform_oauth_redirect",
  );
  const load = useCallback(
    () =>
      runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            Effect.all({
              connections: client.dot.connections({ headers: {} }),
              oauth: client.dot.oauthSetup({ headers: {} }),
              projects:
                canManage && canReadProjects
                  ? client.dot.projects({ headers: {} })
                  : Effect.succeed([]),
            }),
          ),
        ),
      ),
    [canManage, canReadProjects],
  );
  const applyLoaded = useCallback((data: Awaited<ReturnType<typeof load>>) => {
    setConnections(data.connections);
    setProjects(data.projects);
    setCheckedAt(Date.now());
    if (data.oauth) {
      setOAuthIssuer(data.oauth.issuer);
      setOAuthResource(data.oauth.resource);
      setOAuthClient(data.oauth.clientId);
      setOAuthCallback(data.oauth.redirectUri);
    }
  }, []);
  useEffect(() => {
    let current = true;
    void load()
      .then((data) => {
        if (current) applyLoaded(data);
      })
      .catch(() => {
        if (current)
          setError(
            "Could not load Dot connections. Check this environment's connection and server version.",
          );
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [load, applyLoaded]);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            client.dot.createConnection({
              headers: {},
              payload: {
                label,
                expiresInDays: 30,
                hiveMind: { read: memoryRead, write: memoryWrite },
                grants: selected.map((projectId) => ({
                  projectId,
                  read,
                  createTasks: tasks,
                  runtimeMode: mode,
                })),
              },
            }),
          ),
        ),
      );
      setCredential(result.credential);
      applyLoaded(await load());
    } catch {
      setError(
        "Could not create the connection. Refresh the list before retrying; a connection may have been saved.",
      );
    } finally {
      setBusy(false);
    }
  };
  const configureOAuth = async () => {
    setBusy(true);
    setError(null);
    try {
      await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            client.dot.configureOAuth({
              headers: {},
              payload: {
                issuer: oauthIssuer,
                resource: oauthResource,
                clientId: oauthClient,
                redirectUri: oauthCallback,
              },
            }),
          ),
        ),
      );
      applyLoaded(await load());
    } catch {
      setError(
        "Could not save OAuth setup. Use an HTTPS issuer origin, resource URL, and the exact callback shown by ChatGPT.",
      );
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) => client.dot.revokeConnection({ headers: {}, payload: { id } })),
        ),
      );
      setCredential(null);
      applyLoaded(await load());
    } catch {
      setError("Could not revoke the connection. Refresh to check its current status.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection id="dot-connections" title="ChatGPT Dot">
      <p className="text-sm text-muted-foreground">
        Prepare project and Hive Mind access for your existing Dot. Connecting the plugin in ChatGPT
        is a separate step.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="space-y-4 p-4">
        {credential ? (
          <div className="space-y-2">
            <p className="text-sm">
              This local MCP credential is shown only once. Keep it private. OAuth uses the prepared
              project and memory grants; your Dot is not connected yet.
            </p>
            <Textarea
              aria-label="Dot connection credential"
              readOnly
              value={credential}
              rows={2}
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button size="sm" variant="outline" onClick={() => setCredential(null)}>
              Hide credential
            </Button>
          </div>
        ) : null}
        {connections.map((connection) => (
          <div key={connection.id} className="flex items-start justify-between gap-4 border-b pb-3">
            <div className="space-y-1">
              <p className="text-sm font-medium">{connection.label}</p>
              <p className="text-xs text-muted-foreground">
                {connection.revokedAt
                  ? "Revoked"
                  : Date.parse(connection.expiresAt) <= checkedAt
                    ? "Expired"
                    : "Prepared"}{" "}
                · Expires {new Date(connection.expiresAt).toLocaleDateString()}
              </p>
              {connection.grants.map((grant) => (
                <p key={grant.projectId} className="text-xs text-muted-foreground">
                  {projects.find((project) => project.id === grant.projectId)?.title ??
                    grant.projectId}
                  : {grant.read ? "Read chats" : ""}
                  {grant.read && grant.createTasks ? "; " : ""}
                  {grant.createTasks ? `Create tasks (${modes[grant.runtimeMode]})` : ""}
                </p>
              ))}
              {connection.hiveMind?.read ? (
                <p className="text-xs text-muted-foreground">
                  Hive Mind: read all shared memories
                  {connection.hiveMind.write
                    ? "; save, correct and forget shared facts"
                    : " (read only)"}
                </p>
              ) : null}
            </div>
            {canManage && !connection.revokedAt ? (
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={busy}
                onClick={() => void revoke(connection.id)}
              >
                Revoke
              </Button>
            ) : null}
          </div>
        ))}
        {loading ? <p className="text-sm text-muted-foreground">Loading connections…</p> : null}
        {canManage ? (
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Plugin OAuth setup</legend>
            <p className="text-xs text-muted-foreground">
              Your browser must be able to reach the issuer for sign-in. The OpenAI tunnel can relay
              registered token endpoints. Changing these values invalidates existing OAuth links.
            </p>
            <label className="block space-y-1 text-sm">
              HTTPS issuer origin
              <Input
                value={oauthIssuer}
                maxLength={2048}
                placeholder="https://auth.example.com"
                onChange={(event) => setOAuthIssuer(event.currentTarget.value)}
              />
            </label>
            <label className="block space-y-1 text-sm">
              MCP resource URL
              <Input
                value={oauthResource}
                maxLength={2048}
                placeholder="https://mcp.example.com/dot/mcp"
                onChange={(event) => setOAuthResource(event.currentTarget.value)}
              />
            </label>
            <label className="block space-y-1 text-sm">
              OAuth client ID
              <Input
                value={oauthClient}
                maxLength={256}
                onChange={(event) => setOAuthClient(event.currentTarget.value)}
              />
            </label>
            <label className="block space-y-1 text-sm">
              ChatGPT callback URL
              <Input
                value={oauthCallback}
                maxLength={2048}
                onChange={(event) => setOAuthCallback(event.currentTarget.value)}
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={
                loading || busy || !oauthIssuer || !oauthResource || !oauthClient || !oauthCallback
              }
              onClick={() => void configureOAuth()}
            >
              Save OAuth setup
            </Button>
            <p className="text-xs text-muted-foreground">
              Use this client ID as a predefined public OAuth client in ChatGPT. Sign in to J1 on
              the issuer origin before connecting, then choose a prepared connection on the consent
              page.
            </p>
          </fieldset>
        ) : null}
        {canManage ? (
          <div className="space-y-3">
            <label className="block space-y-1 text-sm">
              Connection name
              <Input
                value={label}
                maxLength={120}
                onChange={(event) => setLabel(event.currentTarget.value)}
              />
            </label>
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm">Allowed projects</legend>
              {projects.length === 0 && !loading ? (
                <p className="text-sm text-muted-foreground">
                  Add a project for project access, or choose Hive Mind access below.
                </p>
              ) : null}
              {projects.map((project) => (
                <label key={project.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={selected.includes(project.id)}
                    onCheckedChange={(checked) =>
                      setSelected((current) =>
                        checked
                          ? [...current, project.id]
                          : current.filter((id) => id !== project.id),
                      )
                    }
                  />
                  {project.title}
                </label>
              ))}
            </fieldset>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={read} onCheckedChange={setRead} />
              Read project chats
            </label>
            {canCreateTasks ? (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={tasks} onCheckedChange={setTasks} />
                Create and manage its own tasks
              </label>
            ) : null}
            {tasks ? (
              <div className="space-y-1">
                <p className="text-sm">Task permissions</p>
                <Select
                  value={mode}
                  onValueChange={(value) => {
                    if (isRuntimeMode(value)) setMode(value);
                  }}
                >
                  <SelectTrigger aria-label="Dot task permissions">
                    <SelectValue>{modes[mode]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {Object.entries(modes).map(([value, text]) => (
                      <SelectItem key={value} value={value}>
                        {text}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Dot cannot increase these permissions. Approval and input requests appear in the
                  saved task chat.
                </p>
              </div>
            ) : null}
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Hive Mind access</legend>
              <p className="text-xs text-muted-foreground">
                Shared memories span all J1 projects and providers. This is separate from ChatGPT
                memory and requires no workers.
              </p>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={memoryRead}
                  onCheckedChange={(checked) => {
                    setMemoryRead(checked);
                    if (!checked) setMemoryWrite(false);
                  }}
                />
                Read all shared memories
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={memoryWrite}
                  disabled={!memoryRead}
                  onCheckedChange={setMemoryWrite}
                />
                Save, correct and forget shared facts
              </label>
            </fieldset>
            <Button
              size="sm"
              disabled={
                busy ||
                loading ||
                (selected.length === 0 && !memoryRead) ||
                !label.trim() ||
                (selected.length > 0 && !read && !tasks) ||
                credential !== null
              }
              onClick={() => void create()}
            >
              {busy ? "Saving…" : "Prepare connection"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Connections expire after 30 days. Revoking access stops new tool calls; already
              running tasks remain in J1.
            </p>
          </div>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setError(null);
            void load()
              .then(applyLoaded)
              .catch(() => setError("Could not refresh Dot connections."));
          }}
        >
          Refresh
        </Button>
      </div>
    </SettingsSection>
  );
}
