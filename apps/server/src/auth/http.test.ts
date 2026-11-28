import * as NodeEffectCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Sign fixtures as an independent HTTP client.
import * as NodeCrypto from "node:crypto";
import {
  computeDpopAccessTokenHash,
  DPOP_MAX_CLOCK_SKEW_SECONDS,
  type DpopPublicJwk,
} from "@j1code/shared/dpop";
import {
  AuthTokenExchangeGrantType,
  AuthEnvironmentBootstrapTokenType,
  AuthAccessTokenType,
  AuthStandardClientScopes,
  EnvironmentHttpApi,
  ORCHESTRATION_PROTOCOL_HEADER,
} from "@j1code/contracts";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Tracer from "effect/Tracer";
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpMiddleware } from "effect/http";
import { layerOtlpSerialization, type TraceRecord } from "@j1code/shared/observability";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as BrowserTraceCollector from "../observability/BrowserTraceCollector.ts";
import * as ServerHttp from "../http.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { makeDpopKey } from "./dpop.testkit.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

interface OtlpFixture {
  readonly client: HttpClient.HttpClient;
  readonly collector: BrowserTraceCollector.BrowserTraceCollector["Service"];
  readonly tracer: Tracer.Tracer;
}

const makeLayerRoutes = (
  overrides: Partial<ServerConfig.ServerConfig["Service"]>,
  otlp?: OtlpFixture,
) => {
  const layerConfig = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return { ...config, ...overrides };
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

  const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerConfig),
  );
  const authRoutes = HttpApiBuilder.layer(AuthTestApi).pipe(
    Layer.provide(AuthHttp.layer),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
  );
  const otlpRoutes = otlp
    ? ServerHttp.layerOtlpTracesProxyRoute.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, otlp.client),
            Layer.succeed(BrowserTraceCollector.BrowserTraceCollector, otlp.collector),
            layerOtlpSerialization(overrides.otlpTracesExport?.protocol ?? "http/json"),
          ),
        ),
      )
    : Layer.empty;
  return Layer.mergeAll(authRoutes, otlpRoutes, ServerHttp.layerBrowserApiCors).pipe(
    Layer.provideMerge(layerEnvironmentAuth),
    Layer.provideMerge(layerConfig),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeEffectCrypto.layer)),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeEffectCrypto.layer)),
  );
};

const layerRoutes = makeLayerRoutes({
  mode: "web",
  devUrl: new URL("http://127.0.0.1:5173"),
  devAuthToken: Redacted.make(DEV_TOKEN),
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

const DESKTOP_FIXTURE_CREDENTIAL = "desktop-bootstrap-fixture";
const DESKTOP_LEGACY_SCOPES = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "relay:read",
  "access:read",
  "access:write",
  "relay:write",
];
const tokenExchange = (credential: string, scope?: string, origin?: string) =>
  new Request("http://127.0.0.1/oauth/token", {
    method: "POST",
    headers: { host: "127.0.0.1", ...(origin ? { origin } : {}) },
    body: new URLSearchParams({
      grant_type: AuthTokenExchangeGrantType,
      subject_token: credential,
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
      ...(scope === undefined ? {} : { scope }),
    }),
  });

const withSessionRoutes = (
  overrides: Partial<ServerConfig.ServerConfig["Service"]>,
  run: (request: (request: Request) => Promise<Response>) => Promise<void>,
  clock?: Clock.Clock,
  otlp?: OtlpFixture,
) =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    const routes = makeLayerRoutes(
      {
        devUrl: undefined,
        desktopBootstrapToken: DESKTOP_FIXTURE_CREDENTIAL,
        ...overrides,
      },
      otlp,
    );
    const configuredRoutes = otlp
      ? routes.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(Tracer.Tracer, otlp.tracer),
              // The in-process handler needs the same tracing predicate as the served app.
              Layer.effect(
                HttpMiddleware.TracerDisabledWhen,
                HttpMiddleware.TracerDisabledWhen,
              ).pipe(ServerHttp.withUntracedRequests),
            ),
          ),
        )
      : routes;
    // The web handler builds its own runtime. Share the fixture clock with layer
    // initialization (including the bootstrap grant) and request execution.
    const runtimeRoutes = clock
      ? configuredRoutes.pipe(Layer.provideMerge(Layer.succeed(Clock.Clock, clock)))
      : configuredRoutes;
    yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(runtimeRoutes, { disableLogger: true })),
      (app) => Effect.promise(() => run((request) => app.handler(request, requestContext))),
      (app) => Effect.promise(() => app.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeEffectCrypto.layer)));

const sessionRequest = (headers: RequestInit["headers"] = {}) =>
  new Request("http://127.0.0.1/api/auth/session", { headers });

it.effect("records and forwards only authorized browser OTLP exports", () =>
  Effect.gen(function* () {
    const path = "/api/observability/v1/traces";
    const collectorUrl = "http://collector.test/v1/traces";
    const origin = "http://127.0.0.1";
    const span = {
      name: "client.otlp.test",
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      kind: 3,
      startTimeUnixNano: "1000000",
      endTimeUnixNano: "2000000",
      attributes: [{ key: "rpc.method", value: { stringValue: "server.getSettings" } }],
      droppedAttributesCount: 0,
      events: [],
      droppedEventsCount: 0,
      links: [],
      droppedLinksCount: 0,
      status: { code: 1 },
    };
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "t3code-web" } }],
            droppedAttributesCount: 0,
          },
          scopeSpans: [{ scope: { name: "effect" }, spans: [span] }],
        },
      ],
    };
    for (const protocol of ["http/json", "http/protobuf", undefined] as const) {
      const records: TraceRecord[] = [];
      const forwards: HttpClientRequest.HttpClientRequest[] = [];
      const spans: string[] = [];
      const exportConfig =
        protocol === undefined
          ? {}
          : {
              otlpTracesUrl: collectorUrl,
              otlpTracesExport: {
                protocol,
                headers: { "x-collector-key": "configured-fixture" },
                exportIntervalMs: 10_000,
              },
            };
      yield* withSessionRoutes(
        { mode: "desktop", ...exportConfig },
        async (request) => {
          const bootstrap = await request(
            postJson("/api/auth/browser-session", { credential: DESKTOP_FIXTURE_CREDENTIAL }),
          );
          expect(bootstrap.status).toBe(200);
          const cookie = bootstrap.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";
          expect(cookie).not.toBe("");
          const pairing = await request(
            postJson("/api/auth/pairing-token", { scopes: ["orchestration:read"] }, { cookie }),
          );
          expect(pairing.status).toBe(200);
          const { credential } = (await pairing.json()) as { credential: string };
          const exchange = await request(tokenExchange(credential, "orchestration:read"));
          expect(exchange.status).toBe(200);
          const { access_token } = (await exchange.json()) as { access_token: string };

          const preflight = await request(
            new Request(origin + path, {
              method: "OPTIONS",
              headers: {
                origin,
                "access-control-request-method": "POST",
                "access-control-request-headers": "content-type",
              },
            }),
          );
          expect(preflight.status).toBe(204);
          expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
          expect(preflight.headers.get("access-control-allow-headers")).toContain("content-type");

          const anonymous = await request(postJson(path, payload));
          expect(anonymous.status).toBe(401);
          expect(await anonymous.json()).toMatchObject({ code: "auth_invalid" });
          const crossOrigin = await request(
            postJson(path, payload, { cookie, origin: "http://127.0.0.1:9876" }),
          );
          expect(crossOrigin.status).toBe(401);
          expect(await crossOrigin.json()).toMatchObject({ code: "auth_invalid" });
          const readOnly = await request(
            postJson(path, payload, { authorization: `Bearer ${access_token}` }),
          );
          expect(readOnly.status).toBe(403);
          expect(await readOnly.json()).toMatchObject({
            code: "insufficient_scope",
            requiredScope: "orchestration:operate",
          });
          expect(records).toEqual([]);
          expect(forwards).toEqual([]);

          spans.length = 0;
          const response = await request(
            postJson(`${path}?collector=https://ignored.example/v1/traces`, payload, {
              cookie,
              origin,
              "x-collector-key": "browser-fixture",
            }),
          );
          expect(response.status).toBe(204);
          expect(response.headers.get("access-control-allow-origin")).toBe("*");
          expect(records).toMatchObject([
            {
              type: "otlp-span",
              name: span.name,
              traceId: span.traceId,
              spanId: span.spanId,
              kind: "client",
              durationMs: 1,
              attributes: { "rpc.method": "server.getSettings" },
              resourceAttributes: { "service.name": "t3code-web" },
              scope: { name: "effect" },
            },
          ]);
          expect(spans).toEqual([]);
          expect((await request(sessionRequest({ cookie }))).status).toBe(200);
          expect(spans).toContain("GET");

          if (protocol === undefined) {
            expect(forwards).toEqual([]);
            return;
          }
          expect(forwards).toHaveLength(1);
          const forwarded = forwards[0];
          if (!forwarded) throw new Error("Expected a forwarded trace request");
          expect(forwarded.method).toBe("POST");
          expect(forwarded.url).toBe(collectorUrl);
          expect(forwarded.headers["x-collector-key"]).toBe("configured-fixture");
          expect(forwarded.headers.cookie).toBeUndefined();
          expect(forwarded.headers.authorization).toBeUndefined();
          if (forwarded.body._tag !== "Uint8Array") throw new Error("Expected serialized traces");
          expect(forwarded.body.contentType).toBe(
            protocol === "http/json" ? "application/json" : "application/x-protobuf",
          );
          const body = new TextDecoder().decode(forwarded.body.body);
          if (protocol === "http/json") {
            expect(body).toBe(encodeJson(payload));
          } else {
            expect(body).toContain(span.name);
            expect(body.startsWith("{")).toBe(false);
          }
        },
        undefined,
        {
          client: HttpClient.make((request) =>
            Effect.sync(() => {
              forwards.push(request);
              return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
            }),
          ),
          collector: {
            record: (batch) =>
              Effect.sync(() => {
                records.push(...batch);
              }),
          },
          tracer: Tracer.make({
            span: (options) => {
              spans.push(options.name);
              return new Tracer.NativeSpan(options);
            },
          }),
        },
      );
    }
  }),
);

// Session inventory is now an RPC stream. Use the signed fixture's session ID
// to exercise the HTTP revoke endpoint without opening an RPC transport.
const decodeFixtureClaims = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ sid: Schema.String })),
);
const fixtureSessionId = (token: string) =>
  decodeFixtureClaims(Buffer.from(token.split(".", 1)[0] ?? "", "base64url").toString()).sid;

const ticketUrl = "http://127.0.0.1/api/auth/websocket-ticket";
const ticketRequest = (origin: string, authorization?: string) =>
  new Request(ticketUrl, {
    method: "POST",
    headers: { origin, ...(authorization ? { authorization } : {}) },
  });
const ticketPreflight = (origin: string) =>
  new Request(ticketUrl, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": `authorization, dpop, ${ORCHESTRATION_PROTOCOL_HEADER}`,
    },
  });

it.effect(
  "carries remote CORS through bearer exchange, session state and short-lived tickets",
  () =>
    Effect.gen(function* () {
      const issuedAt = Date.parse("2026-01-01T00:00:00.000Z");
      yield* TestClock.setTime(issuedAt);
      const clock = yield* Clock.Clock;
      yield* withSessionRoutes(
        { mode: "desktop" },
        async (request) => {
          const origin = "https://remote-client.example.test";
          const expectCors = (response: Response, status: number) => {
            expect(response.status).toBe(status);
            expect(response.headers.get("access-control-allow-origin")).toBe("*");
            expect(response.headers.get("access-control-allow-credentials")).toBeNull();
          };
          const preflight = await request(ticketPreflight(origin));
          expectCors(preflight, 204);
          const splitHeader = (name: string) =>
            (preflight.headers.get(name) ?? "").split(",").map((part) => part.trim().toLowerCase());
          expect(splitHeader("access-control-allow-headers")).toEqual(
            expect.arrayContaining([
              "authorization",
              "dpop",
              ORCHESTRATION_PROTOCOL_HEADER.toLowerCase(),
            ]),
          );
          expect(splitHeader("access-control-allow-methods").sort()).toEqual([
            "get",
            "options",
            "post",
          ]);

          const denied = await request(ticketRequest(origin));
          expectCors(denied, 401);
          expect(await denied.json()).toMatchObject({ code: "auth_invalid" });

          const exchange = await request(
            tokenExchange(DESKTOP_FIXTURE_CREDENTIAL, undefined, origin),
          );
          expectCors(exchange, 200);
          const bearer = (await exchange.json()) as { access_token: string };
          expect(bearer).toMatchObject({ token_type: "Bearer", access_token: expect.any(String) });
          const authorization = `Bearer ${bearer.access_token}`;
          const session = await request(sessionRequest({ origin, authorization }));
          expectCors(session, 200);
          expect(await session.json()).toMatchObject({
            authenticated: true,
            sessionMethod: "bearer-access-token",
          });

          const ticket = await request(ticketRequest(origin, authorization));
          expectCors(ticket, 200);
          expect(ticket.headers.get("cache-control")).toBe("no-store");
          const issued = (await ticket.json()) as { ticket: string; expiresAt: string };
          expect(issued.ticket).toMatch(/\S/);
          expect(Date.parse(issued.expiresAt)).toBe(issuedAt + 300_000);
        },
        clock,
      );
    }),
);

it.effect("allows credentialed dev and desktop preflights only for configured origins", () =>
  withSessionRoutes(
    {
      devUrl: new URL("http://127.0.0.1:5173"),
      devAllowedOrigins: ["https://tailnet.example.test"],
    },
    async (request) => {
      for (const origin of [
        "http://127.0.0.1:5173",
        "https://tailnet.example.test",
        "t3code://app",
        "t3code-dev://app",
      ]) {
        const response = await request(ticketPreflight(origin));
        expect(response.status).toBe(204);
        expect(response.headers.get("access-control-allow-origin")).toBe(origin);
        expect(response.headers.get("access-control-allow-credentials")).toBe("true");
      }
      const refused = await request(ticketPreflight("https://other-client.example.test"));
      expect(refused.headers.get("access-control-allow-origin")).toBeNull();
    },
  ),
);

it.effect("validates pairing scope grants and issues labeled one-time browser credentials", () =>
  withSessionRoutes({ mode: "desktop", host: "0.0.0.0" }, async (request) => {
    const endpoint = "/api/auth/pairing-token";
    const anonymous = await request(postJson(endpoint, {}));
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ code: "auth_invalid" });

    const exchanged = await request(tokenExchange(DESKTOP_FIXTURE_CREDENTIAL));
    expect(exchanged.status).toBe(200);
    const owner = (await exchanged.json()) as { access_token: string };
    const headers = { authorization: `Bearer ${owner.access_token}` };

    for (const scopes of [[], ["orchestration:read", "orchestration:read"]]) {
      const invalid = await request(postJson(endpoint, { scopes }, headers));
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({
        code: "invalid_request",
        reason: "invalid_scope",
      });
    }

    const created = await request(
      postJson(endpoint, { label: "Hosted web", scopes: ["orchestration:read"] }, headers),
    );
    expect(created.status).toBe(200);
    const pairing = (await created.json()) as { credential: string; expiresAt: string };
    expect(pairing).toMatchObject({ label: "Hosted web", credential: expect.stringMatching(/\S/) });
    expect(Number.isFinite(Date.parse(pairing.expiresAt))).toBe(true);

    const browser = () =>
      request(
        postJson("/api/auth/browser-session", {
          credential: pairing.credential,
        }),
      );
    const accepted = await browser();
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      authenticated: true,
      sessionMethod: "browser-session-cookie",
      scopes: ["orchestration:read"],
    });
    const replayed = await browser();
    expect(replayed.status).toBe(401);
    expect(await replayed.json()).toMatchObject({ code: "auth_invalid" });
    expect(replayed.headers.getSetCookie()).toEqual([]);

    const cookie = accepted.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";
    const paired = await request(postJson(endpoint, {}, { cookie }));
    expect(paired.status).toBe(403);
    expect(await paired.json()).toMatchObject({
      _tag: "EnvironmentScopeRequiredError",
      code: "insufficient_scope",
      requiredScope: "access:write",
      traceId: expect.stringMatching(/\S/),
    });
  }),
);

it.effect(
  "reports desktop session policy and keeps cookie auth healthy across bearer rotation",
  () =>
    withSessionRoutes({ mode: "desktop" }, async (request) => {
      const anonymous = await request(sessionRequest());
      expect(anonymous.status).toBe(200);
      expect(await anonymous.json()).toMatchObject({
        authenticated: false,
        auth: {
          policy: "desktop-managed-local",
          bootstrapMethods: ["desktop-bootstrap"],
          sessionMethods: ["browser-session-cookie", "bearer-access-token", "dpop-access-token"],
          sessionCookieName: expect.stringMatching(/^t3_session_\d+$/),
        },
      });

      const openBrowser = (headers?: Readonly<Record<string, string>>) =>
        request(
          postJson(
            "/api/auth/browser-session",
            { credential: DESKTOP_FIXTURE_CREDENTIAL },
            headers,
          ),
        );
      const bootstrap = await openBrowser();
      expect(bootstrap.status).toBe(200);
      const bootstrapBody = await bootstrap.json();
      expect(bootstrapBody).toMatchObject({
        authenticated: true,
        sessionMethod: "browser-session-cookie",
        scopes: DESKTOP_LEGACY_SCOPES,
        permissions: AuthStandardClientScopes,
      });
      expect(bootstrapBody).not.toHaveProperty("sessionToken");
      const cookie = bootstrap.headers.getSetCookie()[0];
      expect(cookie).toMatch(/^t3_session_\d+=.+;.*HttpOnly/i);
      const retiredBrowserHeaders = { cookie: cookie?.split(";", 1)[0] ?? "" };
      const renewed = await openBrowser(retiredBrowserHeaders);
      expect(renewed.status).toBe(200);
      const renewedCookie = renewed.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";
      expect(renewedCookie).toMatch(/^t3_session_\d+=.+/);
      expect(renewedCookie).not.toBe(retiredBrowserHeaders.cookie);
      const retiredBrowser = await request(sessionRequest(retiredBrowserHeaders));
      expect(retiredBrowser.status).toBe(200);
      expect(await retiredBrowser.json()).toMatchObject({ authenticated: false });
      const browserHeaders = { cookie: renewedCookie };

      const exchange = async () => {
        const result = await request(tokenExchange(DESKTOP_FIXTURE_CREDENTIAL));
        expect(result.status).toBe(200);
        expect(result.headers.get("cache-control")).toBe("no-store");
        const body = (await result.json()) as { access_token: string };
        expect(body).toMatchObject({
          access_token: expect.any(String),
          issued_token_type: AuthAccessTokenType,
          token_type: "Bearer",
          scope: AuthStandardClientScopes.join(" "),
        });
        return { authorization: `Bearer ${body.access_token}` };
      };
      const first = await exchange();
      const second = await exchange();
      const current = await exchange();
      for (const retired of [first, second]) {
        const state = await request(sessionRequest(retired));
        expect(state.status).toBe(200);
        expect(await state.json()).toMatchObject({ authenticated: false });
      }
      const bearer = await request(sessionRequest(current));
      expect(bearer.status).toBe(200);
      expect(await bearer.json()).toMatchObject({
        authenticated: true,
        sessionMethod: "bearer-access-token",
        scopes: DESKTOP_LEGACY_SCOPES,
        permissions: AuthStandardClientScopes,
      });
      const browser = await request(sessionRequest(browserHeaders));
      expect(browser.status).toBe(200);
      expect(await browser.json()).toMatchObject({
        authenticated: true,
        sessionMethod: "browser-session-cookie",
      });
    }),
);

it.effect("migrates only valid legacy cookies and revokes scoped paired sessions", () =>
  withSessionRoutes({ mode: "web", host: "192.168.1.50" }, async (request) => {
    const bootstrap = await request(
      postJson("/api/auth/browser-session", { credential: DESKTOP_FIXTURE_CREDENTIAL }),
    );
    expect(bootstrap.status).toBe(200);
    const setCookies = bootstrap.headers.getSetCookie();
    expect(setCookies).toHaveLength(1);
    const setCookie = setCookies[0] ?? "";
    expect(setCookie).toMatch(/^t3_session_[a-f0-9]{12}=/);
    const ownerCookie = setCookie.split(";", 1)[0] ?? "";
    const owner = { cookie: ownerCookie };
    const legacyCookie = ownerCookie.replace(/^t3_session_[^=]+=/, "t3_session=");
    const migrated = await request(sessionRequest({ cookie: legacyCookie }));
    expect(migrated.status).toBe(200);
    expect(await migrated.json()).toMatchObject({
      authenticated: true,
      sessionMethod: "browser-session-cookie",
    });
    expect(migrated.headers.getSetCookie()).toEqual([setCookie]);
    expect(migrated.headers.get("cache-control")).toBe("no-store");

    const staleCookie = "t3_session=invalid-fixture-cookie";
    const invalid = await request(sessionRequest({ cookie: staleCookie }));
    expect(invalid.status).toBe(200);
    expect(await invalid.json()).toMatchObject({ authenticated: false });
    expect(invalid.headers.getSetCookie()).toEqual([]);
    const current = await request(sessionRequest({ cookie: `${ownerCookie}; ${staleCookie}` }));
    expect(await current.json()).toMatchObject({ authenticated: true });
    expect(current.headers.getSetCookie()).toEqual([]);

    const pairReadOnly = async () => {
      const pairing = await request(
        postJson("/api/auth/pairing-token", { scopes: ["orchestration:read"] }, owner),
      );
      expect(pairing.status).toBe(200);
      const { credential } = (await pairing.json()) as { credential: string };
      return credential;
    };
    const credential = await pairReadOnly();
    const unauthorizedScope = await request(tokenExchange(credential, "access:write"));
    expect(unauthorizedScope.status).toBe(400);
    expect(await unauthorizedScope.json()).toMatchObject({ reason: "scope_not_granted" });

    const exchange = await request(tokenExchange(credential, "orchestration:read"));
    expect(exchange.status).toBe(200);
    const issued = (await exchange.json()) as { access_token: string };
    expect(issued).toMatchObject({
      issued_token_type: AuthAccessTokenType,
      token_type: "Bearer",
      scope: "orchestration:read",
    });
    const replayed = await request(tokenExchange(credential, "orchestration:read"));
    expect(replayed.status).toBe(401);
    expect(await replayed.json()).toMatchObject({ code: "auth_invalid" });

    const paired = { authorization: `Bearer ${issued.access_token}`, cookie: staleCookie };
    const active = await request(sessionRequest(paired));
    expect(active.status).toBe(200);
    expect(await active.json()).toMatchObject({
      authenticated: true,
      sessionMethod: "bearer-access-token",
      scopes: ["orchestration:read"],
    });
    expect(active.headers.getSetCookie()).toEqual([]);
    const workspace = await request(postJson("/api/auth/workspace-credential", {}, paired));
    expect(workspace.status).toBe(200);
    expect(await workspace.json()).toMatchObject({ scopes: ["orchestration:read"] });

    const sessionId = fixtureSessionId(issued.access_token);
    const revokePath = "/api/auth/clients/revoke";
    const forbidden = await request(postJson(revokePath, { sessionId }, paired));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      code: "insufficient_scope",
      requiredScope: "access:write",
    });
    const revoked = await request(postJson(revokePath, { sessionId }, owner));
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: true });
    const denied = await request(postJson("/api/auth/workspace-credential", {}, paired));
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ code: "auth_invalid" });
    const revokedState = await request(sessionRequest(paired));
    expect(await revokedState.json()).toMatchObject({ authenticated: false });

    const browserPair = await request(
      postJson("/api/auth/browser-session", { credential: await pairReadOnly() }),
    );
    expect(browserPair.status).toBe(200);
    expect(await browserPair.json()).toMatchObject({
      authenticated: true,
      sessionMethod: "browser-session-cookie",
      scopes: ["orchestration:read"],
    });
    const browserCookie = browserPair.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";
    const browserHeaders = { cookie: browserCookie };
    const browserToken = browserCookie.slice(browserCookie.indexOf("=") + 1);
    const revokeBrowser = await request(
      postJson(revokePath, { sessionId: fixtureSessionId(browserToken) }, owner),
    );
    expect(revokeBrowser.status).toBe(200);
    expect(await revokeBrowser.json()).toEqual({ revoked: true });
    const rejectedBrowser = await request(postJson("/api/auth/pairing-token", {}, browserHeaders));
    expect(rejectedBrowser.status).toBe(401);
    expect(await rejectedBrowser.json()).toMatchObject({ code: "auth_invalid" });

    const ownerStillActive = await request(sessionRequest(owner));
    expect(await ownerStillActive.json()).toMatchObject({
      authenticated: true,
      sessionMethod: "browser-session-cookie",
    });
  }),
);

function nativeProof(
  privateKey: NodeCrypto.KeyObject,
  publicJwk: DpopPublicJwk,
  path: string,
  iat: number,
  accessToken?: string,
) {
  const header = Buffer.from(
    JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      htm: "POST",
      htu: `http://127.0.0.1${path}`,
      iat,
      jti: NodeCrypto.randomUUID(),
      ...(accessToken ? { ath: computeDpopAccessTokenHash(accessToken) } : {}),
    }),
  ).toString("base64url");
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

it.effect("sets the selected browser session cookies through the HTTP route", () =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
          ] as const,
      ),
      ([environmentA, environmentB]) =>
        Effect.promise(async () => {
          const devResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          expect(devResponse.status).toBe(200);
          const devBody = (await devResponse.json()) as { expiresAt: string };
          const retiredScopeResponse = await environmentA.handler(
            new Request("http://127.0.0.1/oauth/token", {
              method: "POST",
              body: new URLSearchParams({
                grant_type: AuthTokenExchangeGrantType,
                subject_token: DEV_TOKEN,
                subject_token_type: AuthEnvironmentBootstrapTokenType,
                requested_token_type: AuthAccessTokenType,
                scope: "review:write",
              }),
            }),
            requestContext,
          );
          expect(retiredScopeResponse.status).toBe(400);
          expect(await retiredScopeResponse.json()).toMatchObject({ reason: "invalid_scope" });

          // A supported neighbor must not make an unknown scope disappear.
          const mixedScopeResponse = await environmentA.handler(
            new Request("http://127.0.0.1/oauth/token", {
              method: "POST",
              body: new URLSearchParams({
                grant_type: AuthTokenExchangeGrantType,
                subject_token: DEV_TOKEN,
                subject_token_type: AuthEnvironmentBootstrapTokenType,
                requested_token_type: AuthAccessTokenType,
                scope: "orchestration:read review:write",
              }),
            }),
            requestContext,
          );
          expect(mixedScopeResponse.status).toBe(400);
          expect(await mixedScopeResponse.json()).toMatchObject({ reason: "invalid_scope" });

          const devCookies = devResponse.headers.getSetCookie();
          const devCookie = devCookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
          expect(devCookie).toContain("HttpOnly");
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookies).toContainEqual(
            expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
          );
          expect(devCookies.filter((cookie) => /;\s*Secure/i.test(cookie))).toEqual([]);
          const httpsResponse = await environmentA.handler(
            postJson(
              "/api/auth/browser-session",
              { credential: DEV_TOKEN },
              { "x-forwarded-proto": "https" },
            ),
            requestContext,
          );
          const httpsCookies = httpsResponse.headers.getSetCookie();
          expect(httpsCookies).toHaveLength(2);
          for (const cookie of httpsCookies) expect(cookie).toMatch(/;\s*Secure/i);
          const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
          const environmentBSession = await environmentB.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: devCookieHeader },
            }),
            requestContext,
          );
          expect(environmentBSession.status).toBe(200);
          expect(await environmentBSession.json()).toMatchObject({ authenticated: true });

          const pairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(pairingResponse.status).toBe(200);
          const pairing = (await pairingResponse.json()) as { credential: string };
          const restrictedResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }),
            requestContext,
          );
          expect(restrictedResponse.status).toBe(200);
          const restrictedCookies = restrictedResponse.headers.getSetCookie();
          expect(restrictedCookies).toHaveLength(1);
          expect(restrictedCookies[0]).toMatch(/^t3_session_/);
          expect(restrictedCookies[0]).not.toContain("t3_dev_session_");
          const restrictedCookie = restrictedCookies[0]?.split(";", 1)[0] ?? "";
          const unauthenticated = await environmentA.handler(
            postJson("/api/auth/workspace-credential", {}),
            requestContext,
          );
          expect(unauthenticated.status).toBe(401);
          const handoffResponse = await environmentA.handler(
            postJson("/api/auth/workspace-credential", {}, { cookie: restrictedCookie }),
            requestContext,
          );
          expect(handoffResponse.status).toBe(200);
          expect(handoffResponse.headers.get("cache-control")).toBe("no-store");
          const handoff = (await handoffResponse.json()) as { credential: string };
          const wrongEnvironment = await environmentB.handler(
            postJson("/api/auth/workspace-session", handoff),
            requestContext,
          );
          expect(wrongEnvironment.status).toBe(401);
          const workspaceResponse = await environmentA.handler(
            postJson("/api/auth/workspace-session", handoff),
            requestContext,
          );
          expect(workspaceResponse.status).toBe(200);
          expect(await workspaceResponse.json()).toMatchObject({
            authenticated: true,
            scopes: ["orchestration:read"],
          });
          expect(workspaceResponse.headers.getSetCookie()[0]).toContain("HttpOnly");
          const replay = await environmentA.handler(
            postJson("/api/auth/workspace-session", handoff),
            requestContext,
          );
          expect(replay.status).toBe(401);

          const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
            namedCurve: "P-256",
          });
          const publicJwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
          const iat = Math.floor((Date.parse(devBody.expiresAt) - 30 * 86_400_000) / 1000);
          const nativePairResponse = await environmentA.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          const nativePair = (await nativePairResponse.json()) as { credential: string };
          const nativeTokenResponse = await environmentA.handler(
            new Request("http://127.0.0.1/oauth/token", {
              method: "POST",
              headers: {
                host: "127.0.0.1",
                "content-type": "application/x-www-form-urlencoded",
                dpop: nativeProof(privateKey, publicJwk, "/oauth/token", iat),
              },
              body: new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
                subject_token: nativePair.credential,
                subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
                requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
              }),
            }),
            requestContext,
          );
          const nativeTokenPayload: unknown = await nativeTokenResponse.json();
          expect({
            status: nativeTokenResponse.status,
            ...(nativeTokenResponse.status === 200 ? {} : { error: nativeTokenPayload }),
          }).toEqual({ status: 200 });
          const nativeToken = nativeTokenPayload as { access_token: string };
          for (const scheme of ["Bearer", "DPoP"]) {
            const rejected = await environmentA.handler(
              postJson(
                "/api/auth/workspace-credential",
                {},
                { authorization: `${scheme} ${nativeToken.access_token}` },
              ),
              requestContext,
            );
            expect(rejected.status).toBe(401);
          }
          const proof = nativeProof(
            privateKey,
            publicJwk,
            "/api/auth/workspace-credential",
            iat,
            nativeToken.access_token,
          );
          const nativeHeaders = { authorization: `DPoP ${nativeToken.access_token}`, dpop: proof };
          const nativeHandoff = await environmentA.handler(
            postJson("/api/auth/workspace-credential", {}, nativeHeaders),
            requestContext,
          );
          expect(nativeHandoff.status).toBe(200);
          expect(await nativeHandoff.json()).toMatchObject({ scopes: ["orchestration:read"] });
          const replayedProof = await environmentA.handler(
            postJson("/api/auth/workspace-credential", {}, nativeHeaders),
            requestContext,
          );
          expect(replayedProof.status).toBe(401);
          expect(replayedProof.headers.get("www-authenticate")).toBe("DPoP");
          expect(await replayedProof.json()).toMatchObject({
            code: "auth_invalid",
            reason: "invalid_credential",
            dpopFailureReason: "replay",
          });
        }),
      ([environmentA, environmentB]) =>
        Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeEffectCrypto.layer))),
);

it.effect.each(["DPoP", "dpop"])("challenges a refused %s request with DPoP", (scheme) =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.promise(async () => {
          const refused = await environment.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { authorization: `${scheme} not-a-valid-token` },
            ),
            requestContext,
          );
          expect(refused.status).toBe(401);
          expect(refused.headers.get("www-authenticate")).toBe("DPoP");
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeEffectCrypto.layer))),
);

// The web handler runs on its own runtime, so proofs need wall-clock time.
it.live("checks token-endpoint DPoP proofs without writing replay state", () =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const written: Array<string> = [];
    const recordingSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: (name) => Effect.sync(() => void written.push(name)),
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, recordingSecretStore),
    );
    const url = "http://127.0.0.1/oauth/token";
    const key = makeDpopKey();
    const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
    const tokenRequest = (subjectToken: string, proof: string, forwardedHost?: string) =>
      new Request(url, {
        method: "POST",
        headers: {
          host: "127.0.0.1",
          dpop: proof,
          ...(forwardedHost ? { "x-forwarded-host": forwardedHost } : {}),
        },
        body: new URLSearchParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: subjectToken,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
        }),
      });
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.promise(async () => {
          const unknownToken = await environment.handler(
            tokenRequest("not-a-pairing-token", key.sign({ method: "POST", url, token: "", iat })),
            requestContext,
          );
          expect(unknownToken.status).toBe(401);
          expect(await unknownToken.json()).not.toHaveProperty("dpopFailureReason");

          const expectDpopRejection = async (response: Response, dpopFailureReason: string) => {
            expect(response.status).toBe(401);
            expect(response.headers.get("www-authenticate")).toBe("DPoP");
            expect(await response.json()).toMatchObject({
              _tag: "EnvironmentAuthInvalidError",
              code: "auth_invalid",
              reason: "invalid_credential",
              dpopFailureReason,
              traceId: expect.stringMatching(/\S/),
            });
          };
          const forwardedHost = "forwarded.example.test";
          const proofInput = { method: "POST", url, token: "", iat };
          const outOfWindow = DPOP_MAX_CLOCK_SKEW_SECONDS + 60;
          const rejectedProofs = [
            { input: { ...proofInput, iat: iat + outOfWindow }, reason: "time_window" },
            { input: { ...proofInput, iat: iat - outOfWindow }, reason: "time_window" },
            { input: { ...proofInput, method: "GET" }, reason: "request_mismatch" },
            {
              input: { ...proofInput, url: `http://${forwardedHost}/oauth/token` },
              reason: "request_mismatch",
            },
          ];
          for (const { input, reason } of rejectedProofs) {
            const rejected = await environment.handler(
              tokenRequest(DEV_TOKEN, key.sign(input), forwardedHost),
              requestContext,
            );
            await expectDpopRejection(rejected, reason);
          }
          await expectDpopRejection(
            await environment.handler(tokenRequest(DEV_TOKEN, "not-a-proof"), requestContext),
            "invalid_proof",
          );

          // A valid proof binds to the request host even when a forwarded host is present.
          const proof = key.sign(proofInput);
          const accepted = await environment.handler(
            tokenRequest(DEV_TOKEN, proof, forwardedHost),
            requestContext,
          );
          expect(accepted.status).toBe(200);
          expect(accepted.headers.get("cache-control")).toBe("no-store");
          const issued = (await accepted.json()) as { access_token: string };
          expect(issued).toMatchObject({ token_type: "DPoP", access_token: expect.any(String) });

          // The fixture credential is reusable. Token exchange validates proofs without
          // consuming their identifiers. Protected resources apply their own replay rules.
          const repeated = await environment.handler(
            tokenRequest(DEV_TOKEN, proof, forwardedHost),
            requestContext,
          );
          expect(repeated.status).toBe(200);
          expect(written).toEqual([]);

          const workspacePath = "/api/auth/workspace-credential";
          const workspaceInput = {
            method: "POST",
            url: `http://127.0.0.1${workspacePath}`,
            token: issued.access_token,
            iat,
          };
          for (const [proof, reason] of [
            [makeDpopKey().sign(workspaceInput), "key_mismatch"],
            [key.sign({ ...workspaceInput, token: "different-fixture-token" }), "token_mismatch"],
          ] as const) {
            const rejected = await environment.handler(
              postJson(
                workspacePath,
                {},
                {
                  authorization: `DPoP ${issued.access_token}`,
                  dpop: proof,
                },
              ),
              requestContext,
            );
            await expectDpopRejection(rejected, reason);
          }

          const session = await environment.handler(
            sessionRequest({
              host: "127.0.0.1",
              authorization: `DPoP ${issued.access_token}`,
              dpop: key.sign({
                method: "GET",
                url: "http://127.0.0.1/api/auth/session",
                token: issued.access_token,
                iat,
              }),
            }),
            requestContext,
          );
          expect(session.status).toBe(200);
          expect(await session.json()).toMatchObject({
            authenticated: true,
            sessionMethod: "dpop-access-token",
          });
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeEffectCrypto.layer))),
);
