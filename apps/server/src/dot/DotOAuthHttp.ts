import {
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { DotConnections, connectionAllowsDotScope } from "./DotConnections.ts";
import { DotOAuth, DotOAuthError, scopes } from "./DotOAuth.ts";

const headers = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "same-origin",
  "content-security-policy":
    "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
};
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
const page = (content: string, status = 200, callbackOrigin?: string) =>
  HttpServerResponse.text(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Dot to J1 Code</title><body><main>${content}</main></body></html>`,
    {
      status,
      headers: {
        ...headers,
        // Chromium also checks the form's redirect target against form-action.
        ...(callbackOrigin
          ? {
              "content-security-policy": `default-src 'none'; form-action 'self' ${callbackOrigin}; frame-ancestors 'none'; base-uri 'none'`,
            }
          : {}),
      },
      contentType: "text/html; charset=utf-8",
    },
  );
const jsonError = (error: DotOAuthError) =>
  HttpServerResponse.jsonUnsafe(
    { error: error.error },
    {
      status:
        error.error === "temporarily_unavailable"
          ? 503
          : error.error === "invalid_client"
            ? 401
            : 400,
      headers,
    },
  );
const formField = Schema.String.check(Schema.isMaxLength(2048));
const Consent = Schema.Struct({
  request_id: formField,
  connection_id: Schema.optionalKey(formField),
  decision: Schema.Literals(["allow", "deny"]),
});
const Token = Schema.Struct({
  grant_type: Schema.Literals(["authorization_code", "refresh_token"]),
  client_id: formField,
  resource: formField,
  code: Schema.optionalKey(formField),
  redirect_uri: Schema.optionalKey(formField),
  code_verifier: Schema.optionalKey(formField),
  refresh_token: Schema.optionalKey(formField),
  scope: Schema.optionalKey(formField),
});
const decodeConsent = Schema.decodeUnknownEffect(Consent);
const decodeToken = Schema.decodeUnknownEffect(Token);
const body = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded")
    return yield* new DotOAuthError({ error: "invalid_request" });
  const text = yield* request.text.pipe(
    Effect.mapError(() => new DotOAuthError({ error: "invalid_request" })),
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)),
  );
  const params = new URLSearchParams(text);
  if ([...params.keys()].some((key) => params.getAll(key).length > 1))
    return yield* new DotOAuthError({ error: "invalid_request" });
  return Object.fromEntries(params);
});

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const oauth = yield* DotOAuth;
    const connections = yield* DotConnections;
    const auth = yield* EnvironmentAuth;
    const authenticated = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const session = yield* auth
        .authenticateHttpRequest(request)
        .pipe(Effect.mapError(() => new DotOAuthError({ error: "access_denied" })));
      if (!session.scopes.includes(AuthAccessWriteScope))
        return yield* new DotOAuthError({ error: "access_denied" });
      return session;
    });
    return Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/.well-known/oauth-protected-resource/dot/mcp",
        Effect.gen(function* () {
          const setup = yield* oauth.readSetup;
          return Option.isSome(setup)
            ? HttpServerResponse.jsonUnsafe(
                {
                  resource: setup.value.resource,
                  authorization_servers: [setup.value.issuer],
                  scopes_supported: scopes,
                  bearer_methods_supported: ["header"],
                },
                { headers },
              )
            : HttpServerResponse.empty({ status: 404, headers });
        }).pipe(Effect.catchTag("DotOAuthError", (error) => Effect.succeed(jsonError(error)))),
      ),
      HttpRouter.add(
        "GET",
        "/.well-known/oauth-authorization-server",
        Effect.gen(function* () {
          const setup = yield* oauth.readSetup;
          if (Option.isNone(setup)) return HttpServerResponse.empty({ status: 404, headers });
          return HttpServerResponse.jsonUnsafe(
            {
              issuer: setup.value.issuer,
              authorization_endpoint: `${setup.value.issuer}/oauth/dot/authorize`,
              token_endpoint: `${setup.value.issuer}/oauth/dot/token`,
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code", "refresh_token"],
              token_endpoint_auth_methods_supported: ["none"],
              code_challenge_methods_supported: ["S256"],
              authorization_response_iss_parameter_supported: true,
              scopes_supported: scopes,
            },
            { headers },
          );
        }).pipe(Effect.catchTag("DotOAuthError", (error) => Effect.succeed(jsonError(error)))),
      ),
      HttpRouter.add(
        "GET",
        "/oauth/dot/authorize",
        Effect.gen(function* () {
          const session = yield* authenticated;
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = new URL(request.url, "http://localhost");
          if ([...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length > 1))
            return yield* new DotOAuthError({ error: "invalid_request" });
          const begun = yield* oauth.begin(Object.fromEntries(url.searchParams), session.sessionId);
          const list = yield* connections.list.pipe(
            Effect.mapError(() => new DotOAuthError({ error: "temporarily_unavailable" })),
          );
          const timestamp = DateTime.toEpochMillis(yield* DateTime.now);
          const choices = list.filter(
            (connection) =>
              !connection.revokedAt &&
              Date.parse(connection.expiresAt) > timestamp &&
              scopes.some(
                (scope) =>
                  begun.request.scope.split(" ").includes(scope) &&
                  connectionAllowsDotScope(connection, scope),
              ) &&
              connection.grants.every(
                (grant) =>
                  (!grant.read || session.scopes.includes(AuthOrchestrationReadScope)) &&
                  (!grant.createTasks || session.scopes.includes(AuthOrchestrationOperateScope)),
              ),
          );
          const consentPage = page(
            `<h1>Connect your Dot to J1 Code</h1><p>Allow ${escape(begun.request.client_id)} to use a prepared connection on ${escape(begun.issuer)}.</p><p>Requested access: ${escape(begun.request.scope)}. Project grants, memory grants and expiry still apply. Hive Mind read spans all shared memories; write allows saving, correcting and forgetting shared facts. These permissions do not change ChatGPT memory. Your Dot stays in ChatGPT.</p><form method="post" action="/oauth/dot/authorize"><input type="hidden" name="request_id" value="${escape(begun.requestId)}"><label>Prepared connection <select name="connection_id">${choices.map((connection) => `<option value="${escape(connection.id)}">${escape(connection.label)} — ${escape([...connection.grants.map((grant) => `${grant.projectId}: ${grant.read ? "read chats" : ""}${grant.createTasks ? ` tasks (${grant.runtimeMode})` : ""}`), ...(connection.hiveMind?.read ? [`Hive Mind: read${connection.hiveMind.write ? ", write" : " only"}`] : [])].join("; "))}</option>`).join("")}</select></label><p><button name="decision" value="allow">Allow connection</button> <button name="decision" value="deny">Deny</button></p></form>`,
            200,
            new URL(begun.request.redirect_uri).origin,
          );
          return consentPage;
        }).pipe(
          Effect.catchTag("DotOAuthError", (error) =>
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const params = new URL(request.url, "http://localhost").searchParams;
              const setup = yield* oauth.readSetup.pipe(
                Effect.catchTag("DotOAuthError", () => Effect.succeedNone),
              );
              if (
                error.error !== "access_denied" &&
                Option.isSome(setup) &&
                ["client_id", "redirect_uri", "state"].every(
                  (key) => params.getAll(key).length === 1,
                ) &&
                params.get("client_id") === setup.value.clientId &&
                params.get("redirect_uri") === setup.value.redirectUri &&
                (params.get("state")?.length ?? 0) > 0 &&
                params.get("state")!.length <= 2048
              ) {
                const redirect = new URL(setup.value.redirectUri);
                redirect.searchParams.set("error", error.error);
                redirect.searchParams.set("state", params.get("state")!);
                redirect.searchParams.set("iss", setup.value.issuer);
                return HttpServerResponse.empty({
                  status: 303,
                  headers: { ...headers, location: redirect.toString() },
                });
              }
              return page(
                error.error === "access_denied"
                  ? '<h1>Sign in to J1 Code</h1><p>Open J1 on this origin and sign in with permission to manage connections, then retry the ChatGPT connection.</p><a href="/">Open J1 Code</a>'
                  : "<h1>Connection request unavailable</h1><p>Return to ChatGPT and retry. Check the configured client, callback and resource.</p>",
                error.error === "access_denied"
                  ? 401
                  : error.error === "temporarily_unavailable"
                    ? 503
                    : 400,
              );
            }),
          ),
        ),
      ),
      HttpRouter.add(
        "POST",
        "/oauth/dot/authorize",
        Effect.gen(function* () {
          const session = yield* authenticated;
          const request = yield* HttpServerRequest.HttpServerRequest;
          const setup = yield* oauth.readSetup;
          if (Option.isNone(setup) || request.headers.origin !== setup.value.issuer)
            return yield* new DotOAuthError({ error: "access_denied" });
          const input = yield* body.pipe(
            Effect.flatMap(decodeConsent),
            Effect.mapError(() => new DotOAuthError({ error: "invalid_request" })),
          );
          if (input.decision === "allow") {
            if (!input.connection_id) return yield* new DotOAuthError({ error: "invalid_request" });
            const connection = yield* connections
              .getActive(input.connection_id)
              .pipe(Effect.mapError(() => new DotOAuthError({ error: "access_denied" })));
            if (
              connection.grants.some(
                (grant) =>
                  (grant.read && !session.scopes.includes(AuthOrchestrationReadScope)) ||
                  (grant.createTasks && !session.scopes.includes(AuthOrchestrationOperateScope)),
              )
            )
              return yield* new DotOAuthError({ error: "access_denied" });
          }
          const location = yield* oauth.authorize(
            input.request_id,
            session.sessionId,
            input.decision === "allow" ? input.connection_id! : null,
          );
          return HttpServerResponse.empty({ status: 303, headers: { ...headers, location } });
        }).pipe(Effect.catchTag("DotOAuthError", (error) => Effect.succeed(jsonError(error)))),
      ),
      HttpRouter.add(
        "POST",
        "/oauth/dot/token",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.headers.authorization)
            return yield* new DotOAuthError({ error: "invalid_client" });
          const fields = yield* body;
          if ("client_secret" in fields || "client_assertion" in fields)
            return yield* new DotOAuthError({ error: "invalid_client" });
          const input = yield* decodeToken(fields).pipe(
            Effect.mapError(() => new DotOAuthError({ error: "invalid_request" })),
          );
          const result =
            input.grant_type === "authorization_code"
              ? yield* oauth.exchange({
                  code: input.code ?? "",
                  clientId: input.client_id,
                  redirectUri: input.redirect_uri ?? "",
                  resource: input.resource,
                  verifier: input.code_verifier ?? "",
                })
              : yield* oauth.refresh({
                  refreshToken: input.refresh_token ?? "",
                  clientId: input.client_id,
                  resource: input.resource,
                  ...(input.scope !== undefined ? { scope: input.scope } : {}),
                });
          return HttpServerResponse.jsonUnsafe(result, { headers });
        }).pipe(Effect.catchTag("DotOAuthError", (error) => Effect.succeed(jsonError(error)))),
      ),
    );
  }),
);
