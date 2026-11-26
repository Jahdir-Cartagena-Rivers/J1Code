import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
  EnvironmentId,
} from "@j1code/contracts";
import {
  RelayEnvironmentLinkProofPayload,
  RelayEnvironmentHealthResponseProofPayload,
  RelayEnvironmentMintResponseProofPayload,
  type RelayManagedEndpointRuntimeConfig,
  type RelayLinkProofRequest,
} from "@j1code/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Generate the disposable relay key.
import * as NativeCrypto from "node:crypto";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse, HttpServer } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as NetAddress from "effect/net/NetAddress";
import {
  decodeRelayJwt,
  RELAY_HEALTH_REQUEST_TYP,
  RELAY_HEALTH_RESPONSE_TYP,
  RELAY_LINK_PROOF_TYP,
  RELAY_MINT_REQUEST_TYP,
  RELAY_MINT_RESPONSE_TYP,
  signRelayJwt,
  verifyRelayJwt,
} from "@j1code/shared/relayJwt";

import * as EnvironmentKeys from "./environmentKeys.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import * as CloudLink from "./CloudLink.ts";
import * as ConnectHttp from "./http.ts";
import * as ConnectReachability from "./ConnectReachability.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";

const DESKTOP_BOOTSTRAP_TOKEN = "test-desktop-bootstrap-token";
const NON_LOOPBACK_ORIGIN = "http://172.24.162.233:3773";
const LOOPBACK_ORIGIN = "http://127.0.0.1:3773";
const proofRequest: RelayLinkProofRequest = {
  challenge: "test-challenge",
  relayIssuer: "https://relay.example.test",
  endpoint: {
    providerKind: "cloudflare_tunnel",
    httpBaseUrl: "https://environment.example.test",
    wsBaseUrl: "wss://environment.example.test",
  },
  origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
};
const decodeLinkProofPayload = Schema.decodeUnknownEffect(RelayEnvironmentLinkProofPayload);

class LinkProofTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.auth,
  EnvironmentHttpApi.groups.connect,
) {}

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "desktop" as const,
      host: "0.0.0.0",
      port: 3773,
      desktopBootstrapToken: DESKTOP_BOOTSTRAP_TOKEN,
    };
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-link-proof-test-" })));

// Real credential issuance, verification, origin checks and signing; no relay or tunnel is started.
const makeLinkProofRoutes = (input: {
  readonly requestCatchUp: () => Effect.Effect<void>;
  readonly applyConfig: ManagedEndpointRuntime.CloudManagedEndpointRuntime["Service"]["applyConfig"];
  readonly requestRecovery: ManagedEndpointRuntime.CloudManagedEndpointRuntime["Service"]["requestRecovery"];
  readonly relayClient: HttpClient.HttpClient;
}) =>
  HttpApiBuilder.layer(LinkProofTestApi).pipe(
    Layer.provide([AuthHttp.layer, ConnectHttp.layer]),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provide(CloudLink.layer),
    Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
    Layer.provide(EnvironmentKeys.layer),
    Layer.provide(
      Layer.mock(ConnectReachability.ConnectReachability)({ latest: Effect.succeedNone }),
    ),
    Layer.provide(EnvironmentAuth.layer),
    Layer.provide([
      ManagedPolicy.layerTest(),
      SqlitePersistence.layerMemory,
      ServerEnvironment.layerIdentity,
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("wsl-environment")),
        getDescriptor: Effect.succeed({
          environmentId: EnvironmentId.make("wsl-environment"),
          label: "WSL",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(ManagedEndpointRuntime.CloudManagedEndpointRuntime)({
        applyConfig: input.applyConfig,
        requestRecovery: input.requestRecovery,
        inspectConnector: Effect.succeed(null),
        withLinkStateLock: (effect) => effect,
      }),
      Layer.mock(CliTokenManager.CloudCliTokenManager)({}),
      Layer.mock(AgentAwarenessRelay.AgentAwarenessRelay)({ requestCatchUp: input.requestCatchUp }),
      Layer.mock(HttpServer.HttpServer)({
        address: NetAddress.inetAddressFromIpStringUnsafe("0.0.0.0", 3773),
      }),
      Layer.succeed(HttpClient.HttpClient, input.relayClient),
    ]),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(layerConfig),
    Layer.provideMerge(HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak))),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const responseJson = (response: Response) => Effect.promise(() => response.json());

// Scoped: the web handler and its layer are disposed when the test's scope closes.
const makeConnectClient = (
  managedRelay?: (url: string) => Response,
  runtimeFailure?: string,
) =>
  Effect.gen(function* () {
    let catchUps = 0;
    const runtimeConfigs: Array<RelayManagedEndpointRuntimeConfig | null> = [];
    const recoveryConfigs: Array<RelayManagedEndpointRuntimeConfig> = [];
    const routes = makeLinkProofRoutes({
      requestCatchUp: () => Effect.sync(() => {
        catchUps++;
      }),
      applyConfig: (config) => Effect.sync(() => {
        runtimeConfigs.push(config);
        if (config === null) return { status: "disabled" };
        if (runtimeFailure) {
          return {
            status: "failed",
            providerKind: config.providerKind,
            failure: "not-installed",
            reason: runtimeFailure,
          };
        }
        return { status: "running", providerKind: "cloudflare_tunnel", pid: 123 };
      }),
      requestRecovery: (config) => Effect.sync(() => {
        recoveryConfigs.push(config);
      }),
      relayClient: HttpClient.make((request, url) =>
        managedRelay
          ? Effect.sync(() => HttpClientResponse.fromWeb(request, managedRelay(url.href)))
          : Effect.die("Unexpected relay call"),
      ),
    });
    const { handler } = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      (web) => Effect.promise(() => web.dispose()),
    );
    const post = (
      path: string,
      payload: unknown,
      headers?: Record<string, string>,
      origin = NON_LOOPBACK_ORIGIN,
    ) =>
      Effect.promise(() =>
        handler(
          new Request(`${origin}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(payload),
          }),
        ),
      );
    const exchange = Effect.fnUntraced(function* (credential: string, scope?: string) {
      const response = yield* Effect.promise(() =>
        handler(
          new Request(`${NON_LOOPBACK_ORIGIN}/oauth/token`, {
            method: "POST",
            body: new URLSearchParams({
              grant_type: AuthTokenExchangeGrantType,
              subject_token: credential,
              subject_token_type: AuthEnvironmentBootstrapTokenType,
              requested_token_type: AuthAccessTokenType,
              ...(scope ? { scope } : {}),
            }),
          }),
        ),
      );
      expect(response.status).toBe(200);
      const payload = (yield* responseJson(response)) as { access_token: string };
      return payload.access_token;
    });
    const readLinkState = (token: string, origin = NON_LOOPBACK_ORIGIN) =>
      Effect.promise(() =>
        handler(
          new Request(`${origin}/api/connect/link-state`, {
            headers: { authorization: `Bearer ${token}` },
          }),
        ),
      );
    const linkableHere = (token: string, origin = NON_LOOPBACK_ORIGIN) =>
      readLinkState(token, origin).pipe(
        Effect.flatMap(responseJson),
        Effect.map((state) => (state as { linkableHere?: boolean }).linkableHere),
      );
    return {
      post, exchange, readLinkState, linkableHere, runtimeConfigs, recoveryConfigs,
      catchUpCount: () => catchUps,
    };
  });

const linkProofClient = makeConnectClient();

const CLOUD_RELAY_ISSUER = "https://issuer.example.test";
const CLOUD_ACCOUNT = "fixture-cloud-owner";
const makeRelayKey = () =>
  NativeCrypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { format: "pem", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
  });
const relayConfig = (publicKey: string) => ({
  relayUrl: "https://transport.example.test",
  relayIssuer: CLOUD_RELAY_ISSUER,
  cloudUserId: CLOUD_ACCOUNT,
  environmentCredential: "fixture-private-relay-credential",
  cloudMintPublicKey: publicKey,
  endpointRuntime: null,
});
const managedRuntime = {
  providerKind: "cloudflare_tunnel",
  tunnelId: "fixture-tunnel",
  tunnelName: "fixture-tunnel-name",
  connectorToken: "fixture-tunnel-token",
} satisfies RelayManagedEndpointRuntimeConfig;

describe("link proof over a non-loopback desktop transport", () => {
  it.effect(
    "signs a loopback tunnel origin after desktop bootstrap token exchange over a non-loopback host",
    () =>
      Effect.gen(function* () {
        const { post, exchange } = yield* linkProofClient;
        const token = yield* exchange(DESKTOP_BOOTSTRAP_TOKEN);
        const response = yield* post("/api/connect/link-proof", proofRequest, {
          authorization: `Bearer ${token}`,
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const proof = (yield* responseJson(response)) as string;
        const unverified = yield* decodeRelayJwt(proof).pipe(
          Effect.flatMap(decodeLinkProofPayload),
        );
        yield* TestClock.setTime(unverified.iat * 1_000);
        const verify = (audience: string) =>
          verifyRelayJwt(RelayEnvironmentLinkProofPayload, {
            publicKey: unverified.environmentPublicKey,
            token: proof,
            typ: RELAY_LINK_PROOF_TYP,
            issuer: "t3-env:wsl-environment",
            audience,
          });
        const verified = yield* verify(proofRequest.relayIssuer);
        expect(verified).toMatchObject({
          origin: proofRequest.origin,
          endpoint: proofRequest.endpoint,
          challenge: proofRequest.challenge,
          environmentId: "wsl-environment",
          sub: "wsl-environment",
          scopes: ["agent_activity_notifications", "managed_tunnels"],
          descriptor: { environmentId: "wsl-environment" },
        });
        expect((yield* verify("https://foreign-relay.example.test").pipe(Effect.flip))._tag)
          .toBe("RelayJwtError");
        yield* TestClock.setTime((unverified.exp + 120) * 1_000);
        expect((yield* verify(proofRequest.relayIssuer).pipe(Effect.flip))._tag)
          .toBe("RelayJwtError");
      }).pipe(Effect.provide(NodeCrypto.layerSignature)),
  );

  it.effect(
    "does not pass desktop trust to a paired client or accept client-supplied provenance",
    () =>
      Effect.gen(function* () {
        const { post, exchange, linkableHere } = yield* linkProofClient;
        const desktop = yield* exchange(DESKTOP_BOOTSTRAP_TOKEN);
        const paired = yield* post(
          "/api/auth/pairing-token",
          {
            scopes: ["relay:read", "relay:write"],
            label: "desktop-bootstrap",
            subject: "desktop-bootstrap",
          },
          { authorization: `Bearer ${desktop}` },
        );
        expect(paired.status).toBe(200);
        const { credential } = (yield* responseJson(paired)) as { credential: string };
        const token = yield* exchange(credential);
        const headers = { authorization: `Bearer ${token}`, "x-desktop-bootstrap": "true" };
        const payload = {
          ...proofRequest,
          allowNonLoopbackRequestHost: true,
          subject: "desktop-bootstrap",
        };
        const rejected = yield* post("/api/connect/link-proof", payload, headers);
        expect(rejected.status).toBe(400);
        expect(yield* responseJson(rejected)).toMatchObject({
          message: "Invalid managed endpoint origin.",
        });
        const loopback = yield* post(
          "/api/connect/link-proof",
          proofRequest,
          headers,
          LOOPBACK_ORIGIN,
        );
        expect(loopback.status).toBe(200);
        // Clients offer Turn on only to the desktop's own session; SSH forwards look like loopback.
        expect(yield* linkableHere(desktop)).toBe(true);
        expect(yield* linkableHere(token)).toBe(false);
        expect(yield* linkableHere(token, LOOPBACK_ORIGIN)).toBe(false);
      }),
  );

  it.effect.each([
    {
      name: "non-loopback tunnel origin",
      origin: { localHttpHost: "172.24.162.233", localHttpPort: 3773 },
      headers: {},
    },
    {
      name: "mismatched port",
      origin: { localHttpHost: "127.0.0.1", localHttpPort: 3774 },
      headers: {},
    },
    {
      name: "forwarded host",
      origin: proofRequest.origin,
      headers: { "x-forwarded-host": "127.0.0.1:3773" },
    },
    {
      name: "malformed forwarded host",
      origin: proofRequest.origin,
      headers: { "x-forwarded-host": "invalid fixture host", "x-forwarded-proto": "https" },
    },
    {
      name: "forwarded protocol",
      origin: proofRequest.origin,
      headers: { "x-forwarded-proto": "http" },
    },
  ])("rejects $name even for desktop bootstrap", ({ origin, headers }) =>
    Effect.gen(function* () {
      const { post, exchange } = yield* linkProofClient;
      const token = yield* exchange(DESKTOP_BOOTSTRAP_TOKEN);
      const response = yield* post(
        "/api/connect/link-proof",
        { ...proofRequest, origin },
        { ...headers, authorization: `Bearer ${token}` },
      );
      expect(response.status).toBe(400);
      expect(yield* responseJson(response)).toMatchObject({
        _tag: "EnvironmentHttpBadRequestError",
        message: "Invalid managed endpoint origin.",
      });
    }),
  );

  it.effect("rejects unsupported proof providers and accepts the supported neighbor", () =>
    Effect.gen(function* () {
      const { post, exchange } = yield* linkProofClient;
      const token = yield* exchange(DESKTOP_BOOTSTRAP_TOKEN);
      const headers = { authorization: `Bearer ${token}` };
      const refused = yield* post("/api/connect/link-proof", {
        ...proofRequest,
        endpoint: { ...proofRequest.endpoint, providerKind: "t3_relay" },
      }, headers, LOOPBACK_ORIGIN);
      expect(refused.status).toBe(400);
      expect(yield* responseJson(refused)).toMatchObject({
        _tag: "EnvironmentHttpBadRequestError",
        message: "Invalid managed endpoint origin.",
      });
      const manual = yield* post("/api/connect/link-proof", {
        ...proofRequest,
        endpoint: { ...proofRequest.endpoint, providerKind: "manual" },
      }, headers, LOOPBACK_ORIGIN);
      expect(manual.status).toBe(200);
      const proof = (yield* responseJson(manual)) as string;
      const claims = yield* decodeRelayJwt(proof).pipe(Effect.flatMap(decodeLinkProofPayload));
      expect(claims.scopes).toEqual(["agent_activity_notifications"]);
    }),
  );

  it.effect("requires relay-write scope even for desktop bootstrap", () =>
    Effect.gen(function* () {
      const { post, exchange } = yield* linkProofClient;
      const token = yield* exchange(DESKTOP_BOOTSTRAP_TOKEN, "relay:read");
      const response = yield* post("/api/connect/link-proof", proofRequest, {
        authorization: `Bearer ${token}`,
      });
      expect(response.status).toBe(403);
      expect(yield* responseJson(response)).toMatchObject({
        code: "insufficient_scope",
        requiredScope: "relay:write",
      });
    }),
  );

  it.effect("protects relay settings and keeps the authorized account healthy", () =>
    Effect.gen(function* () {
      const { post, exchange, readLinkState, catchUpCount } = yield* linkProofClient;
      const owner = yield* exchange(DESKTOP_BOOTSTRAP_TOKEN);
      const ownerHeaders = { authorization: `Bearer ${owner}` };
      const pair = yield* post("/api/auth/pairing-token", { scopes: ["relay:read"] }, ownerHeaders);
      expect(pair.status).toBe(200);
      const { credential } = (yield* responseJson(pair)) as { credential: string };
      const reader = yield* exchange(credential);
      const readerHeaders = { authorization: `Bearer ${reader}` };
      const initial = yield* readLinkState(reader);
      expect(initial.status).toBe(200);
      expect(yield* responseJson(initial)).toMatchObject({
        linked: false,
        publishAgentActivity: false,
        linkableHere: false,
      });

      const config = relayConfig(makeRelayKey().publicKey);
      const relayPath = "/api/connect/relay-config";
      const preferencesPath = "/api/connect/preferences";
      for (const [path, payload] of [
        [relayPath, config],
        [preferencesPath, { publishAgentActivity: true }],
      ] as const) {
        const denied = yield* post(path, payload, readerHeaders);
        expect(denied.status).toBe(403);
        expect(yield* responseJson(denied)).toMatchObject({
          _tag: "EnvironmentScopeRequiredError",
          requiredScope: "relay:write",
        });
      }

      for (const [patch, message] of [
        [{ relayUrl: "http://relay.example.test" }, "Relay URL must be a secure absolute HTTPS URL."],
        [{ relayUrl: "https://relay.example.test/path" }, "Relay URL must be a secure absolute HTTPS URL."],
        [{ relayIssuer: "http://issuer.example.test" }, "Relay issuer must be a secure absolute HTTPS URL."],
        [{ environmentCredential: "   " }, "Relay environment credential is required."],
        [{ cloudMintPublicKey: "invalid fixture key" }, "Cloud mint public key must be a valid Ed25519 public key."],
      ] as const) {
        const refused = yield* post(relayPath, { ...config, ...patch }, ownerHeaders);
        expect(refused.status).toBe(400);
        expect(yield* responseJson(refused)).toMatchObject({
          _tag: "EnvironmentHttpBadRequestError",
          message,
        });
      }
      expect(catchUpCount()).toBe(0);
      expect(yield* responseJson(yield* readLinkState(reader))).toMatchObject({ linked: false });

      const linked = yield* post(relayPath, config, ownerHeaders);
      expect(linked.status).toBe(200);
      expect(yield* responseJson(linked)).toMatchObject({
        ok: true,
        endpointRuntimeStatus: { status: "disabled" },
      });
      expect(catchUpCount()).toBe(1);
      const foreign = yield* post(relayPath, {
        ...config,
        cloudUserId: "different-fixture-account",
        relayUrl: "https://different-relay.example.test",
      }, ownerHeaders);
      expect(foreign.status).toBe(409);
      expect(yield* responseJson(foreign)).toMatchObject({ _tag: "EnvironmentHttpConflictError" });
      expect(catchUpCount()).toBe(1);

      const preferences = yield* post(preferencesPath, { publishAgentActivity: true }, ownerHeaders);
      expect(preferences.status).toBe(200);
      expect(yield* responseJson(preferences)).toMatchObject({ publishAgentActivity: true });
      expect(catchUpCount()).toBe(2);

      const current = yield* readLinkState(reader);
      expect(current.status).toBe(200);
      const publicState = yield* responseJson(current);
      expect(publicState).toMatchObject({
        linked: true,
        cloudUserId: config.cloudUserId,
        relayUrl: config.relayUrl,
        relayIssuer: config.relayIssuer,
        publishAgentActivity: true,
        managedTunnelActive: false,
        linkableHere: false,
      });
      expect(publicState).not.toHaveProperty("environmentCredential");
      expect(publicState).not.toHaveProperty("cloudMintPublicKey");
      expect(JSON.stringify(publicState)).not.toContain(config.environmentCredential);
    }),
  );

  it.effect("rejects unsupported runtime before persistence and unlinks managed state", () =>
    Effect.gen(function* () {
      const registrationUrls: string[] = [];
      const client = yield* makeConnectClient((url) => {
        registrationUrls.push(url);
        return Response.json({ status: "ready" });
      });
      const { post, exchange, readLinkState, runtimeConfigs, recoveryConfigs } = client;
      const owner = yield* exchange(DESKTOP_BOOTSTRAP_TOKEN);
      const headers = { authorization: `Bearer ${owner}` };
      const config = relayConfig(makeRelayKey().publicKey);
      const refused = yield* post("/api/connect/relay-config", {
        ...config,
        endpointRuntime: { ...managedRuntime, providerKind: "manual" },
      }, headers);
      expect(refused.status).toBe(503);
      expect(yield* responseJson(refused)).toMatchObject({
        _tag: "EnvironmentCloudEndpointUnavailableError",
        endpointRuntimeStatus: { status: "unsupported", providerKind: "manual" },
      });
      expect(runtimeConfigs).toEqual([]);
      expect(registrationUrls).toEqual([]);
      expect(yield* responseJson(yield* readLinkState(owner))).toMatchObject({
        linked: false,
        cloudUserId: null,
        managedTunnelActive: false,
      });

      const internal = yield* post("/api/connect/reconcile", {}, headers);
      expect(internal.status).toBe(404);
      const linked = yield* post("/api/connect/relay-config", {
        ...config, endpointRuntime: managedRuntime,
      }, headers);
      expect(linked.status).toBe(200);
      expect(yield* responseJson(linked)).toMatchObject({
        ok: true,
        endpointRuntimeStatus: { status: "running" },
      });
      expect(registrationUrls).toHaveLength(1);
      expect(new URL(registrationUrls[0] ?? "").origin).toBe(config.relayUrl);
      expect(yield* responseJson(yield* readLinkState(owner))).toMatchObject({
        linked: true,
        cloudUserId: config.cloudUserId,
        relayUrl: config.relayUrl,
        relayIssuer: config.relayIssuer,
        managedTunnelActive: true,
      });

      const pair = yield* post("/api/auth/pairing-token", { scopes: ["relay:read"] }, headers);
      expect(pair.status).toBe(200);
      const { credential } = (yield* responseJson(pair)) as { credential: string };
      const reader = yield* exchange(credential);
      const denied = yield* post("/api/connect/unlink", {}, { authorization: `Bearer ${reader}` });
      expect(denied.status).toBe(403);
      expect(yield* responseJson(denied)).toMatchObject({ requiredScope: "relay:write" });
      expect(runtimeConfigs).toEqual([null, managedRuntime]);

      const unlinked = yield* post("/api/connect/unlink", {}, headers);
      expect(unlinked.status).toBe(200);
      expect(yield* responseJson(unlinked)).toMatchObject({
        ok: true,
        endpointRuntimeStatus: { status: "disabled" },
      });
      const after = yield* readLinkState(reader);
      expect(after.status).toBe(200);
      expect(yield* responseJson(after)).toMatchObject({
        linked: false,
        cloudUserId: null,
        relayUrl: null,
        relayIssuer: null,
        managedTunnelActive: false,
        publishAgentActivity: false,
      });
      expect(runtimeConfigs).toEqual([null, managedRuntime, null]);
      expect(recoveryConfigs).toEqual([]);
    }),
  );

  it.effect.each(["relay-unavailable", "recovery-required", "runtime-failure"] as const)(
    "keeps registration and runtime state consistent when %s",
    (scenario) =>
      Effect.gen(function* () {
        let registrations = 0;
        const client = yield* makeConnectClient(() => {
          registrations++;
          return scenario === "relay-unavailable"
            ? new Response("unavailable", { status: 503 })
            : Response.json({ status: scenario === "recovery-required" ? "recovery_required" : "ready" });
        }, scenario === "runtime-failure" ? "fixture connector unavailable" : undefined);
        const owner = yield* client.exchange(DESKTOP_BOOTSTRAP_TOKEN);
        const headers = { authorization: `Bearer ${owner}` };
        const config = relayConfig(makeRelayKey().publicKey);
        const response = yield* client.post("/api/connect/relay-config", {
          ...config, endpointRuntime: managedRuntime,
        }, headers);
        if (scenario === "relay-unavailable") {
          expect(response.status).toBe(500);
          expect(yield* responseJson(response)).toMatchObject({ _tag: "EnvironmentHttpInternalServerError" });
          expect(registrations).toBe(3);
          expect(client.runtimeConfigs).toEqual([null]);
          expect(client.recoveryConfigs).toEqual([]);
        } else {
          expect(response.status).toBe(503);
          expect(yield* responseJson(response)).toMatchObject({
            _tag: "EnvironmentCloudEndpointUnavailableError",
            endpointRuntimeStatus: scenario === "recovery-required"
              ? { status: "disabled" }
              : { status: "failed", reason: "fixture connector unavailable" },
          });
          expect(registrations).toBe(1);
          expect(client.runtimeConfigs).toEqual(
            scenario === "recovery-required" ? [null] : [null, managedRuntime],
          );
          expect(client.recoveryConfigs).toEqual(scenario === "recovery-required" ? [managedRuntime] : []);
        }
      }),
  );

  // The in-process HTTP router owns its clock, so request proofs use wall time.
  it.live.each(["mint", "health"] as const)(
    "authenticates signed cloud %s requests and rejects invalid or replayed proofs",
    (operation) =>
      Effect.gen(function* () {
        const { post, exchange } = yield* linkProofClient;
        const relayKey = makeRelayKey();
        const config = relayConfig(relayKey.publicKey);
        const owner = yield* exchange(DESKTOP_BOOTSTRAP_TOKEN);
        const headers = { authorization: `Bearer ${owner}` };
        const linked = yield* post("/api/connect/relay-config", config, headers);
        expect(linked.status).toBe(200);

        const linkProofResponse = yield* post("/api/connect/link-proof", proofRequest, headers);
        expect(linkProofResponse.status).toBe(200);
        const linkProof = (yield* responseJson(linkProofResponse)) as string;
        const { environmentPublicKey } = yield* decodeRelayJwt(linkProof).pipe(
          Effect.flatMap(decodeLinkProofPayload),
        );

        const environmentId = "wsl-environment";
        const endpoint = operation === "mint"
          ? "/api/t3-connect/mint-credential"
          : "/api/t3-connect/health";
        const typ = operation === "mint" ? RELAY_MINT_REQUEST_TYP : RELAY_HEALTH_REQUEST_TYP;
        const scope = operation === "mint" ? "environment:connect" : "environment:status";
        const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
        const clientProofKeyThumbprint = "fixture-client-proof-key";
        const base = {
          iss: config.relayIssuer,
          aud: `t3-env:${environmentId}`,
          sub: config.cloudUserId,
          environmentId,
          iat,
          exp: iat + 120,
          scope: [scope],
          ...(operation === "mint" ? {
            clientProofKeyThumbprint,
            cnf: { jkt: clientProofKeyThumbprint },
          } : {}),
        };
        const proofFor = (
          id: string,
          patch: Record<string, unknown> = {},
        ) =>
          signRelayJwt({
            privateKey: relayKey.privateKey,
            typ,
            payload: { ...base, jti: `jti-${id}`, nonce: `nonce-${id}`, ...patch },
          });
        const reject = Effect.fnUntraced(function* (
          proof: string,
          status: 401 | 409,
        ) {
          const response = yield* post(endpoint, { proof });
          expect(response.status).toBe(status);
          expect(yield* responseJson(response)).toMatchObject(
            status === 401
              ? {
                  _tag: "EnvironmentHttpUnauthorizedError",
                  message: `Invalid cloud ${operation} request.`,
                }
              : {
                  _tag: "EnvironmentHttpConflictError",
                  message: `Cloud ${operation} request was already consumed.`,
                },
          );
        });

        const invalid = [
          { iss: config.relayUrl },
          { aud: "t3-env:foreign-environment" },
          { environmentId: "foreign-environment" },
          { sub: "foreign-cloud-account" },
          { scope: [scope, scope] },
          { iat: iat - 600, exp: iat - 480 },
          ...(operation === "mint" ? [{ cnf: { jkt: "different-fixture-key" } }] : []),
        ];
        for (const [index, patch] of invalid.entries()) {
          yield* reject(yield* proofFor(`invalid-${index}`, patch), 401);
        }
        yield* reject("not-a-cloud-proof", 401);

        const acceptedProof = yield* proofFor("accepted");
        const accepted = yield* post(endpoint, { proof: acceptedProof });
        expect(accepted.status).toBe(200);
        expect(accepted.headers.get("cache-control")).toBe("no-store");
        const response = (yield* responseJson(accepted)) as Record<string, unknown> & { proof: string };
        const verifiedInput = {
          publicKey: environmentPublicKey,
          token: response.proof,
          issuer: `t3-env:${environmentId}`,
          audience: config.relayIssuer,
        };
        if (operation === "mint") {
          expect(response.credential).toEqual(expect.any(String));
          const claims = yield* verifyRelayJwt(RelayEnvironmentMintResponseProofPayload, {
            ...verifiedInput,
            typ: RELAY_MINT_RESPONSE_TYP,
          });
          expect(claims).toMatchObject({
            environmentId,
            requestNonce: "nonce-accepted",
            clientProofKeyThumbprint,
            credential: response.credential,
          });
        } else {
          expect(response).toMatchObject({ status: "online", descriptor: { environmentId } });
          const claims = yield* verifyRelayJwt(RelayEnvironmentHealthResponseProofPayload, {
            ...verifiedInput,
            typ: RELAY_HEALTH_RESPONSE_TYP,
          });
          expect(claims).toMatchObject({
            environmentId,
            requestNonce: "nonce-accepted",
            status: "online",
            descriptor: { environmentId },
            checkedAt: response.checkedAt,
          });
        }

        yield* reject(acceptedProof, 409);
        yield* reject(yield* proofFor("duplicate-jti", { jti: "jti-accepted" }), 409);
        yield* reject(yield* proofFor("duplicate-nonce", { nonce: "nonce-accepted" }), 409);
        const neighbor = yield* post(endpoint, { proof: yield* proofFor("neighbor") });
        expect(neighbor.status).toBe(200);
      }).pipe(Effect.provide(NodeCrypto.layerSignature)),
  );

  it.effect("rejects unauthenticated requests", () =>
    Effect.gen(function* () {
      const { post } = yield* linkProofClient;
      const response = yield* post("/api/connect/link-proof", proofRequest);
      expect(response.status).toBe(401);
    }),
  );
});
