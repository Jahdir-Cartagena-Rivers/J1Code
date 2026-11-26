import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as CliTokenManager from "./CliTokenManager.ts";

const TEST_ENV = {
  T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
  T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_client_test",
  T3CODE_HOSTED_APP_URL: "https://hosted.example.test",
  T3CODE_RELAY_URL: "https://relay.example.test",
};

interface RecordedTokenRequest {
  readonly url: string;
  readonly params: URLSearchParams;
}

const TestIdTokenHeaderJson = Schema.fromJsonString(Schema.Struct({ alg: Schema.Literal("none") }));
const TestIdTokenPayloadJson = Schema.fromJsonString(Schema.Struct({ email: Schema.String }));
const encodeTestIdTokenHeader = Schema.encodeSync(TestIdTokenHeaderJson);
const encodeTestIdTokenPayload = Schema.encodeSync(TestIdTokenPayloadJson);
const idTokenWithEmail = (() => {
  const header = Base64Url.encode(encodeTestIdTokenHeader({ alg: "none" }));
  const payload = Base64Url.encode(encodeTestIdTokenPayload({ email: "theo@example.test" }));
  return `${header}.${payload}.`;
})();

const TestTokenResponseJson = Schema.fromJsonString(
  Schema.Struct({
    access_token: Schema.String,
    refresh_token: Schema.String,
    id_token: Schema.String,
    expires_in: Schema.Number,
    token_type: Schema.String,
  }),
);
const encodeTestTokenResponse = Schema.encodeSync(TestTokenResponseJson);

const provideTestEnv = Effect.provide(
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: TEST_ENV })),
);

interface DeviceFlowServer {
  readonly requests: Array<RecordedTokenRequest>;
  readonly tokenReplies: Array<{ readonly status: number; readonly body: string }>;
}

const DEVICE_AUTHORIZATION_BODY = JSON.stringify({
  device_code: "device-code-1",
  user_code: "BCDF-GHJK",
  verification_uri: "https://accounts.example.test/device",
  verification_uri_complete: "https://accounts.example.test/device?user_code=BCDF-GHJK",
  expires_in: 600,
  interval: 5,
});

const oauthError = (error: string) => ({ status: 400, body: JSON.stringify({ error }) });
const tokenGranted = {
  status: 200,
  body: encodeTestTokenResponse({
    access_token: "access-token-1",
    refresh_token: "refresh-token-1",
    id_token: idTokenWithEmail,
    expires_in: 3600,
    token_type: "bearer",
  }),
};

const layerDeviceFlow = (server: DeviceFlowServer) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        server.requests.push({ url: request.url, params: new URLSearchParams(body) });
        const reply = request.url.endsWith("/oauth/device_authorization")
          ? { status: 200, body: DEVICE_AUTHORIZATION_BODY }
          : ((server.tokenReplies.length > 1
              ? server.tokenReplies.shift()
              : server.tokenReplies[0]) ?? oauthError("invalid_grant"));
        return HttpClientResponse.fromWeb(
          request,
          new Response(reply.body, {
            status: reply.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );

const tokenRequests = (requests: ReadonlyArray<RecordedTokenRequest>) =>
  requests.filter((request) => request.url.endsWith("/oauth/token"));

const destination = {
  tokenEndpoint: "https://clerk.example.test/oauth/token",
  clientId: "oauth_client_test",
  relayUrl: "https://relay.example.test",
};
const expiredToken = {
  accessToken: "expired",
  refreshToken: "refresh-token-1",
  expiresAtEpochMs: 0,
  destination,
  identity: "old@example.test",
  accountSubject: "fixture-account",
};
const encodeFixture = (token: CliTokenManager.PersistedToken) =>
  new TextEncoder().encode(JSON.stringify(token));
const expiredStoredToken = encodeFixture(expiredToken);

const provideRefreshManager = (
  httpClient: HttpClient.HttpClient,
  secrets = Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: () => Effect.succeedSome(expiredStoredToken),
  }),
  env: Readonly<Record<string, string>> = TEST_ENV,
) =>
  Effect.provide(
    CliTokenManager.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, httpClient),
          secrets,
          Layer.mock(ExternalLauncher.ExternalLauncher)({}),
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
      Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    ),
  );

it.effect(
  "persists rotated credentials under the lock despite shutdown, while queued callers can cancel",
  () =>
    Effect.gen(function* () {
      const requestStarted = yield* Deferred.make<void>();
      const releaseRequest = yield* Deferred.make<void>();
      const persistStarted = yield* Deferred.make<void>();
      const releasePersist = yield* Deferred.make<void>();
      let stored = expiredStoredToken;
      let reads = 0;
      const httpClient = HttpClient.make((request) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(requestStarted, undefined);
          yield* Deferred.await(releaseRequest);
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              access_token: "rotated-access",
              refresh_token: "rotated-refresh",
              expires_in: 3600,
              token_type: "bearer",
            }),
          );
        }),
      );
      const secrets = Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: () =>
          Effect.sync(() => {
            reads++;
            return Option.some(stored);
          }),
        set: (_name, value) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(persistStarted, undefined);
            yield* Deferred.await(releasePersist);
            stored = new Uint8Array(value);
          }),
      });

      yield* Effect.gen(function* () {
        const manager = yield* CliTokenManager.CloudCliTokenManager;
        const refresh = yield* manager.getExisting.pipe(Effect.forkChild);
        assert.isTrue(
          yield* Effect.raceFirst(
            Deferred.await(requestStarted).pipe(Effect.as(true)),
            Fiber.await(refresh).pipe(Effect.as(false)),
          ),
          "refresh failed before reaching the endpoint",
        );
        const waiter = yield* manager.getExisting.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Fiber.interrupt(waiter);
        assert.equal(reads, 1, "queued caller must not read credentials during refresh");
        const interruption = yield* Fiber.interrupt(refresh).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(releaseRequest, undefined);
        const reachedPersist = yield* Effect.raceFirst(
          Deferred.await(persistStarted).pipe(Effect.as(true)),
          Fiber.await(refresh).pipe(Effect.as(false)),
        );
        assert.isTrue(reachedPersist, "shutdown discarded the rotated credential");
        const reader = yield* manager.getExisting.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        assert.equal(reads, 1, "credential lock must cover persistence");
        yield* Deferred.succeed(releasePersist, undefined);
        yield* Fiber.join(interruption);
        const token = Option.getOrThrow(yield* Fiber.join(reader));
        assert.equal(token.refreshToken, "rotated-refresh");
        assert.equal(token.accessToken, "rotated-access");
        assert.equal(token.identity, expiredToken.identity);
        assert.equal(token.accountSubject, expiredToken.accountSubject);
        assert.deepEqual(token.destination, destination);
      }).pipe(
        Effect.ensuring(Deferred.succeed(releaseRequest, undefined)),
        Effect.ensuring(Deferred.succeed(releasePersist, undefined)),
        provideRefreshManager(httpClient, secrets),
      );
    }),
);

it.effect.each([
  { status: 400, code: "invalid_grant", requiresLogin: true, diagnostic: true },
  { status: 403, code: "private-provider-secret", requiresLogin: true, diagnostic: false },
  { status: 429, code: "invalid_grant", requiresLogin: false, diagnostic: false },
])(
  "refresh HTTP $status exposes only a safe login diagnostic",
  ({ status, code, requiresLogin, diagnostic }) =>
    Effect.gen(function* () {
      const manager = yield* CliTokenManager.CloudCliTokenManager;
      const error = yield* manager.getExisting.pipe(Effect.flip);
      assert.instanceOf(error, CliTokenManager.CloudCliCredentialRefreshError);
      assert.equal(error.requiresLogin, requiresLogin);
      assert.equal(error.message.includes("j1 connect login"), requiresLogin);
      assert.equal(error.message.includes("OAuth error: invalid_grant"), diagnostic);
      assert.notInclude(error.message, "private");
      assert.equal(error.message.includes("OAuth error:"), diagnostic);
      assert.isTrue(yield* manager.hasCredential);
    }).pipe(
      provideRefreshManager(
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                {
                  error: code,
                  error_description: "private-description",
                  refresh_token: "private-refresh-token",
                },
                { status },
              ),
            ),
          ),
        ),
      ),
    ),
);

it.effect.each([
  { name: "legacy unbound", token: { ...expiredToken, destination: undefined }, env: TEST_ENV },
  { name: "different OAuth client", token: expiredToken, env: {
    ...TEST_ENV, T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "other-oauth-client",
  } },
  { name: "different relay", token: expiredToken, env: {
    ...TEST_ENV, T3CODE_RELAY_URL: "https://other.example.test",
  } },
  { name: "different issuer", token: {
    ...expiredToken, destination: { ...destination, tokenEndpoint: "https://other.example.test/oauth/token" },
  }, env: TEST_ENV },
])("refuses a $name record before credential use or authorization fallback", ({ token, env }) => {
  const stored = encodeFixture(token);
  const secrets = Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: () => Effect.succeedSome(stored),
    set: () => Effect.die(new Error("Unexpected credential write")),
    remove: () => Effect.die(new Error("Unexpected credential removal")),
  });
  return Effect.gen(function* () {
    const manager = yield* CliTokenManager.CloudCliTokenManager;
    for (const error of [
      yield* manager.getExisting.pipe(Effect.flip),
      yield* manager.get.pipe(Effect.flip),
    ]) {
      assert.instanceOf(error, CliTokenManager.CloudCliCredentialRefreshError);
      assert.equal(error.bindingMismatch, "destination");
      assert.isFalse(error.requiresLogin);
      assert.notInclude(error.message, token.refreshToken);
    }
    assert.isTrue(yield* manager.hasCredential);
  }).pipe(provideRefreshManager(
    HttpClient.make(() => Effect.die(new Error("Unexpected OAuth request"))),
    secrets,
    env,
  ));
});

it.effect.each([
  {
    name: "unidentified saved account",
    saved: { ...expiredToken, accountSubject: undefined, identity: undefined },
    allowed: false,
  },
  {
    name: "different subject with the same email",
    saved: { ...expiredToken, accountSubject: "other-account" },
    allowed: false,
  },
  { name: "same account", saved: expiredToken, allowed: true },
])("checks account continuity when storing fresh authorization for $name", ({ saved, allowed }) => {
  const original = encodeFixture(saved);
  let stored = original;
  const replacement = { ...expiredToken, accessToken: "replacement", refreshToken: "rotated" };
  const secrets = Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: () => Effect.sync(() => Option.some(stored)),
    set: (_name, value) =>
      Effect.sync(() => {
        stored = new Uint8Array(value);
      }),
  });
  return Effect.gen(function* () {
    const manager = yield* CliTokenManager.CloudCliTokenManager;
    if (allowed) {
      yield* manager.store(replacement);
      assert.deepEqual(JSON.parse(new TextDecoder().decode(stored)), replacement);
    } else {
      const error = yield* manager.store(replacement).pipe(Effect.flip);
      assert.instanceOf(error, CliTokenManager.CloudCliCredentialRefreshError);
      assert.equal(error.bindingMismatch, "account");
      assert.strictEqual(stored, original);
    }
  }).pipe(
    provideRefreshManager(
      HttpClient.make(() => Effect.die(new Error("Unexpected OAuth request"))),
      secrets,
    ),
  );
});

it.effect("refuses an account change and retries a neighboring refresh without losing identity", () => {
  let stored = expiredStoredToken;
  let writes = 0;
  let requests = 0;
  const secrets = Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: () => Effect.sync(() => Option.some(stored)),
    set: (_name, value) => Effect.sync(() => { stored = new Uint8Array(value); writes++; }),
  });
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const body = requests++ === 0
        ? {
            access_token: "foreign-access",
            refresh_token: "foreign-refresh",
            id_token: idTokenWithEmail,
            expires_in: 3600,
            token_type: "bearer",
          }
        : { access_token: "rotated-access", refresh_token: "rotated-refresh",
          expires_in: 3600, token_type: "bearer" };
      return HttpClientResponse.fromWeb(request, Response.json(body));
    }),
  );
  return Effect.gen(function* () {
    const manager = yield* CliTokenManager.CloudCliTokenManager;
    const mismatch = yield* manager.getExisting.pipe(Effect.flip);
    assert.instanceOf(mismatch, CliTokenManager.CloudCliCredentialRefreshError);
    assert.equal(mismatch.bindingMismatch, "account");
    assert.equal(writes, 0);
    assert.deepEqual(stored, expiredStoredToken);

    const refreshed = Option.getOrThrow(yield* manager.getExisting);
    assert.equal(refreshed.refreshToken, "rotated-refresh");
    assert.equal(refreshed.identity, expiredToken.identity);
    assert.equal(refreshed.accountSubject, expiredToken.accountSubject);
    assert.deepEqual(refreshed.destination, destination);
    assert.equal(requests, 2);
    assert.equal(writes, 1);
  }).pipe(provideRefreshManager(http, secrets));
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  "CliTokenManager.deviceAuthorizationLogin",
  (it) => {
    it.effect("requests a device code, shows it, and polls until Clerk grants the token", () =>
      Effect.gen(function* () {
        const server: DeviceFlowServer = {
          requests: [],
          tokenReplies: [oauthError("authorization_pending"), tokenGranted],
        };
        const prompts: Array<CliTokenManager.DeviceAuthorizationPrompt> = [];

        const fiber = yield* CliTokenManager.deviceAuthorizationLogin((prompt) =>
          Effect.sync(() => {
            prompts.push(prompt);
          }),
        ).pipe(Effect.provide(layerDeviceFlow(server)), provideTestEnv, Effect.forkChild);

        yield* TestClock.adjust(Duration.seconds(10));
        const { token, identity } = yield* Fiber.join(fiber);

        assert.deepEqual(prompts, [
          {
            verificationUri: "https://accounts.example.test/device",
            verificationUriComplete: "https://accounts.example.test/device?user_code=BCDF-GHJK",
            userCode: "BCDF-GHJK",
            expiresIn: Duration.seconds(600),
          },
        ]);
        assert.equal(token.accessToken, "access-token-1");
        assert.equal(token.refreshToken, "refresh-token-1");
        assert.equal(token.identity, "theo@example.test");
        assert.equal(identity, "theo@example.test");

        const authorization = server.requests[0]!;
        assert.equal(authorization.url, "https://clerk.example.test/oauth/device_authorization");
        assert.equal(authorization.params.get("client_id"), "oauth_client_test");
        assert.equal(authorization.params.get("scope"), "openid profile email offline_access");

        const polls = tokenRequests(server.requests);
        assert.lengthOf(polls, 2);
        for (const poll of polls) {
          assert.equal(poll.url, "https://clerk.example.test/oauth/token");
          assert.equal(
            poll.params.get("grant_type"),
            "urn:ietf:params:oauth:grant-type:device_code",
          );
          assert.equal(poll.params.get("device_code"), "device-code-1");
          assert.equal(poll.params.get("client_id"), "oauth_client_test");
        }
      }),
    );

    it.effect("fails with a denied error when the user rejects the request", () =>
      Effect.gen(function* () {
        const server: DeviceFlowServer = {
          requests: [],
          tokenReplies: [oauthError("access_denied")],
        };

        const fiber = yield* CliTokenManager.deviceAuthorizationLogin(() => Effect.void).pipe(
          Effect.provide(layerDeviceFlow(server)),
          provideTestEnv,
          Effect.flip,
          Effect.forkChild,
        );
        yield* TestClock.adjust(Duration.seconds(5));
        const result = yield* Fiber.join(fiber);

        assert.instanceOf(result, CliTokenManager.CloudCliAuthorizationDeniedError);
        assert.lengthOf(tokenRequests(server.requests), 1);
      }),
    );
  },
);
