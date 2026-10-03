import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeHttpServer } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  CommandId,
  AgentDelegationResult,
  DotConnection,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { describe, expect } from "vite-plus/test";
import { ServerConfig } from "../config.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { AgentDelegation, AgentDelegationLive } from "../mcp/AgentDelegation.ts";
import { DotConnections, layer as connectionsLayer } from "./DotConnections.ts";
import { DotInvocation, DotService, layer as serviceLayer } from "./DotService.ts";
import * as DotHttpServer from "./DotHttpServer.ts";
import * as DotHiveMind from "./DotHiveMind.ts";
import * as DotChat from "./DotChat.ts";
import * as DotChatWebhook from "./DotChatWebhook.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { environmentAuthenticatedAuthLayer } from "../auth/http.ts";
import * as DotAdminHttp from "./adminHttp.ts";
import { layer as oauthLayer } from "./DotOAuth.ts";
import * as DotOAuthHttp from "./DotOAuthHttp.ts";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  AuthAdministrativeScopes,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";

const NOW = "2026-10-02T12:00:00.000Z";
const decodeOAuthToken = Schema.decodeUnknownEffect(
  Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String }),
);
const decodeMemoryResponse = Schema.decodeUnknownEffect(
  Schema.Struct({
    result: Schema.Struct({
      structuredContent: Schema.Struct({ memory: Schema.Struct({ id: Schema.String }) }),
    }),
  }),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isConnection = Schema.is(DotConnection);
const decodeTaskResponse = Schema.decodeUnknownEffect(
  Schema.Struct({ result: Schema.Struct({ structuredContent: AgentDelegationResult }) }),
);
const projectId = ProjectId.make("dot-project");
const otherProject = ProjectId.make("other-project");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  checkedAt: NOW,
  auth: { status: "authenticated" },
  models: [{ slug: "test-model", name: "Test model", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};
const infrastructure = OrchestrationLayerLive.pipe(
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j1-dot-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const base = Layer.mergeAll(
  infrastructure,
  Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
  Layer.mock(ProviderService)({
    getInstanceInfo: (id) =>
      Effect.succeed({
        instanceId: id,
        driverKind: ProviderDriverKind.make("codex"),
        displayName: "Codex",
        enabled: true,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make("codex"),
          continuationKey: "test",
        },
      }),
    stopSession: () => Effect.void,
  }),
);
const services = serviceLayer.pipe(
  Layer.provideMerge(
    DotChat.layer.pipe(Layer.provide(DotChatWebhook.layer), Layer.provide(ServerSecretStore.layer)),
  ),
  Layer.provideMerge(DotHiveMind.layer),
  Layer.provideMerge(connectionsLayer),
  Layer.provideMerge(oauthLayer.pipe(Layer.provide(connectionsLayer))),
  Layer.provideMerge(AgentDelegationLive),
);
const testLayer = services.pipe(Layer.provideMerge(base));
const authServices = EnvironmentAuth.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
);
const transportTestLayer = Layer.mergeAll(
  services,
  authServices,
  McpSessionRegistry.layer.pipe(
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("dot-http-test")),
      }),
    ),
  ),
).pipe(Layer.provideMerge(base), Layer.provideMerge(NodeHttpServer.layerTest));
class DotTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.dot) {}
const dispatch = Effect.fn("dot.test.dispatch")(function* (command: OrchestrationCommand) {
  yield* (yield* OrchestrationEngineService).dispatch(command);
});
const seed = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse(NOW));
  yield* (yield* AgentDelegation).models({
    environmentId: EnvironmentId.make("test"),
    threadId: ThreadId.make("unused"),
    providerSessionId: "unused",
    providerInstanceId: instanceId,
    capabilities: new Set(["agents"]),
    issuedAt: 0,
  });
  for (const id of [projectId, otherProject]) {
    yield* dispatch({
      type: "project.create",
      commandId: CommandId.make(`project:${id}`),
      projectId: id,
      title: id,
      workspaceRoot: `${process.cwd()}/${id}`,
      defaultModelSelection: null,
      createdAt: NOW,
    });
    yield* dispatch({
      type: "thread.create",
      commandId: CommandId.make(`chat:${id}`),
      threadId: ThreadId.make(`chat:${id}`),
      projectId: id,
      title: `Chat ${id}`,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
    });
  }
});
const settings = (read = true, createTasks = true) => ({
  label: "Actual Dot",
  grants: [{ projectId, read, createTasks, runtimeMode: "approval-required" as const }],
  expiresInDays: 30,
});
const task = (requestId = "one") => ({
  projectId,
  requestId,
  title: "Bounded inspection",
  task: "Inspect only; do not change files.",
  modelSelection,
});
const asDot = <A, E>(connectionId: string, effect: Effect.Effect<A, E, DotInvocation>) =>
  effect.pipe(Effect.provideService(DotInvocation, { connectionId }));

describe("durable Dot connections and independent tasks", () => {
  it.effect(
    "persists only hashed credentials, resolves after rebuilding, and rejects revocation, expiry, and malformed storage",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const connections = yield* DotConnections;
        const issued = yield* connections.create(settings());
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          token_hash: string;
          connection_json: string;
        }>`SELECT token_hash, connection_json FROM dot_connections`;
        expect(rows[0]!.connection_json).not.toContain(issued.credential);
        expect(rows[0]!.token_hash).toHaveLength(64);
        const rebuilt = yield* Layer.build(Layer.fresh(connectionsLayer));
        const rebuiltConnections = yield* DotConnections.pipe(Effect.provideContext(rebuilt));
        const refreshed = yield* rebuiltConnections.resolve(issued.credential);
        expect(Option.getOrThrow(refreshed).id).toBe(issued.connection.id);
        expect(Option.isNone(yield* connections.resolve("provider-session-token"))).toBe(true);
        yield* connections.revoke(issued.connection.id);
        expect(Option.isNone(yield* connections.resolve(issued.credential))).toBe(true);
        yield* connections.revoke(issued.connection.id);
        const expiring = yield* connections.create(settings());
        yield* TestClock.adjust("31 days");
        expect(Option.isNone(yield* connections.resolve(expiring.credential))).toBe(true);
        yield* sql`UPDATE dot_connections SET connection_json = ${"{malformed"} WHERE id = ${expiring.connection.id}`;
        expect(
          (yield* connections.resolve(expiring.credential).pipe(Effect.flip)).message,
        ).toContain("persist");
        expect(
          (yield* sql<{
            connection_json: string;
          }>`SELECT connection_json FROM dot_connections WHERE id = ${expiring.connection.id}`)[0]!
            .connection_json,
        ).toBe("{malformed");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "serves isolated HTTP MCP tool discovery and rejects cross-route credentials and revoked sessions",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* seed;
          const issued = yield* (yield* DotConnections).create({
            ...settings(),
            hiveMind: { read: true, write: true },
          });
          const providerCredential = yield* (yield* McpSessionRegistry.McpSessionRegistry).issue({
            threadId: ThreadId.make(`chat:${projectId}`),
            providerInstanceId: instanceId,
            capabilities: new Set(["agents"]),
          });
          const routes = Layer.mergeAll(
            DotHttpServer.layer,
            DotOAuthHttp.layer,
            Layer.mergeAll(
              McpHttpServer.AgentsToolkitRegistrationLive,
              McpHttpServer.HiveMindToolkitRegistrationLive,
            ).pipe(Layer.provideMerge(McpHttpServer.McpTransportLive)),
            HttpApiBuilder.layer(DotTestApi).pipe(
              Layer.provide(DotAdminHttp.layer),
              Layer.provide(environmentAuthenticatedAuthLayer),
            ),
          );
          yield* HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
            Layer.build,
          );
          const http = yield* HttpClient.HttpClient;
          const auth = yield* EnvironmentAuth.EnvironmentAuth;
          const admin = yield* auth.issueSession({ scopes: AuthAdministrativeScopes });
          const reader = yield* auth.issueSession({ scopes: [AuthAccessReadScope] });
          const insufficient = yield* auth.issueSession({ scopes: [AuthAccessWriteScope] });
          const chatReader = yield* auth.issueSession({ scopes: [AuthOrchestrationReadScope] });
          expect((yield* http.get("/api/dot/chat")).status).toBe(401);
          expect(
            (yield* http.get("/api/dot/chat", {
              headers: { authorization: `Bearer ${reader.token}` },
            })).status,
          ).toBe(403);
          const chatPage = yield* http.get("/api/dot/chat", {
            headers: { authorization: `Bearer ${chatReader.token}` },
          });
          expect(chatPage.status).toBe(200);
          expect(chatPage.headers["cache-control"]).toBe("no-store");
          expect(yield* chatPage.json).toMatchObject({ connectionId: null, messages: [] });
          const sendJson = yield* encodeJson({
            connectionId: issued.connection.id,
            requestId: "read-only",
            text: "hello",
          });
          expect(
            (yield* http.post("/api/dot/chat/send", {
              headers: { authorization: `Bearer ${chatReader.token}` },
              body: HttpBody.text(sendJson, "application/json"),
            })).status,
          ).toBe(403);
          const waitJson = yield* encodeJson({ revision: -1 });
          expect(
            (yield* http.post("/api/dot/chat/wait", {
              headers: { authorization: `Bearer ${reader.token}` },
              body: HttpBody.text(waitJson, "application/json"),
            })).status,
          ).toBe(403);
          expect((yield* http.get("/api/dot/connections")).status).toBe(401);
          const listed = yield* http.get("/api/dot/connections", {
            headers: { authorization: `Bearer ${admin.token}` },
          });
          expect(listed.status).toBe(200);
          expect(listed.headers["cache-control"]).toBe("no-store");
          expect(yield* listed.json).toMatchObject([{ id: issued.connection.id }]);
          const settingsJson = yield* encodeJson(settings());
          expect(
            (yield* http.post("/api/dot/connections", {
              headers: { authorization: `Bearer ${reader.token}` },
              body: HttpBody.text(settingsJson, "application/json"),
            })).status,
          ).toBe(403);
          expect(
            (yield* http.post("/api/dot/connections", {
              headers: { authorization: `Bearer ${insufficient.token}` },
              body: HttpBody.text(settingsJson, "application/json"),
            })).status,
          ).toBe(403);
          const adminCreated = yield* http.post("/api/dot/connections", {
            headers: { authorization: `Bearer ${admin.token}` },
            body: HttpBody.text(settingsJson, "application/json"),
          });
          expect(adminCreated.status).toBe(200);
          expect(adminCreated.headers["cache-control"]).toBe("no-store");
          const oauthSetup = {
            issuer: "https://auth.example.test",
            resource: "https://mcp.example.test/dot/mcp",
            clientId: "j1-chatgpt-dot",
            redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
          };
          const setupJson = yield* encodeJson(oauthSetup);
          expect(
            (yield* http.post("/api/dot/oauth-setup", {
              headers: { authorization: `Bearer ${reader.token}` },
              body: HttpBody.text(setupJson, "application/json"),
            })).status,
          ).toBe(403);
          expect(
            (yield* http.post("/api/dot/oauth-setup", {
              headers: { authorization: `Bearer ${admin.token}` },
              body: HttpBody.text(setupJson, "application/json"),
            })).status,
          ).toBe(200);
          expect(
            yield* (yield* http.get("/.well-known/oauth-protected-resource/dot/mcp")).json,
          ).toMatchObject({
            resource: oauthSetup.resource,
            authorization_servers: [oauthSetup.issuer],
          });
          expect(
            yield* (yield* http.get("/.well-known/oauth-authorization-server")).json,
          ).toMatchObject({
            issuer: oauthSetup.issuer,
            code_challenge_methods_supported: ["S256"],
            authorization_response_iss_parameter_supported: true,
            token_endpoint_auth_methods_supported: ["none"],
          });
          const verifier = "a".repeat(43);
          const challenge = "ZtNPunH49FD35FWYhT5Tv8I7vRKQJ8uxMaL0_9eHjNA";
          const authQuery = new URLSearchParams({
            response_type: "code",
            client_id: oauthSetup.clientId,
            redirect_uri: oauthSetup.redirectUri,
            resource: oauthSetup.resource,
            scope: "dot:read",
            state: "dot-state",
            code_challenge: challenge,
            code_challenge_method: "S256",
          }).toString();
          const badScopeQuery = new URLSearchParams(authQuery);
          badScopeQuery.set("scope", "dot:admin");
          const failedAuthorization = yield* http
            .get(`/oauth/dot/authorize?${badScopeQuery}`, {
              headers: { authorization: `Bearer ${admin.token}` },
            })
            .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
          expect(failedAuthorization.status).toBe(303);
          const failedCallback = new URL(failedAuthorization.headers.location!);
          expect(failedCallback.origin + failedCallback.pathname).toBe(oauthSetup.redirectUri);
          expect(failedCallback.searchParams.get("error")).toBe("invalid_scope");
          expect(failedCallback.searchParams.get("state")).toBe("dot-state");
          expect(failedCallback.searchParams.get("iss")).toBe(oauthSetup.issuer);
          badScopeQuery.set("redirect_uri", "https://untrusted.example.test/callback");
          expect(
            (yield* http.get(`/oauth/dot/authorize?${badScopeQuery}`, {
              headers: { authorization: `Bearer ${admin.token}` },
            })).status,
          ).toBe(400);
          expect((yield* http.get(`/oauth/dot/authorize?${authQuery}`)).status).toBe(401);
          expect(
            (yield* http.get(`/oauth/dot/authorize?${authQuery}`, {
              headers: { authorization: `Bearer ${reader.token}` },
            })).status,
          ).toBe(401);
          const consent = yield* http.get(`/oauth/dot/authorize?${authQuery}`, {
            headers: { authorization: `Bearer ${admin.token}` },
          });
          expect(consent.status).toBe(200);
          expect(consent.headers["referrer-policy"]).toBe("same-origin");
          expect(consent.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
          expect(consent.headers["content-security-policy"]).toContain(
            "form-action 'self' https://chatgpt.com;",
          );
          const consentHtml = yield* consent.text;
          const csrf = consentHtml.match(/name="request_id" value="([^"]+)"/)?.[1];
          expect(csrf).toBeTypeOf("string");
          const consentBody = new URLSearchParams({
            request_id: csrf!,
            connection_id: issued.connection.id,
            decision: "allow",
          }).toString();
          expect(
            (yield* http.post("/oauth/dot/authorize", {
              headers: {
                authorization: `Bearer ${admin.token}`,
                origin: "https://wrong.example.test",
              },
              body: HttpBody.text(consentBody, "application/x-www-form-urlencoded"),
            })).status,
          ).toBe(400);
          expect(
            (yield* http.post("/oauth/dot/authorize", {
              headers: { authorization: `Bearer ${admin.token}` },
              body: HttpBody.text(consentBody, "application/x-www-form-urlencoded"),
            })).status,
          ).toBe(400);
          const consented = yield* http
            .post("/oauth/dot/authorize", {
              headers: { authorization: `Bearer ${admin.token}`, origin: oauthSetup.issuer },
              body: HttpBody.text(consentBody, "application/x-www-form-urlencoded"),
            })
            .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
          expect(consented.status).toBe(303);
          const callback = new URL(consented.headers.location!);
          expect(callback.searchParams.get("state")).toBe("dot-state");
          expect(callback.searchParams.get("iss")).toBe(oauthSetup.issuer);
          const code = callback.searchParams.get("code")!;
          const tokenBody = new URLSearchParams({
            grant_type: "authorization_code",
            client_id: oauthSetup.clientId,
            redirect_uri: oauthSetup.redirectUri,
            resource: oauthSetup.resource,
            code,
            code_verifier: verifier,
          }).toString();
          const exchanged = yield* http.post("/oauth/dot/token", {
            body: HttpBody.text(tokenBody, "application/x-www-form-urlencoded"),
          });
          expect(exchanged.status).toBe(200);
          expect(exchanged.headers["cache-control"]).toBe("no-store");
          const token = yield* exchanged.json.pipe(Effect.flatMap(decodeOAuthToken));
          expect(
            (yield* http.post("/oauth/dot/token", {
              body: HttpBody.text(tokenBody, "application/x-www-form-urlencoded"),
            })).status,
          ).toBe(400);
          let requestId = 0;
          const post = Effect.fn("dot.test.post")(function* (
            path: string,
            bearer: string,
            method: string,
            params: unknown = {},
            sessionId?: string,
          ) {
            const body = yield* encodeJson({
              jsonrpc: "2.0",
              ...(method.startsWith("notifications/") ? {} : { id: ++requestId }),
              method,
              params,
            });
            return yield* http.post(path, {
              headers: {
                accept: "application/json, text/event-stream",
                authorization: bearer,
                ...(sessionId
                  ? { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" }
                  : {}),
              },
              body: HttpBody.text(body, "application/json"),
            });
          });
          const initParams = {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "dot-test", version: "1" },
          };
          const dotInit = yield* post(
            "/dot/mcp",
            `Bearer ${issued.credential}`,
            "initialize",
            initParams,
          );
          expect(dotInit.status).toBe(200);
          expect(yield* dotInit.json).toHaveProperty("result");
          const dotSession = dotInit.headers["mcp-session-id"];
          const oauthInit = yield* post(
            "/dot/mcp",
            `Bearer ${token.access_token}`,
            "initialize",
            initParams,
          );
          expect(oauthInit.status).toBe(200);
          expect(yield* oauthInit.json).toHaveProperty("result");
          const oauthProjects = yield* post(
            "/dot/mcp",
            `Bearer ${token.access_token}`,
            "tools/call",
            { name: "list_projects", arguments: {} },
            oauthInit.headers["mcp-session-id"],
          );
          expect(yield* oauthProjects.json).toMatchObject({
            result: {
              isError: false,
              structuredContent: { projects: [{ grant: { read: true, createTasks: false } }] },
            },
          });
          const oauthDenied = yield* post(
            "/dot/mcp",
            `Bearer ${token.access_token}`,
            "tools/call",
            { name: "create_task", arguments: task("oauth-denied") },
            oauthInit.headers["mcp-session-id"],
          );
          expect(yield* oauthDenied.json).toMatchObject({ result: { isError: true } });
          const providerInit = yield* post(
            "/mcp",
            providerCredential.config.authorizationHeader,
            "initialize",
            initParams,
          );
          expect(providerInit.status).toBe(200);
          expect(yield* providerInit.json).toHaveProperty("result");
          const providerSession = providerInit.headers["mcp-session-id"];
          expect(dotSession).toBeTypeOf("string");
          expect(providerSession).toBeTypeOf("string");
          expect(
            (yield* post(
              "/dot/mcp",
              `Bearer ${issued.credential}`,
              "notifications/initialized",
              {},
              dotSession,
            )).status,
          ).toBe(202);
          expect(
            (yield* post(
              "/mcp",
              providerCredential.config.authorizationHeader,
              "notifications/initialized",
              {},
              providerSession,
            )).status,
          ).toBe(202);
          const listSchema = Schema.Struct({
            result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
          });
          const dotListResponse = yield* post(
            "/dot/mcp",
            `Bearer ${issued.credential}`,
            "tools/list",
            {},
            dotSession,
          );
          const dotListRaw = yield* dotListResponse.json;
          expect(dotListResponse.status).toBe(200);
          expect(dotListRaw).toHaveProperty("result");
          expect(dotListRaw).toMatchObject({
            result: {
              tools: expect.arrayContaining([
                expect.objectContaining({
                  name: "read_dot_chat",
                  securitySchemes: [{ type: "oauth2", scopes: ["dot:chat"] }],
                }),
                expect.objectContaining({
                  name: "hive_mind_recall",
                  securitySchemes: [{ type: "oauth2", scopes: ["dot:memory:read"] }],
                  _meta: { securitySchemes: [{ type: "oauth2", scopes: ["dot:memory:read"] }] },
                }),
                expect.objectContaining({
                  name: "hive_mind_remember",
                  securitySchemes: [{ type: "oauth2", scopes: ["dot:memory:write"] }],
                  _meta: { securitySchemes: [{ type: "oauth2", scopes: ["dot:memory:write"] }] },
                }),
                expect.objectContaining({
                  name: "hive_mind_forget",
                  securitySchemes: [{ type: "oauth2", scopes: ["dot:memory:write"] }],
                  _meta: { securitySchemes: [{ type: "oauth2", scopes: ["dot:memory:write"] }] },
                }),
              ]),
            },
          });
          const dotList = yield* Schema.decodeUnknownEffect(listSchema)(dotListRaw);
          expect(dotList.result.tools.map((tool) => tool.name).sort()).toEqual(
            [
              "list_projects",
              "list_models",
              "list_threads",
              "read_thread",
              "create_task",
              "get_task",
              "cancel_task",
              "hive_mind_recall",
              "hive_mind_remember",
              "hive_mind_forget",
              "post_dot_reply",
              "read_dot_chat",
            ].sort(),
          );

          const postMcp2 = Effect.fn("dot.test.mcp2")(function* (
            method: string,
            params: unknown,
            bearer?: string,
          ) {
            const json = yield* encodeJson({ jsonrpc: "2.0", id: "mcp2-check", method, params });
            const response = yield* http.post("/dot/mcp", {
              headers: {
                "content-type": "application/json",
                "mcp-protocol-version": "2026-07-28",
                ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
              },
              body: HttpBody.text(json, "application/json"),
            });
            return { status: response.status, body: yield* response.json };
          });
          expect(yield* postMcp2("server/discover", {})).toMatchObject({
            status: 200,
            body: {
              id: "mcp2-check",
              result: {
                supportedVersions: ["2026-07-28", "2025-06-18"],
                capabilities: { events: {} },
              },
            },
          });
          expect((yield* postMcp2("tools/list", {})).status).toBe(401);
          expect((yield* postMcp2("tools/list", {}, issued.credential)).body).toMatchObject({
            result: {
              tools: expect.arrayContaining([
                expect.objectContaining({
                  name: "post_dot_reply",
                  securitySchemes: [{ type: "oauth2", scopes: ["dot:chat"] }],
                }),
              ]),
            },
          });
          expect(
            (yield* postMcp2(
              "tools/call",
              { name: "list_projects", arguments: {} },
              issued.credential,
            )).body,
          ).toMatchObject({
            result: {
              structuredContent: {
                projects: expect.arrayContaining([expect.objectContaining({ id: projectId })]),
              },
            },
          });
          expect(
            (yield* postMcp2(
              "tools/call",
              { name: "read_dot_chat", arguments: { pendingOnly: true } },
              issued.credential,
            )).body,
          ).toMatchObject({
            error: { message: "This Dot connection does not have native chat permission." },
          });
          expect(
            (yield* postMcp2(
              "tools/call",
              { name: "post_dot_reply", arguments: { messageId: "unknown", text: "denied" } },
              issued.credential,
            )).body,
          ).toMatchObject({
            error: { message: "This Dot connection does not have native chat permission." },
          });
          const providerListResponse = yield* post(
            "/mcp",
            providerCredential.config.authorizationHeader,
            "tools/list",
            {},
            providerSession,
          );
          const providerList = yield* providerListResponse.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(listSchema)),
          );
          expect(providerList.result.tools.map((tool) => tool.name)).toContain("spawn_agent");
          expect(providerList.result.tools.map((tool) => tool.name)).not.toContain("create_task");
          const projectsResponse = yield* post(
            "/dot/mcp",
            `Bearer ${issued.credential}`,
            "tools/call",
            { name: "list_projects", arguments: {} },
            dotSession,
          );
          expect(yield* projectsResponse.json).toMatchObject({
            result: { isError: false, structuredContent: { projects: [{ id: projectId }] } },
          });
          const call = Effect.fn("dot.test.call")(function* (
            name: string,
            arguments_: unknown,
            bearer = issued.credential,
          ) {
            const response = yield* post(
              "/dot/mcp",
              `Bearer ${bearer}`,
              "tools/call",
              { name, arguments: arguments_ },
              dotSession,
            );
            expect(response.status).toBe(200);
            return yield* response.json;
          });
          // OAuth cannot inherit newly available memory rights from project scopes.
          expect(
            yield* call("hive_mind_recall", { query: "shared memory" }, token.access_token),
          ).toMatchObject({
            result: {
              isError: true,
              _meta: {
                "mcp/www_authenticate": [
                  expect.stringContaining('scope="dot:read dot:memory:read"'),
                ],
              },
            },
          });
          expect(
            yield* call(
              "hive_mind_remember",
              { scope: "general", subject: "Must not write", fact: "Denied" },
              token.access_token,
            ),
          ).toMatchObject({
            result: {
              isError: true,
              _meta: {
                "mcp/www_authenticate": [expect.stringContaining("dot:memory:write")],
              },
            },
          });
          const remembered = yield* call("hive_mind_remember", {
            scope: "general",
            subject: "Dot shared memory test",
            fact: "Shared memory round trip.",
          });
          expect(remembered).toMatchObject({
            result: {
              isError: false,
              structuredContent: { memory: { sourceThreadId: `j1-dot:${issued.connection.id}` } },
            },
          });
          const memoryResult = yield* decodeMemoryResponse(remembered);
          const memoryId = memoryResult.result.structuredContent.memory.id;
          const providerRecall = yield* post(
            "/mcp",
            providerCredential.config.authorizationHeader,
            "tools/call",
            { name: "hive_mind_recall", arguments: { query: "Dot shared memory test" } },
            providerSession,
          );
          expect(yield* providerRecall.json).toMatchObject({
            result: {
              structuredContent: {
                memories: [{ id: memoryId, fact: "Shared memory round trip." }],
              },
            },
          });
          expect(yield* call("hive_mind_forget", { id: memoryId })).toMatchObject({
            result: { structuredContent: { removed: true } },
          });
          const reservations = yield* (yield* SqlClient.SqlClient)<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM dot_task_requests`;
          expect(reservations[0]?.count).toBe(0);
          const taskResponse = yield* call("create_task", task("http-task"));
          expect(taskResponse).toMatchObject({ result: { isError: false } });
          const taskResult = yield* decodeTaskResponse(taskResponse);
          const created = taskResult.result.structuredContent;
          expect(yield* call("create_task", task("http-task"))).toMatchObject({
            result: { structuredContent: { threadId: created.threadId } },
          });
          expect(yield* call("get_task", { projectId, threadId: created.threadId })).toMatchObject({
            result: { isError: false, structuredContent: { threadId: created.threadId } },
          });
          const foreign = yield* (yield* DotConnections).create({
            ...settings(),
            grants: [{ ...settings().grants[0]!, projectId: otherProject }],
          });
          expect(
            yield* call("hive_mind_recall", { query: "shared memory" }, foreign.credential),
          ).toMatchObject({ result: { isError: true } });
          // An MCP transport session must never freeze the first caller's project grants.
          expect(yield* call("list_projects", {}, foreign.credential)).toMatchObject({
            result: { isError: false, structuredContent: { projects: [{ id: otherProject }] } },
          });
          expect(
            yield* call(
              "cancel_task",
              { projectId, threadId: created.threadId },
              foreign.credential,
            ),
          ).toMatchObject({ result: { isError: true } });
          expect(
            yield* call("read_thread", {
              projectId,
              threadId: ThreadId.make(`chat:${otherProject}`),
            }),
          ).toMatchObject({ result: { isError: true } });
          expect(
            yield* call("cancel_task", { projectId, threadId: created.threadId }),
          ).toMatchObject({
            result: { isError: false, structuredContent: { status: "cancelled" } },
          });
          expect(
            (yield* post(
              "/dot/mcp",
              providerCredential.config.authorizationHeader,
              "initialize",
              initParams,
            )).status,
          ).toBe(401);
          expect(
            (yield* post("/mcp", `Bearer ${issued.credential}`, "initialize", initParams)).status,
          ).toBe(401);
          yield* (yield* DotConnections).revoke(issued.connection.id);
          const oauthRevoked = yield* post(
            "/dot/mcp",
            `Bearer ${token.access_token}`,
            "tools/list",
            {},
            oauthInit.headers["mcp-session-id"],
          );
          expect(oauthRevoked.status).toBe(401);
          expect(oauthRevoked.headers["www-authenticate"]).toContain(
            "https://mcp.example.test/.well-known/oauth-protected-resource/dot/mcp",
          );
          expect(
            (yield* post("/dot/mcp", `Bearer ${issued.credential}`, "tools/list", {}, dotSession))
              .status,
          ).toBe(401);
        }),
      ).pipe(Effect.provide(transportTestLayer)),
  );

  it.effect(
    "rejects unknown/duplicate projects and keeps chat access separate from task permission",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const connections = yield* DotConnections;
        expect(
          (yield* connections
            .create({
              ...settings(),
              grants: [{ ...settings().grants[0]!, projectId: ProjectId.make("missing") }],
            })
            .pipe(Effect.flip)).message,
        ).toContain("does not exist");
        expect(
          (yield* connections
            .create({ ...settings(), grants: [...settings().grants, ...settings().grants] })
            .pipe(Effect.flip)).message,
        ).toContain("only once");
        const readonly = yield* connections.create(settings(true, false));
        const dot = yield* DotService;
        const projects = yield* asDot(readonly.connection.id, dot.projects);
        expect(projects.projects.map((project) => project.id)).toEqual([projectId]);
        expect(
          (yield* asDot(readonly.connection.id, dot.create(task())).pipe(Effect.flip)).message,
        ).toContain("no access");
        expect(
          (yield* asDot(
            readonly.connection.id,
            dot.read({ projectId, threadId: ThreadId.make(`chat:${otherProject}`) }),
          ).pipe(Effect.flip)).message,
        ).toContain("no access");
        const page = yield* asDot(readonly.connection.id, dot.threads({ projectId, limit: 1 }));
        expect(page.threads).toHaveLength(1);
        expect(
          (yield* asDot(readonly.connection.id, dot.threads({ projectId: otherProject })).pipe(
            Effect.flip,
          )).message,
        ).toContain("no access");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "creates tasks without an active provider parent, preserves permissions, and rejects conflicting retries and foreign cancellation",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const connections = yield* DotConnections;
        const issued = yield* connections.create(settings(false, true));
        const another = yield* connections.create(settings());
        const dot = yield* DotService;
        const created = yield* asDot(issued.connection.id, dot.create(task()));
        const snapshots = yield* ProjectionSnapshotQuery;
        const coordinator = Option.getOrThrow(
          yield* snapshots.getThreadShellById(created.parentThreadId),
        );
        const worker = Option.getOrThrow(yield* snapshots.getThreadDetailById(created.threadId));
        expect(coordinator.session).toBeNull();
        expect(worker.runtimeMode).toBe("approval-required");
        expect(worker.messages.filter((message) => message.role === "user")).toHaveLength(1);
        expect((yield* asDot(issued.connection.id, dot.create(task()))).threadId).toBe(
          created.threadId,
        );
        expect(
          (yield* asDot(
            issued.connection.id,
            dot.create({ ...task(), task: "Different task" }),
          ).pipe(Effect.flip)).message,
        ).toContain("different Dot task");
        expect(
          (yield* asDot(another.connection.id, dot.cancel(projectId, created.threadId)).pipe(
            Effect.flip,
          )).message,
        ).toContain("no access");
        expect(
          (yield* asDot(
            issued.connection.id,
            dot.read({ projectId, threadId: created.threadId }),
          ).pipe(Effect.flip)).message,
        ).toContain("no access");
        expect(
          (yield* asDot(issued.connection.id, dot.get(projectId, created.threadId))).threadId,
        ).toBe(created.threadId);
        yield* dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("task-output"),
          threadId: created.threadId,
          messageId: MessageId.make("task-output"),
          delta: "x".repeat(12_000),
          createdAt: NOW,
        });
        const output = yield* asDot(issued.connection.id, dot.get(projectId, created.threadId));
        expect(output.output).toHaveLength(8_000);
        expect(output.outputTruncated).toBe(true);
        expect(output.page).not.toBeNull();
        expect(
          (yield* asDot(issued.connection.id, dot.cancel(projectId, created.threadId))).status,
        ).toBe("cancelled");
        yield* connections.revoke(issued.connection.id);
        expect(
          (yield* asDot(issued.connection.id, dot.get(projectId, created.threadId)).pipe(
            Effect.flip,
          )).message,
        ).toContain("revoked");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "recovers durable request/task ownership across service restart without resending work",
    () =>
      Effect.gen(function* () {
        let connectionId = "";
        let threadId = ThreadId.make("pending");
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* seed;
            const issued = yield* (yield* DotConnections).create(settings());
            connectionId = issued.connection.id;
            const dot = yield* DotService;
            threadId = (yield* asDot(connectionId, dot.create(task()))).threadId;
          }).pipe(Effect.provide(services)),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const dot = yield* DotService;
            const result = yield* asDot(connectionId, dot.get(projectId, threadId));
            expect(result.status).toBe("interrupted");
            expect((yield* asDot(connectionId, dot.create(task()))).threadId).toBe(threadId);
            const detail = Option.getOrThrow(
              yield* (yield* ProjectionSnapshotQuery).getThreadDetailById(threadId),
            );
            expect(detail.messages.filter((message) => message.role === "user")).toHaveLength(1);
          }).pipe(Effect.provide(services)),
        );
      }).pipe(Effect.provide(base)),
  );

  it.effect(
    "keeps Hive Mind permissions separate, supports memory-only connections, and preserves source identity",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const connections = yield* DotConnections;
        const hive = yield* DotHiveMind.DotHiveMind;
        const old = yield* connections.create(settings());
        expect(
          yield* asDot(old.connection.id, hive.recall({ query: "memory" })).pipe(Effect.flip),
        ).toMatchObject({ _tag: "DotIntegrationError" });
        const readOnly = yield* connections.create({
          label: "Memory read",
          grants: [],
          hiveMind: { read: true, write: false },
          expiresInDays: 1,
        });
        const write = yield* connections.create({
          label: "Memory write",
          grants: [],
          hiveMind: { read: true, write: true },
          expiresInDays: 1,
        });
        const input = {
          scope: "project" as const,
          project: "J1Code",
          subject: "Dot memory check",
          fact: "First version",
        };
        const first = yield* asDot(write.connection.id, hive.remember(input));
        const updated = yield* asDot(
          write.connection.id,
          hive.remember({ ...input, fact: "Corrected version" }),
        );
        expect(updated.memory.id).toBe(first.memory.id);
        expect(updated.memory.sourceThreadId).toBe(`j1-dot:${write.connection.id}`);
        expect(
          (yield* asDot(readOnly.connection.id, hive.recall({ query: input.subject }))).memories,
        ).toMatchObject([{ id: first.memory.id, fact: "Corrected version" }]);
        expect(
          yield* asDot(readOnly.connection.id, hive.forget({ id: first.memory.id })).pipe(
            Effect.flip,
          ),
        ).toMatchObject({ _tag: "DotIntegrationError" });
        expect(
          yield* hive.remember(input).pipe(
            Effect.provideService(DotInvocation, {
              connectionId: write.connection.id,
              scopes: ["dot:read"],
            }),
            Effect.flip,
          ),
        ).toMatchObject({ _tag: "DotIntegrationError" });
        yield* connections.revoke(write.connection.id);
        expect(
          yield* asDot(write.connection.id, hive.recall({ query: input.subject })).pipe(
            Effect.flip,
          ),
        ).toMatchObject({ _tag: "DotIntegrationError" });
        yield* TestClock.adjust("2 days");
        expect(
          yield* asDot(readOnly.connection.id, hive.recall({ query: input.subject })).pipe(
            Effect.flip,
          ),
        ).toMatchObject({ _tag: "DotIntegrationError" });
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects empty grants and memory write without read", () =>
    Effect.gen(function* () {
      const connections = yield* DotConnections;
      for (const hiveMind of [undefined, { read: false, write: true }]) {
        const result = yield* connections
          .create({
            label: "Invalid",
            grants: [],
            expiresInDays: 1,
            ...(hiveMind ? { hiveMind } : {}),
          })
          .pipe(Effect.flip);
        expect(result._tag).toBe("DotIntegrationError");
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("bounds transcript content and retains explicit page metadata", () =>
    Effect.gen(function* () {
      yield* seed;
      const issued = yield* (yield* DotConnections).create(settings());
      const dot = yield* DotService;
      const id = ThreadId.make(`chat:${projectId}`);
      yield* dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("large-message"),
        threadId: id,
        messageId: MessageId.make("large"),
        delta: "x".repeat(12_000),
        createdAt: NOW,
      });
      const result = yield* asDot(issued.connection.id, dot.read({ projectId, threadId: id }));
      expect(result.contentTruncated).toBe(true);
      expect(result.messages[0]!.text.length).toBeLessThanOrEqual(4_000);
      expect(result.page).not.toBeNull();
      expect(isConnection(issued.connection)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );
});
