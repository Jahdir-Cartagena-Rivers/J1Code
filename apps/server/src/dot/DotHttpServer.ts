import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { DotConnections } from "./DotConnections.ts";
import { DotInvocation, DotService } from "./DotService.ts";
import { DotHiveMind, memoryScopeForTool } from "./DotHiveMind.ts";
import { DotToolkit, handlers } from "./tools.ts";
import { normalizeMcpHttpResponse } from "../mcp/McpHttpServer.ts";
import { DotOAuth, scopes } from "./DotOAuth.ts";
import packageJson from "../../package.json" with { type: "json" };

const decodeToolCall = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.Union([Schema.String, Schema.Number]),
    method: Schema.Literal("tools/call"),
    params: Schema.Struct({ name: Schema.String }),
  }),
);

const isToolListRequest = Schema.is(Schema.Struct({ method: Schema.Literal("tools/list") }));

const decodeToolList = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      jsonrpc: Schema.Literal("2.0"),
      id: Schema.Union([Schema.String, Schema.Number]),
      result: McpSchema.ListToolsResult,
    }),
  ),
);

// Effect exports Tool.Meta under _meta; ChatGPT also needs its top-level auth declaration.
const withToolSecuritySchemes = (response: HttpServerResponse.HttpServerResponse) => {
  if (response.body._tag !== "Uint8Array") return response;
  const list = decodeToolList(new TextDecoder().decode(response.body.body));
  if (Option.isNone(list)) return response;
  return HttpServerResponse.jsonUnsafe(
    {
      ...list.value,
      result: {
        ...list.value.result,
        tools: list.value.result.tools.map((tool) => ({
          ...tool,
          ...(tool._meta?.securitySchemes ? { securitySchemes: tool._meta.securitySchemes } : {}),
        })),
      },
    },
    { status: response.status, headers: response.headers },
  );
};

const auth = HttpRouter.middleware<{ provides: DotInvocation }>()(
  Effect.map(
    Effect.all({ connections: DotConnections, oauth: DotOAuth }),
    ({ connections, oauth }) =>
      (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const header = request.headers.authorization;
          const credential = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
          const principal = credential.startsWith("j1-dot-oauth-")
            ? yield* oauth.resolve(credential)
            : yield* connections
                .resolve(credential)
                .pipe(Effect.map(Option.map((connection) => ({ connection, scopes }))));
          const setup = yield* oauth.readSetup;
          if (Option.isNone(principal))
            return HttpServerResponse.jsonUnsafe(
              { error: "invalid_dot_credential" },
              {
                status: 401,
                headers: {
                  "www-authenticate": Option.isSome(setup)
                    ? `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource/dot/mcp", setup.value.resource)}", scope="${scopes.join(" ")}"`
                    : "Bearer",
                  "cache-control": "no-store",
                },
              },
            );
          // A cached ChatGPT connection must explicitly upgrade OAuth scopes for new tools.
          // The request body is cached by HttpServerRequest, so the MCP handler can read it again.
          let toolsListRequested = false;
          if (request.method === "POST") {
            const body = yield* request.json.pipe(Effect.option);
            toolsListRequested = Option.isSome(body) && isToolListRequest(body.value);
            const call = Option.flatMap(body, decodeToolCall);
            if (Option.isSome(call)) {
              const required = memoryScopeForTool(call.value.params.name);
              if (required && !principal.value.scopes.includes(required) && Option.isSome(setup)) {
                const requested = [...new Set([...principal.value.scopes, required])].join(" ");
                const challenge = `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource/dot/mcp", setup.value.resource)}", error="insufficient_scope", error_description="Reconnect J1 Code Dot to grant Hive Mind access", scope="${requested}"`;
                return HttpServerResponse.jsonUnsafe(
                  {
                    jsonrpc: "2.0",
                    id: call.value.id,
                    result: {
                      isError: true,
                      content: [
                        {
                          type: "text",
                          text: "Reconnect J1 Code Dot and choose a prepared Hive Mind connection.",
                        },
                      ],
                      _meta: { "mcp/www_authenticate": [challenge] },
                    },
                  },
                  { headers: { "cache-control": "no-store" } },
                );
              }
            }
          }
          return yield* httpEffect.pipe(
            Effect.provideService(DotInvocation, {
              connectionId: principal.value.connection.id,
              ...(principal.value.scopes ? { scopes: principal.value.scopes } : {}),
            }),
            Effect.map(normalizeMcpHttpResponse),
            Effect.map((response) =>
              toolsListRequested ? withToolSecuritySchemes(response) : response,
            ),
            Effect.map((response) =>
              HttpServerResponse.setHeader(response, "cache-control", "no-store"),
            ),
          );
        }).pipe(
          Effect.catchTag("DotIntegrationError", () =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe(
                { error: "dot_connection_unavailable" },
                { status: 503, headers: { "cache-control": "no-store" } },
              ),
            ),
          ),
          Effect.catchTag("DotOAuthError", () =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe(
                { error: "dot_connection_unavailable" },
                { status: 503, headers: { "cache-control": "no-store" } },
              ),
            ),
          ),
        ),
  ),
).layer;

/** Isolate tool discovery from provider-session /mcp while sharing the actual task service. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const dot = yield* DotService;
    const hiveMind = yield* DotHiveMind;
    const connections = yield* DotConnections;
    const oauth = yield* DotOAuth;
    return Layer.fresh(
      McpServer.toolkit(DotToolkit).pipe(
        Layer.provide(handlers),
        Layer.provideMerge(
          McpServer.layerHttp({
            name: "J1 Code Dot",
            version: packageJson.version,
            path: "/dot/mcp",
            protocols: [McpProtocol.v2025_06_18],
          }).pipe(Layer.provide(auth)),
        ),
        Layer.provide(Layer.succeed(DotService, dot)),
        Layer.provide(Layer.succeed(DotHiveMind, hiveMind)),
        Layer.provide(Layer.succeed(DotConnections, connections)),
        Layer.provide(Layer.succeed(DotOAuth, oauth)),
      ),
    );
  }),
);
