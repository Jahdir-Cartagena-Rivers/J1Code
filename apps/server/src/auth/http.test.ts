import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import { computeDpopAccessTokenHash, type DpopPublicJwk } from "@j1code/shared/dpop";
import { EnvironmentHttpApi } from "@j1code/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "./http.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const configLayer = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

const environmentAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(configLayer),
);
const routesLayer = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(authHttpApiLayer),
  Layer.provide(environmentAuthenticatedAuthLayer),
  Layer.provideMerge(environmentAuthLayer),
  Layer.provide(configLayer),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

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
    const crypto = yield* Crypto.Crypto;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
            HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
          ] as const,
      ),
      ([environmentA, environmentB]) =>
        Effect.tryPromise(async () => {
          const devResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          expect(devResponse.status).toBe(200);
          const devBody = (await devResponse.json()) as { expiresAt: string };
          const devCookies = devResponse.headers.getSetCookie();
          const devCookie = devCookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
          expect(devCookie).toContain("HttpOnly");
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookies).toContainEqual(
            expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
          );
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
        }),
      ([environmentA, environmentB]) =>
        Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
