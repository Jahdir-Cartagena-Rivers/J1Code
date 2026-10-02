import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { CommandId, ProjectId } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vite-plus/test";
import { ServerConfig } from "../config.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { DotConnections, layer as connectionsLayer } from "./DotConnections.ts";
import { DotOAuth, layer as oauthLayer } from "./DotOAuth.ts";

const NOW = "2026-10-02T12:00:00.000Z";
const projectId = ProjectId.make("oauth-project");
const setup = {
  issuer: "https://auth.example.test",
  resource: "https://mcp.example.test/dot/mcp",
  clientId: "j1-chatgpt-dot",
  redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
};
const session = "j1-session-1";
const verifier = "v".repeat(43) + "-verifier_0123456789";
const challenge = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
const authorization = (overrides: Record<string, unknown> = {}) => ({
  response_type: "code",
  client_id: setup.clientId,
  redirect_uri: setup.redirectUri,
  resource: setup.resource,
  scope: "dot:read dot:tasks",
  state: "opaque-state",
  code_challenge: challenge,
  code_challenge_method: "S256",
  ...overrides,
});
const exchangeInput = (code: string, overrides: Record<string, string> = {}) => ({
  code,
  clientId: setup.clientId,
  redirectUri: setup.redirectUri,
  resource: setup.resource,
  verifier,
  ...overrides,
});

const testLayer = Layer.fresh(oauthLayer).pipe(
  Layer.provideMerge(connectionsLayer),
  Layer.provideMerge(
    OrchestrationLayerLive.pipe(
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j1-dot-oauth-test-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);

const seed = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse(NOW));
  yield* (yield* OrchestrationEngineService).dispatch({
    type: "project.create",
    commandId: CommandId.make(`project:${projectId}`),
    projectId,
    title: "OAuth project",
    workspaceRoot: `${process.cwd()}/${projectId}`,
    defaultModelSelection: null,
    createdAt: NOW,
  });
});
const connect = (read = true, createTasks = true) =>
  Effect.gen(function* () {
    const issued = yield* (yield* DotConnections).create({
      label: "ChatGPT",
      grants: [{ projectId, read, createTasks, runtimeMode: "approval-required" }],
      expiresInDays: 30,
    });
    return issued.connection.id;
  });
const errorOf = <A, R>(effect: Effect.Effect<A, { readonly error: string }, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((failure) => failure.error),
  );
const codeFrom = (redirect: string) => new URL(redirect).searchParams.get("code")!;
const grantCode = (connectionId: string, scope = "dot:read dot:tasks") =>
  Effect.gen(function* () {
    const oauth = yield* DotOAuth;
    const { requestId } = yield* oauth.begin(authorization({ scope }), session);
    return codeFrom(yield* oauth.authorize(requestId, session, connectionId));
  });

describe("Dot OAuth", () => {
  it.effect("issues memory scopes only when requested and granted, and rechecks the grant", () =>
    Effect.gen(function* () {
      yield* seed;
      const oauth = yield* DotOAuth;
      const connections = yield* DotConnections;
      yield* oauth.configure(setup);
      const memory = yield* connections.create({
        label: "Hive Mind",
        grants: [],
        hiveMind: { read: true, write: true },
        expiresInDays: 1,
      });
      const tokens = yield* oauth.exchange(
        exchangeInput(yield* grantCode(memory.connection.id, "dot:memory:read dot:memory:write")),
      );
      expect(tokens.scope).toBe("dot:memory:read dot:memory:write");
      expect(Option.getOrThrow(yield* oauth.resolve(tokens.access_token)).scopes).toEqual([
        "dot:memory:read",
        "dot:memory:write",
      ]);
      const readOnly = yield* connections.create({
        label: "Read memory",
        grants: [],
        hiveMind: { read: true, write: false },
        expiresInDays: 1,
      });
      const readTokens = yield* oauth.exchange(
        exchangeInput(yield* grantCode(readOnly.connection.id, "dot:memory:read dot:memory:write")),
      );
      expect(readTokens.scope).toBe("dot:memory:read");
      expect(yield* errorOf(grantCode(yield* connect(), "dot:memory:read"))).toBe("invalid_scope");
      yield* connections.revoke(memory.connection.id);
      expect(Option.isNone(yield* oauth.resolve(tokens.access_token))).toBe(true);
      expect(
        yield* errorOf(
          oauth.refresh({
            clientId: setup.clientId,
            resource: setup.resource,
            refreshToken: tokens.refresh_token,
          }),
        ),
      ).toBe("invalid_grant");
    }).pipe(Effect.provide(testLayer)),
  );
  it.effect("accepts only https setups without credentials, query, or fragment", () =>
    Effect.gen(function* () {
      const oauth = yield* DotOAuth;
      expect(Option.isNone(yield* oauth.readSetup)).toBe(true);
      expect(yield* errorOf(oauth.begin(authorization(), session))).toBe("temporarily_unavailable");
      for (const invalid of [
        { issuer: "http://auth.example.test" },
        { issuer: "https://auth.example.test/tenant" },
        { issuer: "https://user:pass@auth.example.test" },
        { resource: "http://mcp.example.test/dot/mcp" },
        { resource: "https://mcp.example.test/dot/mcp?x=1" },
        { redirectUri: "https://chatgpt.com/callback#frag" },
        { redirectUri: "not a url" },
        { clientId: "" },
      ])
        expect(yield* errorOf(oauth.configure({ ...setup, ...invalid }))).toBe("invalid_request");
      expect(Option.isNone(yield* oauth.readSetup)).toBe(true);
      yield* oauth.configure(setup);
      expect(Option.getOrThrow(yield* oauth.readSetup)).toEqual(setup);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects malformed authorization requests before consent", () =>
    Effect.gen(function* () {
      const oauth = yield* DotOAuth;
      yield* oauth.configure(setup);
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ client_id: "other-client" }, "invalid_client"],
        [{ redirect_uri: "https://evil.example.test/callback" }, "invalid_request"],
        [{ resource: "https://mcp.example.test/other" }, "invalid_request"],
        [{ code_challenge_method: "plain" }, "invalid_request"],
        [{ code_challenge: undefined }, "invalid_request"],
        [{ code_challenge: "short" }, "invalid_request"],
        [{ response_type: "token" }, "invalid_request"],
        [{ state: "" }, "invalid_request"],
        [{ scope: "dot:read dot:admin" }, "invalid_scope"],
      ];
      for (const [overrides, error] of cases)
        expect(yield* errorOf(oauth.begin(authorization(overrides), session))).toBe(error);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "binds consent to the J1 session, issues single-use PKCE codes, and stores only hashes",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const oauth = yield* DotOAuth;
        yield* oauth.configure(setup);
        const connectionId = yield* connect();
        const { requestId, issuer } = yield* oauth.begin(authorization(), session);
        expect(issuer).toBe(setup.issuer);
        expect(yield* errorOf(oauth.authorize(requestId, "other-session", connectionId))).toBe(
          "access_denied",
        );
        const redirect = new URL(yield* oauth.authorize(requestId, session, connectionId));
        expect(redirect.origin + redirect.pathname).toBe(setup.redirectUri);
        expect(redirect.searchParams.get("state")).toBe("opaque-state");
        expect(redirect.searchParams.get("iss")).toBe(setup.issuer);
        const code = redirect.searchParams.get("code")!;
        expect(yield* errorOf(oauth.authorize(requestId, session, connectionId))).toBe(
          "invalid_request",
        );

        for (const wrong of [
          { verifier: "w".repeat(43) },
          { verifier: "short" },
          { clientId: "other-client" },
          { redirectUri: "https://evil.example.test/callback" },
          { resource: "https://mcp.example.test/other" },
        ])
          expect(yield* errorOf(oauth.exchange(exchangeInput(code, wrong)))).toBe("invalid_grant");
        const tokens = yield* oauth.exchange(exchangeInput(code));
        expect(tokens).toMatchObject({
          token_type: "Bearer",
          expires_in: 3600,
          scope: "dot:read dot:tasks",
        });
        expect(yield* errorOf(oauth.exchange(exchangeInput(code)))).toBe("invalid_grant");
        const resolved = Option.getOrThrow(yield* oauth.resolve(tokens.access_token));
        expect(resolved.connection.id).toBe(connectionId);
        expect(resolved.scopes).toEqual(["dot:read", "dot:tasks"]);
        expect(Option.isNone(yield* oauth.resolve(tokens.refresh_token))).toBe(true);
        expect(Option.isNone(yield* oauth.resolve("j1-dot-oauth-unknown"))).toBe(true);

        const pendingId = (yield* oauth.begin(authorization(), session)).requestId;
        const pendingCode = yield* grantCode(connectionId);
        const sql = yield* SqlClient.SqlClient;
        const stored = [
          ...(yield* sql`SELECT * FROM dot_oauth_requests`),
          ...(yield* sql`SELECT * FROM dot_oauth_codes`),
          ...(yield* sql`SELECT * FROM dot_oauth_tokens`),
        ]
          .flatMap((row) => Object.values(row))
          .join("\n");
        for (const secret of [
          pendingId,
          pendingCode,
          tokens.access_token,
          tokens.refresh_token,
          verifier,
        ])
          expect(stored).not.toContain(secret);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("denial echoes state and issuer without a code and consumes the request", () =>
    Effect.gen(function* () {
      yield* seed;
      const oauth = yield* DotOAuth;
      yield* oauth.configure(setup);
      const connectionId = yield* connect();
      const { requestId } = yield* oauth.begin(authorization(), session);
      const redirect = new URL(yield* oauth.authorize(requestId, session, null));
      expect(redirect.searchParams.get("error")).toBe("access_denied");
      expect(redirect.searchParams.get("state")).toBe("opaque-state");
      expect(redirect.searchParams.get("iss")).toBe(setup.issuer);
      expect(redirect.searchParams.has("code")).toBe(false);
      expect(yield* errorOf(oauth.authorize(requestId, session, connectionId))).toBe(
        "invalid_request",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("grants only scopes the connection allows", () =>
    Effect.gen(function* () {
      yield* seed;
      const oauth = yield* DotOAuth;
      yield* oauth.configure(setup);
      const readOnly = yield* connect(true, false);
      const { requestId } = yield* oauth.begin(authorization(), session);
      const redirect = new URL(yield* oauth.authorize(requestId, session, readOnly));
      const tokens = yield* oauth.exchange(exchangeInput(redirect.searchParams.get("code")!));
      expect(tokens.scope).toBe("dot:read");
      expect(Option.getOrThrow(yield* oauth.resolve(tokens.access_token)).scopes).toEqual([
        "dot:read",
      ]);
      expect(
        yield* errorOf(
          oauth.refresh({
            refreshToken: tokens.refresh_token,
            clientId: setup.clientId,
            resource: setup.resource,
            scope: "dot:read dot:tasks",
          }),
        ),
      ).toBe("invalid_scope");
      expect(yield* errorOf(oauth.authorize("dot-auth-missing", session, readOnly))).toBe(
        "invalid_request",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("expires pending requests and codes after five minutes", () =>
    Effect.gen(function* () {
      yield* seed;
      const oauth = yield* DotOAuth;
      yield* oauth.configure(setup);
      const connectionId = yield* connect();
      const { requestId } = yield* oauth.begin(authorization(), session);
      const code = yield* grantCode(connectionId);
      yield* TestClock.adjust("5 minutes");
      expect(yield* errorOf(oauth.authorize(requestId, session, connectionId))).toBe(
        "invalid_request",
      );
      expect(yield* errorOf(oauth.exchange(exchangeInput(code)))).toBe("invalid_grant");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects codes and tokens once the connection is revoked", () =>
    Effect.gen(function* () {
      yield* seed;
      const oauth = yield* DotOAuth;
      const connections = yield* DotConnections;
      yield* oauth.configure(setup);
      const connectionId = yield* connect();
      const code = yield* grantCode(connectionId);
      const tokens = yield* oauth.exchange(exchangeInput(yield* grantCode(connectionId)));
      const { requestId } = yield* oauth.begin(authorization(), session);
      yield* connections.revoke(connectionId);
      expect(yield* errorOf(oauth.exchange(exchangeInput(code)))).toBe("invalid_grant");
      expect(Option.isNone(yield* oauth.resolve(tokens.access_token))).toBe(true);
      expect(
        yield* errorOf(
          oauth.refresh({
            refreshToken: tokens.refresh_token,
            clientId: setup.clientId,
            resource: setup.resource,
          }),
        ),
      ).toBe("invalid_grant");
      expect(yield* errorOf(oauth.authorize(requestId, session, connectionId))).toBe(
        "access_denied",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rotates refresh tokens and revokes the family on replay", () =>
    Effect.gen(function* () {
      yield* seed;
      const oauth = yield* DotOAuth;
      yield* oauth.configure(setup);
      const connectionId = yield* connect();
      const first = yield* oauth.exchange(exchangeInput(yield* grantCode(connectionId)));
      const refresh = (refreshToken: string, extra: { clientId?: string; scope?: string } = {}) =>
        oauth.refresh({
          refreshToken,
          clientId: setup.clientId,
          resource: setup.resource,
          ...extra,
        });
      expect(yield* errorOf(refresh(first.refresh_token, { clientId: "other-client" }))).toBe(
        "invalid_grant",
      );
      expect(yield* errorOf(refresh(first.refresh_token, { scope: "dot:admin" }))).toBe(
        "invalid_scope",
      );

      yield* TestClock.adjust("1 hour");
      expect(Option.isNone(yield* oauth.resolve(first.access_token))).toBe(true);
      const second = yield* refresh(first.refresh_token, { scope: "dot:read" });
      expect(second.scope).toBe("dot:read");
      expect(second.refresh_token).not.toBe(first.refresh_token);
      expect(Option.getOrThrow(yield* oauth.resolve(second.access_token)).scopes).toEqual([
        "dot:read",
      ]);
      const restored = yield* refresh(second.refresh_token);
      expect(restored.scope).toBe("dot:read dot:tasks");
      expect(Option.getOrThrow(yield* oauth.resolve(restored.access_token)).scopes).toEqual([
        "dot:read",
        "dot:tasks",
      ]);

      expect(yield* errorOf(refresh(first.refresh_token))).toBe("invalid_grant");
      expect(Option.isNone(yield* oauth.resolve(second.access_token))).toBe(true);
      expect(Option.isNone(yield* oauth.resolve(restored.access_token))).toBe(true);
      expect(yield* errorOf(refresh(second.refresh_token))).toBe("invalid_grant");

      const other = yield* oauth.exchange(exchangeInput(yield* grantCode(connectionId)));
      yield* TestClock.adjust("31 days");
      expect(yield* errorOf(refresh(other.refresh_token))).toBe("invalid_grant");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps pending consent and tokens across a service rebuild", () =>
    Effect.gen(function* () {
      yield* seed;
      const oauth = yield* DotOAuth;
      yield* oauth.configure(setup);
      const connectionId = yield* connect();
      const tokens = yield* oauth.exchange(exchangeInput(yield* grantCode(connectionId)));
      const { requestId } = yield* oauth.begin(authorization(), session);
      const rebuilt = yield* DotOAuth.pipe(
        Effect.provide(Layer.fresh(oauthLayer).pipe(Layer.provide(connectionsLayer))),
      );
      expect(Option.getOrThrow(yield* rebuilt.readSetup)).toEqual(setup);
      expect(Option.isSome(yield* rebuilt.resolve(tokens.access_token))).toBe(true);
      const code = codeFrom(yield* rebuilt.authorize(requestId, session, connectionId));
      expect((yield* rebuilt.exchange(exchangeInput(code))).scope).toBe("dot:read dot:tasks");

      yield* rebuilt.configure({ ...setup, clientId: "rotated-client" });
      expect(Option.isNone(yield* oauth.resolve(tokens.access_token))).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );
});
