import { DotOAuthSetup, DOT_OAUTH_SCOPES } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { DotConnections, connectionAllowsDotScope } from "./DotConnections.ts";

export const scopes = DOT_OAUTH_SCOPES;
export const registeredDotClients = (setup: DotOAuthSetup) => [
  setup,
  ...(setup.additionalClients ?? []),
];
export const matchesDotClient = (
  setup: DotOAuthSetup,
  binding: { clientId: string; resource: string; redirectUri: string },
) =>
  registeredDotClients(setup).some(
    (client) =>
      client.clientId === binding.clientId &&
      client.resource === binding.resource &&
      client.redirectUri === binding.redirectUri,
  );
export class DotOAuthError extends Schema.TaggedError<DotOAuthError>()("DotOAuthError", {
  error: Schema.Literals([
    "invalid_request",
    "invalid_client",
    "invalid_scope",
    "invalid_grant",
    "access_denied",
    "temporarily_unavailable",
  ]),
}) {}
const fail = (error: DotOAuthError["error"]) => new DotOAuthError({ error });
const bounded = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048));
export const AuthorizationInput = Schema.Struct({
  response_type: Schema.Literal("code"),
  client_id: bounded,
  redirect_uri: bounded,
  resource: bounded,
  scope: bounded,
  state: bounded,
  code_challenge: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
  code_challenge_method: Schema.Literal("S256"),
});
export type AuthorizationInput = typeof AuthorizationInput.Type;
const Pending = Schema.Struct({
  ...AuthorizationInput.fields,
  issuer: Schema.String,
  sessionId: Schema.String,
});
const Grant = Schema.Struct({
  connectionId: Schema.String,
  issuer: Schema.String,
  resource: Schema.String,
  clientId: Schema.String,
  redirectUri: Schema.String,
  scopes: Schema.Array(Schema.Literals(scopes)),
  challenge: Schema.String,
});
type Grant = typeof Grant.Type;
const decodeInput = Schema.decodeUnknownEffect(AuthorizationInput);
const decodeSetupInput = Schema.decodeEffect(DotOAuthSetup);
const decodeSetup = Schema.decodeUnknownEffect(Schema.fromJsonString(DotOAuthSetup));
const encodeSetup = Schema.encodeEffect(Schema.fromJsonString(DotOAuthSetup));
const decodePending = Schema.decodeUnknownEffect(Schema.fromJsonString(Pending));
const encodePending = Schema.encodeEffect(Schema.fromJsonString(Pending));
const decodeGrant = Schema.decodeUnknownEffect(Schema.fromJsonString(Grant));
const encodeGrant = Schema.encodeEffect(Schema.fromJsonString(Grant));
const now = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const connections = yield* DotConnections;
  const hash = (value: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("hex")),
      Effect.mapError(() => fail("temporarily_unavailable")),
    );
  const random = (prefix: string) =>
    crypto.randomBytes(32).pipe(
      Effect.map((bytes) => prefix + Buffer.from(bytes).toString("base64url")),
      Effect.mapError(() => fail("temporarily_unavailable")),
    );
  const readSetup = sql<{
    setup_json: string;
  }>`SELECT setup_json FROM dot_oauth_setup WHERE id = 1`.pipe(
    Effect.flatMap((rows) =>
      rows[0] ? decodeSetup(rows[0].setup_json).pipe(Effect.map(Option.some)) : Effect.succeedNone,
    ),
    Effect.mapError(() => fail("temporarily_unavailable")),
  );
  const setup = readSetup.pipe(
    Effect.flatMap((value) =>
      Option.isSome(value)
        ? Effect.succeed(value.value)
        : Effect.fail(fail("temporarily_unavailable")),
    ),
  );
  const validateGrant = Effect.fn("DotOAuth.validateGrant")(function* (grant: Grant) {
    const current = yield* setup;
    if (grant.issuer !== current.issuer || !matchesDotClient(current, grant))
      return yield* fail("invalid_grant");
    const connection = yield* connections
      .getActive(grant.connectionId)
      .pipe(Effect.mapError(() => fail("invalid_grant")));
    if (grant.scopes.some((scope) => !connectionAllowsDotScope(connection, scope)))
      return yield* fail("invalid_grant");
    return connection;
  });
  const issueTokens = Effect.fn("DotOAuth.issueTokens")(function* (
    grant: Grant,
    familyId: string,
    accessScopes = grant.scopes,
  ) {
    const connection = yield* validateGrant(grant);
    const timestamp = yield* now;
    const expiresAt = Math.min(timestamp + 3_600_000, Date.parse(connection.expiresAt));
    const accessToken = yield* random("j1-dot-oauth-");
    const refreshToken = yield* random("j1-dot-refresh-");
    yield* sql`DELETE FROM dot_oauth_tokens WHERE expires_at <= ${timestamp}`;
    const json = yield* encodeGrant(grant).pipe(
      Effect.mapError(() => fail("temporarily_unavailable")),
    );
    const accessJson = yield* encodeGrant({ ...grant, scopes: accessScopes }).pipe(
      Effect.mapError(() => fail("temporarily_unavailable")),
    );
    yield* sql`INSERT INTO dot_oauth_tokens (token_hash, family_id, kind, grant_json, expires_at)
      VALUES (${yield* hash(accessToken)}, ${familyId}, 'access', ${accessJson}, ${expiresAt})`;
    yield* sql`INSERT INTO dot_oauth_tokens (token_hash, family_id, kind, grant_json, expires_at)
      VALUES (${yield* hash(refreshToken)}, ${familyId}, 'refresh', ${json}, ${Date.parse(connection.expiresAt)})`;
    return {
      access_token: accessToken,
      token_type: "Bearer" as const,
      expires_in: Math.floor((expiresAt - timestamp) / 1000),
      refresh_token: refreshToken,
      scope: accessScopes.join(" "),
    };
  });
  const pending = Effect.fn("DotOAuth.pending")(function* (requestId: string) {
    if (requestId.length > 128) return yield* fail("invalid_request");
    const rows = yield* sql<{
      request_json: string;
      expires_at: number;
    }>`SELECT request_json, expires_at FROM dot_oauth_requests WHERE request_hash = ${yield* hash(requestId)}`;
    const row = rows[0];
    if (!row || row.expires_at <= (yield* now)) return yield* fail("invalid_request");
    const request = yield* decodePending(row.request_json).pipe(
      Effect.mapError(() => fail("invalid_request")),
    );
    const current = yield* setup;
    if (
      request.issuer !== current.issuer ||
      !matchesDotClient(current, {
        resource: request.resource,
        clientId: request.client_id,
        redirectUri: request.redirect_uri,
      })
    )
      return yield* fail("invalid_request");
    return request;
  });
  return {
    readSetup,
    configure: Effect.fn("DotOAuth.configure")(
      function* (input: DotOAuthSetup) {
        input = yield* decodeSetupInput(input).pipe(Effect.mapError(() => fail("invalid_request")));
        const urls = yield* Effect.try({
          try: () => [
            new URL(input.issuer),
            ...registeredDotClients(input).flatMap((client) => [
              new URL(client.resource),
              new URL(client.redirectUri),
            ]),
          ],
          catch: () => fail("invalid_request"),
        });
        if (
          urls.some(
            (url) =>
              url.protocol !== "https:" ||
              url.username !== "" ||
              url.password !== "" ||
              url.hash !== "" ||
              url.search !== "",
          ) ||
          urls[0]!.pathname !== "/" ||
          input.issuer !== urls[0]!.origin
        )
          return yield* fail("invalid_request");
        const json = yield* encodeSetup(input).pipe(Effect.mapError(() => fail("invalid_request")));
        yield* sql`INSERT INTO dot_oauth_setup (id, setup_json) VALUES (1, ${json}) ON CONFLICT (id) DO UPDATE SET setup_json = excluded.setup_json`;
        return input;
      },
      Effect.catchTag("SqlError", () => fail("temporarily_unavailable")),
    ),
    begin: Effect.fn("DotOAuth.begin")(
      function* (input: unknown, sessionId: string) {
        const request = yield* decodeInput(input).pipe(
          Effect.mapError(() => fail("invalid_request")),
        );
        const current = yield* setup;
        if (!registeredDotClients(current).some((client) => client.clientId === request.client_id))
          return yield* fail("invalid_client");
        if (
          !matchesDotClient(current, {
            resource: request.resource,
            clientId: request.client_id,
            redirectUri: request.redirect_uri,
          })
        )
          return yield* fail("invalid_request");
        const requestedScopes = [...new Set(request.scope.split(" "))];
        if (requestedScopes.some((value) => !scopes.some((scope) => scope === value)))
          return yield* fail("invalid_scope");
        const requestId = yield* random("dot-auth-");
        const json = yield* encodePending({ ...request, issuer: current.issuer, sessionId }).pipe(
          Effect.mapError(() => fail("invalid_request")),
        );
        const timestamp = yield* now;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM dot_oauth_requests WHERE expires_at <= ${timestamp}`;
            yield* sql`DELETE FROM dot_oauth_codes WHERE expires_at <= ${timestamp}`;
            const count = yield* sql<{
              count: number;
            }>`SELECT COUNT(*) AS count FROM dot_oauth_requests`;
            if (count[0]!.count >= 100) return yield* fail("temporarily_unavailable");
            yield* sql`INSERT INTO dot_oauth_requests (request_hash, request_json, expires_at) VALUES (${yield* hash(requestId)}, ${json}, ${timestamp + 300_000})`;
          }),
        );
        return { requestId, request, issuer: current.issuer };
      },
      Effect.catchTag("SqlError", () => fail("temporarily_unavailable")),
    ),
    authorize: Effect.fn("DotOAuth.authorize")(
      function* (requestId: string, sessionId: string, connectionId: string | null) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const request = yield* pending(requestId);
            if (request.sessionId !== sessionId) return yield* fail("access_denied");
            const redirect = new URL(request.redirect_uri);
            redirect.searchParams.set("state", request.state);
            redirect.searchParams.set("iss", request.issuer);
            if (connectionId === null) {
              redirect.searchParams.set("error", "access_denied");
            } else {
              const connection = yield* connections
                .getActive(connectionId)
                .pipe(Effect.mapError(() => fail("access_denied")));
              const requestedScopes = scopes.filter(
                (scope) =>
                  request.scope.split(" ").includes(scope) &&
                  connectionAllowsDotScope(connection, scope),
              );
              if (!requestedScopes.length) return yield* fail("invalid_scope");
              const grant: Grant = {
                connectionId: connection.id,
                issuer: request.issuer,
                resource: request.resource,
                clientId: request.client_id,
                redirectUri: request.redirect_uri,
                scopes: requestedScopes,
                challenge: request.code_challenge,
              };
              const code = yield* random("dot-code-");
              const json = yield* encodeGrant(grant).pipe(
                Effect.mapError(() => fail("temporarily_unavailable")),
              );
              yield* sql`INSERT INTO dot_oauth_codes (code_hash, grant_json, expires_at) VALUES (${yield* hash(code)}, ${json}, ${(yield* now) + 300_000})`;
              redirect.searchParams.set("code", code);
            }
            yield* sql`DELETE FROM dot_oauth_requests WHERE request_hash = ${yield* hash(requestId)}`;
            return redirect.toString();
          }),
        );
      },
      Effect.catchTag("SqlError", () => fail("temporarily_unavailable")),
    ),
    exchange: Effect.fn("DotOAuth.exchange")(
      function* (input: {
        code: string;
        clientId: string;
        redirectUri: string;
        resource: string;
        verifier: string;
      }) {
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier) || input.code.length > 128)
          return yield* fail("invalid_grant");
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const codeHash = yield* hash(input.code);
            const rows = yield* sql<{
              grant_json: string;
              expires_at: number;
            }>`SELECT grant_json, expires_at FROM dot_oauth_codes WHERE code_hash = ${codeHash}`;
            const row = rows[0];
            if (!row || row.expires_at <= (yield* now)) return yield* fail("invalid_grant");
            const grant = yield* decodeGrant(row.grant_json).pipe(
              Effect.mapError(() => fail("invalid_grant")),
            );
            const verifierHash = yield* crypto
              .digest("SHA-256", new TextEncoder().encode(input.verifier))
              .pipe(
                Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
                Effect.mapError(() => fail("temporarily_unavailable")),
              );
            if (
              grant.clientId !== input.clientId ||
              grant.redirectUri !== input.redirectUri ||
              grant.resource !== input.resource ||
              grant.challenge !== verifierHash
            )
              return yield* fail("invalid_grant");
            yield* sql`DELETE FROM dot_oauth_codes WHERE code_hash = ${codeHash}`;
            return yield* issueTokens(grant, yield* random("dot-family-"));
          }),
        );
      },
      Effect.catchTag("SqlError", () => fail("temporarily_unavailable")),
    ),
    refresh: Effect.fn("DotOAuth.refresh")(
      function* (input: {
        refreshToken: string;
        clientId: string;
        resource: string;
        scope?: string;
      }) {
        if (!input.refreshToken.startsWith("j1-dot-refresh-") || input.refreshToken.length > 128)
          return yield* fail("invalid_grant");
        // Replay invalidates the entire rotation family, including its access tokens.
        const result = yield* sql.withTransaction(
          Effect.gen(function* () {
            const tokenHash = yield* hash(input.refreshToken);
            const rows = yield* sql<{
              grant_json: string;
              expires_at: number;
              consumed: number;
              family_id: string;
            }>`SELECT grant_json, expires_at, consumed, family_id FROM dot_oauth_tokens WHERE token_hash = ${tokenHash} AND kind = 'refresh'`;
            const row = rows[0];
            if (!row || row.expires_at <= (yield* now)) return Option.none();
            const grant = yield* decodeGrant(row.grant_json).pipe(
              Effect.mapError(() => fail("invalid_grant")),
            );
            if (grant.clientId !== input.clientId || grant.resource !== input.resource)
              return Option.none();
            if (row.consumed) {
              yield* sql`DELETE FROM dot_oauth_tokens WHERE family_id = ${row.family_id}`;
              return Option.none();
            }
            const requested =
              input.scope === undefined
                ? grant.scopes
                : grant.scopes.filter((scope) => input.scope!.split(" ").includes(scope));
            if (
              input.scope !== undefined &&
              (!requested.length ||
                input.scope
                  .split(" ")
                  .some((scope) => !grant.scopes.some((value) => value === scope)))
            )
              return yield* fail("invalid_scope");
            yield* sql`UPDATE dot_oauth_tokens SET consumed = 1 WHERE token_hash = ${tokenHash}`;
            return Option.some(yield* issueTokens(grant, row.family_id, requested));
          }),
        );
        return Option.isSome(result) ? result.value : yield* fail("invalid_grant");
      },
      Effect.catchTag("SqlError", () => fail("temporarily_unavailable")),
    ),
    resolve: Effect.fn("DotOAuth.resolve")(
      function* (token: string) {
        if (!token.startsWith("j1-dot-oauth-") || token.length > 128) return Option.none();
        const rows = yield* sql<{
          grant_json: string;
          expires_at: number;
        }>`SELECT grant_json, expires_at FROM dot_oauth_tokens WHERE token_hash = ${yield* hash(token)} AND kind = 'access'`;
        const row = rows[0];
        if (!row || row.expires_at <= (yield* now)) return Option.none();
        const grant = yield* decodeGrant(row.grant_json).pipe(
          Effect.mapError(() => fail("invalid_grant")),
        );
        const connection = yield* validateGrant(grant);
        return Option.some({ connection, scopes: grant.scopes });
      },
      Effect.catchTag("DotOAuthError", (error) =>
        error.error === "invalid_grant" ? Effect.succeedNone : Effect.fail(error),
      ),
      Effect.catchTag("SqlError", () => fail("temporarily_unavailable")),
    ),
  };
});

export class DotOAuth extends Context.Service<DotOAuth, Effect.Success<typeof make>>()(
  "t3/dot/DotOAuth",
) {}
export const layer = Layer.effect(DotOAuth, make);
