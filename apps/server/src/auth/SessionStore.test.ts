import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthStandardClientScopes, EnvironmentId } from "@j1code/contracts";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SessionStore from "./SessionStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as WorkspaceSessions from "./WorkspaceSessions.ts";
import { MausbotViewGrants } from "../mausbot/ViewGrants.ts";
import { base64UrlDecodeUtf8, base64UrlEncode } from "./utils.ts";
import * as PayloadSigner from "./PayloadSigner.ts";

const layerServerConfig = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        ...overrides,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-session-test-" })));

const layerServerEnvironment = (environmentId: EnvironmentId) =>
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(environmentId),
  });

const layerSessionStore = (
  overrides?: Partial<ServerConfig.ServerConfig["Service"]>,
  environmentId = EnvironmentId.make("test-environment"),
) =>
  SessionStore.layer.pipe(
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(layerServerEnvironment(environmentId)),
    Layer.provide(layerServerConfig(overrides)),
  );

const relaySessionInput = {
  subject: "managed-relay-bootstrap",
  method: "dpop-access-token",
  proofKeyThumbprint: "relay-proof-key",
  ttl: Duration.hours(1),
  client: { label: "Relay desktop", deviceType: "desktop" },
} as const;

const makeDiskSessionStoreLayer = Effect.fn("makeDiskSessionStoreLayer")(function* (
  baseDir: string,
  token?: string,
) {
  const devUrl = new URL("http://127.0.0.1:5173");
  const paths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl, {
    baseDirIsExplicit: true,
  });
  yield* ServerConfig.ensureServerDirectories(paths);
  const layerPersistence = SqlitePersistence.layerFromPath(paths.dbPath);
  return SessionStore.layer.pipe(
    Layer.provide(layerPersistence),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(layerServerEnvironment(EnvironmentId.make(baseDir))),
    Layer.provide(
      layerServerConfig({
        ...paths,
        baseDir,
        mode: "web",
        devUrl,
        ...(token === undefined ? {} : { devAuthToken: Redacted.make(token) }),
      }),
    ),
  );
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("SessionStore.layer", (it) => {
  it.effect.each(["revoke", "revokeAllExcept", "replace"] as const)(
    "invalidates every connection for a session on %s and leaves other sessions active",
    (operation) =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const owner = yield* sessions.issue({ subject: "owner" });
        const client = yield* sessions.issue(relaySessionInput);
        const ownerInvalidated = yield* Deferred.make<void>();
        yield* sessions
          .awaitInvalidation(owner.sessionId)
          .pipe(
            Effect.andThen(Deferred.succeed(ownerInvalidated, undefined)),
            Effect.forkScoped({ startImmediately: true }),
          );
        const first = yield* sessions
          .awaitInvalidation(client.sessionId, relaySessionInput.proofKeyThumbprint)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        const second = yield* sessions
          .awaitInvalidation(client.sessionId, relaySessionInput.proofKeyThumbprint)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        if (operation === "revoke") yield* sessions.revoke(client.sessionId);
        else if (operation === "revokeAllExcept") yield* sessions.revokeAllExcept(owner.sessionId);
        else yield* sessions.issue({ ...relaySessionInput, replaceSessionId: client.sessionId });
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(yield* Deferred.isDone(ownerInvalidated)).toBe(false);
        yield* sessions.awaitInvalidation(client.sessionId);
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect("expires a connected session at its credential deadline", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const client = yield* sessions.issue(relaySessionInput);
      yield* sessions.markConnected(client.sessionId);
      const invalidated = yield* Deferred.make<void>();
      const watcher = yield* sessions
        .awaitInvalidation(client.sessionId, relaySessionInput.proofKeyThumbprint)
        .pipe(
          Effect.andThen(Deferred.succeed(invalidated, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
      yield* TestClock.adjust(Duration.minutes(59));
      expect(yield* Deferred.isDone(invalidated)).toBe(false);
      yield* TestClock.adjust(Duration.minutes(1));
      yield* Fiber.join(watcher);
      yield* sessions.awaitInvalidation(client.sessionId);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect.each([
    { name: "a renewal for the same key", renewal: {}, closesAtMinute: 119 },
    {
      name: "a renewal for another key",
      renewal: { proofKeyThumbprint: "other-proof-key" },
      closesAtMinute: 60,
    },
    {
      name: "a renewal with fewer scopes",
      renewal: { scopes: ["orchestration:read"] as const },
      closesAtMinute: 60,
    },
    {
      name: "a renewal, until the original is revoked",
      renewal: {},
      closesAtMinute: 90,
      revoke: "original",
    },
    {
      name: "a renewal, until the renewal is revoked",
      renewal: {},
      closesAtMinute: 90,
      revoke: "renewal",
    },
  ] as const)("closes a DPoP socket at minute $closesAtMinute after $name", (testCase) =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const client = yield* sessions.issue(relaySessionInput);
      const invalidated = yield* Deferred.make<void>();
      const watcher = yield* sessions
        .awaitInvalidation(client.sessionId, relaySessionInput.proofKeyThumbprint)
        .pipe(
          Effect.andThen(Deferred.succeed(invalidated, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
      yield* TestClock.adjust(Duration.minutes(59));
      const renewal = yield* sessions.issue({ ...relaySessionInput, ...testCase.renewal });
      yield* TestClock.adjust(Duration.millis((testCase.closesAtMinute - 59) * 60_000 - 1));
      expect(yield* Deferred.isDone(invalidated)).toBe(false);
      yield* TestClock.adjust(Duration.millis(1));
      if ("revoke" in testCase) {
        yield* sessions.revoke(
          testCase.revoke === "original" ? client.sessionId : renewal.sessionId,
        );
      }
      yield* Fiber.join(watcher);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect("closes a DPoP socket when an earlier renewal in its chain is revoked", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const client = yield* sessions.issue(relaySessionInput);
      const invalidated = yield* Deferred.make<void>();
      const watcher = yield* sessions
        .awaitInvalidation(client.sessionId, relaySessionInput.proofKeyThumbprint)
        .pipe(
          Effect.andThen(Deferred.succeed(invalidated, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
      yield* TestClock.adjust(Duration.minutes(59));
      const first = yield* sessions.issue(relaySessionInput);
      yield* TestClock.adjust(Duration.minutes(59));
      yield* sessions.issue(relaySessionInput);
      // Past the first renewal's expiry, so the socket now follows the second.
      yield* TestClock.adjust(Duration.minutes(2));
      expect(yield* Deferred.isDone(invalidated)).toBe(false);
      yield* sessions.revoke(first.sessionId);
      yield* Fiber.join(watcher);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect("keeps a renewed DPoP socket when another socket on its expired session closes", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const client = yield* sessions.issue(relaySessionInput);
      yield* sessions.markConnected(client.sessionId);
      const invalidated = yield* Deferred.make<void>();
      const watcher = yield* sessions
        .awaitInvalidation(client.sessionId, relaySessionInput.proofKeyThumbprint)
        .pipe(
          Effect.andThen(Deferred.succeed(invalidated, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
      yield* TestClock.adjust(Duration.minutes(59));
      yield* sessions.issue(relaySessionInput);
      yield* TestClock.adjust(Duration.minutes(2));
      // An expired session that loses its last socket is reported as removed, not revoked.
      yield* sessions.markDisconnected(client.sessionId);
      yield* TestClock.adjust(Duration.millis(58 * 60_000 - 1));
      expect(yield* Deferred.isDone(invalidated)).toBe(false);
      yield* TestClock.adjust(Duration.millis(1));
      yield* Fiber.join(watcher);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect("keys remote cookies by environment identity instead of state directory", () =>
    Effect.gen(function* () {
      const cookieName = (stateDir: string, environmentId: EnvironmentId) =>
        Effect.gen(function* () {
          const sessions = yield* SessionStore.SessionStore;
          return sessions.cookieName;
        }).pipe(
          Effect.provide(
            layerSessionStore({ mode: "web", host: "192.168.1.50", stateDir }, environmentId),
          ),
        );

      const original = yield* cookieName("/srv/t3-one", EnvironmentId.make("environment-one"));
      const moved = yield* cookieName("/srv/t3-moved", EnvironmentId.make("environment-one"));
      const other = yield* cookieName("/srv/t3-one", EnvironmentId.make("environment-two"));

      expect(moved).toBe(original);
      expect(other).not.toBe(original);
    }),
  );

  it.effect("keeps reusable dev auth local across disk-backed stores and restarts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const baseA = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dev-auth-a-" });
      const baseB = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dev-auth-b-" });
      const layerA = yield* makeDiskSessionStoreLayer(baseA, token);
      const fromA = yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const dev = yield* sessions.verify(token);
        const local = yield* sessions.issue({ subject: "environment-a" });
        const ticket = yield* sessions.issueWebSocketToken(local.sessionId);
        yield* sessions.revoke(dev.sessionId);
        return { dev, local, ticket };
      }).pipe(Effect.provide(layerA), Effect.scoped);

      const layerB = yield* makeDiskSessionStoreLayer(baseB, token);
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const dev = yield* sessions.verify(token);
        expect(dev.sessionId).toBe(fromA.dev.sessionId);
        expect((yield* Effect.flip(sessions.verify(fromA.local.token)))._tag).toBe(
          "InvalidSessionTokenSignatureError",
        );
        expect((yield* Effect.flip(sessions.verifyWebSocketToken(fromA.ticket.token)))._tag).toBe(
          "InvalidWebSocketTokenSignatureError",
        );
      }).pipe(Effect.provide(layerB), Effect.scoped);

      const layerReopenedB = yield* makeDiskSessionStoreLayer(baseB, token);
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const dev = yield* sessions.verify(token);
        expect(dev.sessionId).toBe(fromA.dev.sessionId);
        const ticket = yield* sessions.issueWebSocketToken(dev.sessionId);
        expect((yield* sessions.verifyWebSocketToken(ticket.token)).sessionId).toBe(dev.sessionId);
      }).pipe(Effect.provide(layerReopenedB), Effect.scoped);

      const layerReopenedA = yield* makeDiskSessionStoreLayer(baseA, token);
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        expect((yield* Effect.flip(sessions.verify(token)))._tag).toBe("SessionTokenRevokedError");
      }).pipe(Effect.provide(layerReopenedA), Effect.scoped);
    }),
  );

  it.effect("invalidates old dev credentials and tickets after rotation or removal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dev-auth-rotation-" });
      const oldToken = "old-reusable-dev-auth-token-that-is-long-enough";
      const newToken = "new-reusable-dev-auth-token-that-is-long-enough";
      const layerInitial = yield* makeDiskSessionStoreLayer(baseDir, oldToken);
      const old = yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const dev = yield* sessions.verify(oldToken);
        const ticket = yield* sessions.issueWebSocketToken(dev.sessionId);
        return { dev, ticket };
      }).pipe(Effect.provide(layerInitial), Effect.scoped);

      const layerRotated = yield* makeDiskSessionStoreLayer(baseDir, newToken);
      const rotated = yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        expect((yield* Effect.flip(sessions.verify(oldToken)))._tag).toBe(
          "MalformedSessionTokenError",
        );
        expect((yield* Effect.flip(sessions.verifyWebSocketToken(old.ticket.token)))._tag).toBe(
          "UnknownWebSocketSessionError",
        );
        expect(
          (yield* sessions.listActive()).some((row) => row.sessionId === old.dev.sessionId),
        ).toBe(true);
        const dev = yield* sessions.verify(newToken);
        const ticket = yield* sessions.issueWebSocketToken(dev.sessionId);
        return { dev, ticket };
      }).pipe(Effect.provide(layerRotated), Effect.scoped);

      const layerRemoved = yield* makeDiskSessionStoreLayer(baseDir);
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        expect((yield* Effect.flip(sessions.verify(newToken)))._tag).toBe(
          "MalformedSessionTokenError",
        );
        expect((yield* Effect.flip(sessions.verifyWebSocketToken(rotated.ticket.token)))._tag).toBe(
          "UnknownWebSocketSessionError",
        );
        expect(
          (yield* sessions.listActive()).some((row) => row.sessionId === rotated.dev.sessionId),
        ).toBe(true);
      }).pipe(Effect.provide(layerRemoved), Effect.scoped);
    }),
  );

  it.effect("carries a runtime-mode ceiling only on sessions issued with one", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const capped = yield* sessions.issue({
        subject: "mcp-client",
        method: "bearer-access-token",
        runtimeModeCeiling: "auto",
      });
      const uncapped = yield* sessions.issue({ method: "bearer-access-token" });

      expect((yield* sessions.verify(capped.token)).runtimeModeCeiling).toBe("auto");
      expect((yield* sessions.verify(uncapped.token)).runtimeModeCeiling).toBeUndefined();
    }).pipe(Effect.provide(layerSessionStore())),
  );
  it.effect("takes scopes from the session record", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const legacyScopes = ["orchestration:read", "terminal:operate", "review:write"] as const;
      const issued = yield* sessions.issue({ subject: "one-time-token", scopes: legacyScopes });
      const [encodedPayload] = issued.token.split(".");
      const currentClaims = base64UrlDecodeUtf8(encodedPayload!);
      expect(currentClaims).toContain('"v":1');
      const signer = yield* PayloadSigner.fromSecret(
        yield* secrets.getOrCreateRandom("server-signing-key", 32),
      );
      const resign = (claims: string) => {
        const payload = base64UrlEncode(claims);
        return signer.sign(payload).pipe(Effect.map((signature) => `${payload}.${signature}`));
      };
      const legacyToken = yield* resign(currentClaims.replace('"v":1', '"v":2'));
      const editedToken = yield* resign(
        currentClaims.replace(/"scopes":\[[^\]]*\]/, '"scopes":["access:write"]'),
      );

      expect((yield* sessions.verify(issued.token)).scopes).toEqual(legacyScopes);
      expect((yield* sessions.verify(legacyToken)).scopes).toEqual(legacyScopes);
      expect((yield* sessions.verify(editedToken)).scopes).toEqual(legacyScopes);
    }).pipe(
      Effect.provide(
        SessionStore.layer.pipe(
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provide(SqlitePersistence.layerMemory),
          Layer.provide(layerServerEnvironment(EnvironmentId.make("test-environment"))),
          Layer.provide(layerServerConfig()),
        ),
      ),
    ),
  );

  it.effect("atomically replaces active sessions with the same subject and method", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const browser = yield* sessions.issue({
        subject: "desktop-bootstrap",
        method: "browser-session-cookie",
      });
      const [firstBearer, secondBearer] = yield* Effect.all(
        [
          sessions.issue({
            subject: "desktop-bootstrap",
            method: "bearer-access-token",
            replaceActiveForSubjectAndMethod: true,
          }),
          sessions.issue({
            subject: "desktop-bootstrap",
            method: "bearer-access-token",
            replaceActiveForSubjectAndMethod: true,
          }),
        ],
        { concurrency: "unbounded" },
      );

      const active = yield* sessions.listActive();
      const bearerVerification = yield* Effect.all([
        sessions.verify(firstBearer.token).pipe(Effect.option),
        sessions.verify(secondBearer.token).pipe(Effect.option),
      ]);

      expect(active).toHaveLength(2);
      expect(active.find((entry) => entry.sessionId === browser.sessionId)).toBeDefined();
      expect(
        active.filter(
          (entry) =>
            entry.subject === "desktop-bootstrap" && entry.method === "bearer-access-token",
        ),
      ).toHaveLength(1);
      expect(bearerVerification.filter(Option.isSome)).toHaveLength(1);
    }).pipe(Effect.provide(layerSessionStore())),
  );

  it.effect("keeps the previous desktop session valid when replacement fails", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const sql = yield* SqlClient.SqlClient;
      const previous = yield* sessions.issue({
        subject: "desktop-bootstrap",
        method: "bearer-access-token",
      });
      yield* sql`
        CREATE TRIGGER reject_auth_session_insert BEFORE INSERT ON auth_sessions
        BEGIN
          SELECT RAISE(ABORT, 'simulated insert failure');
        END
      `;

      const error = yield* sessions
        .issue({
          subject: "desktop-bootstrap",
          method: "bearer-access-token",
          replaceActiveForSubjectAndMethod: true,
        })
        .pipe(Effect.flip);

      expect(error._tag).toBe("SessionCredentialIssueError");
      expect((yield* sessions.verify(previous.token)).sessionId).toBe(previous.sessionId);
      expect((yield* sessions.listActive()).map((session) => session.sessionId)).toEqual([
        previous.sessionId,
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(layerSessionStore(), SqlitePersistence.layerMemory))),
  );

  it.effect.each(["insert", "revoke"] as const)(
    "keeps existing browser sessions valid when replacement cannot %s",
    (operation) =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;
        const previous = yield* sessions.issue({ subject: "one-time-token" });
        const unrelated = yield* sessions.issue({ subject: "one-time-token" });
        if (operation === "insert") {
          yield* sql`
            CREATE TRIGGER reject_auth_session_insert BEFORE INSERT ON auth_sessions
            BEGIN
              SELECT RAISE(ABORT, 'simulated insert failure');
            END
          `;
        } else {
          yield* sql`
            CREATE TRIGGER reject_auth_session_revocation BEFORE UPDATE OF revoked_at ON auth_sessions
            BEGIN
              SELECT RAISE(ABORT, 'simulated revocation failure');
            END
          `;
        }

        const error = yield* sessions
          .issue({
            subject: "replacement-pairing",
            scopes: ["orchestration:read"],
            replaceSessionId: previous.sessionId,
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("SessionCredentialIssueError");
        expect((yield* sessions.verify(previous.token)).sessionId).toBe(previous.sessionId);
        expect((yield* sessions.verify(unrelated.token)).sessionId).toBe(unrelated.sessionId);
        expect((yield* sessions.listActive()).map((session) => session.sessionId).sort()).toEqual(
          [previous.sessionId, unrelated.sessionId].sort(),
        );
      }).pipe(Effect.provide(Layer.mergeAll(layerSessionStore(), SqlitePersistence.layerMemory))),
  );

  it.effect("rejects websocket tokens once the parent session has expired", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "short-lived",
        ttl: Duration.seconds(1),
      });
      const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);

      yield* TestClock.adjust(Duration.seconds(2));

      const error = yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token));
      expect(error._tag).toBe("WebSocketSessionExpiredError");
      if (error._tag === "WebSocketSessionExpiredError") {
        expect(error.sessionId).toBe(issued.sessionId);
        expect(error.expiresAt.epochMilliseconds).toBe(issued.expiresAt.epochMilliseconds);
        expect(error.observedAt.epochMilliseconds).toBeGreaterThan(
          error.expiresAt.epochMilliseconds,
        );
      }
    }).pipe(Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect("lists active sessions, tracks connectivity, and revokes other sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const administrative = yield* sessions.issue({
        subject: "desktop-bootstrap",
        scopes: ["orchestration:read", "access:write"],
        client: {
          label: "Desktop app",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
        },
      });
      const client = yield* sessions.issue({
        subject: "one-time-token",
        scopes: ["orchestration:read"],
        client: {
          label: "Julius iPhone",
          deviceType: "mobile",
          os: "iOS",
          browser: "Safari",
          ipAddress: "192.168.1.88",
        },
      });
      const clientWebSocket = yield* sessions.issueWebSocketToken(client.sessionId);

      yield* sessions.markConnected(client.sessionId);
      const beforeRevoke = yield* sessions.listActive();
      const revokedCount = yield* sessions.revokeAllExcept(administrative.sessionId);
      const afterRevoke = yield* sessions.listActive();
      const revokedClient = yield* Effect.flip(sessions.verify(client.token));
      const revokedClientWebSocket = yield* Effect.flip(
        sessions.verifyWebSocketToken(clientWebSocket.token),
      );

      expect(beforeRevoke).toHaveLength(2);
      expect(beforeRevoke.find((entry) => entry.sessionId === client.sessionId)?.connected).toBe(
        true,
      );
      expect(beforeRevoke.find((entry) => entry.sessionId === client.sessionId)?.client.label).toBe(
        "Julius iPhone",
      );
      expect(
        beforeRevoke.find((entry) => entry.sessionId === administrative.sessionId)?.client
          .deviceType,
      ).toBe("desktop");
      expect(revokedCount).toBe(1);
      expect(afterRevoke).toHaveLength(1);
      expect(afterRevoke[0]?.sessionId).toBe(administrative.sessionId);
      expect(revokedClient._tag).toBe("SessionTokenRevokedError");
      if (revokedClient._tag === "SessionTokenRevokedError") {
        expect(revokedClient.sessionId).toBe(client.sessionId);
        expect(revokedClient.revokedAt.epochMilliseconds).toBeGreaterThanOrEqual(0);
      }
      expect(revokedClientWebSocket._tag).toBe("WebSocketSessionRevokedError");
      if (revokedClientWebSocket._tag === "WebSocketSessionRevokedError") {
        expect(revokedClientWebSocket.sessionId).toBe(client.sessionId);
        expect(revokedClientWebSocket.revokedAt.epochMilliseconds).toBeGreaterThanOrEqual(0);
      }
    }).pipe(Effect.provide(layerSessionStore())),
  );
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("mobile workspace handoff", (it) => {
  it.effect("keeps DPoP parent permissions and revocation on the browser surface", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const parent = yield* sessions.issue({
        ...relaySessionInput,
        scopes: ["orchestration:read"],
        runtimeModeCeiling: "approval-required",
        peerLink: true,
      });
      const browser = yield* sessions.issueWorkspaceBrowserSession(parent.token);
      const verified = yield* sessions.verify(browser.sessionToken);
      expect(verified.sessionId).toBe(parent.sessionId);
      expect(verified.scopes).toEqual(["orchestration:read"]);
      expect(verified.method).toBe("browser-session-cookie");
      expect(verified.proofKeyThumbprint).toBeUndefined();
      expect(verified.runtimeModeCeiling).toBe("approval-required");
      expect(verified.peerLink).toBe(true);
      const ticket = yield* sessions.issueWebSocketToken(verified.sessionId, {
        audience: "rpc",
        ...(verified.runtimeModeCeiling ? { runtimeModeCeiling: verified.runtimeModeCeiling } : {}),
        ...(verified.peerLink === true ? { peerLink: true } : {}),
      });
      const verifiedTicket = yield* sessions.verifyWebSocketToken(ticket.token);
      expect(verifiedTicket.runtimeModeCeiling).toBe("approval-required");
      expect(verifiedTicket.peerLink).toBe(true);
      expect(verifiedTicket.scopes).toEqual(["orchestration:read"]);
      expect(verifiedTicket.audience).toBe("rpc");
      const neighbor = yield* sessions.issue();
      const unrestricted = yield* sessions.issueWebSocketToken(neighbor.sessionId);
      const verifiedUnrestricted = yield* sessions.verifyWebSocketToken(unrestricted.token);
      expect(verifiedUnrestricted.runtimeModeCeiling).toBeUndefined();
      expect(verifiedUnrestricted.peerLink).toBeUndefined();
      expect(yield* sessions.listActive()).toHaveLength(2);
      yield* sessions.revoke(parent.sessionId);
      expect((yield* Effect.result(sessions.verifyWebSocketToken(ticket.token)))._tag).toBe("Failure");
      expect((yield* sessions.verifyWebSocketToken(unrestricted.token)).sessionId).toBe(neighbor.sessionId);
      const rejected = yield* Effect.result(sessions.verify(browser.sessionToken));
      expect(rejected._tag).toBe("Failure");
    }).pipe(Effect.provide(layerSessionStore())),
  );

  it.effect("never extends the parent session lifetime", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const parent = yield* sessions.issue({ ttl: Duration.seconds(2) });
      const browser = yield* sessions.issueWorkspaceBrowserSession(parent.token);
      expect(browser.response.expiresAt.epochMilliseconds).toBe(parent.expiresAt.epochMilliseconds);
      yield* TestClock.adjust(Duration.seconds(3));
      expect((yield* Effect.result(sessions.verify(browser.sessionToken)))._tag).toBe("Failure");
    }).pipe(Effect.provide(layerSessionStore())),
  );

  it.effect("consumes handoffs once and rejects expired or revoked parents", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const workspace = yield* WorkspaceSessions.WorkspaceSessions;
      const parent = yield* sessions.issue(relaySessionInput);
      const once = yield* workspace.issue(parent.token);
      yield* workspace.redeem(once.credential);
      expect((yield* Effect.result(workspace.redeem(once.credential)))._tag).toBe("Failure");
      const expired = yield* workspace.issue(parent.token);
      yield* TestClock.adjust(Duration.seconds(61));
      expect((yield* Effect.result(workspace.redeem(expired.credential)))._tag).toBe("Failure");
      const revoked = yield* workspace.issue(parent.token);
      yield* sessions.revoke(parent.sessionId);
      expect((yield* Effect.result(workspace.redeem(revoked.credential)))._tag).toBe("Failure");
    }).pipe(
      Effect.provide(WorkspaceSessions.layer.pipe(Layer.provideMerge(layerSessionStore()))),
    ),
  );
});

it.effect(
  "rechecks Mausbot grants against a second disk-backed session store without local events",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mausbot-revoke-" });
      const serverLayer = yield* makeDiskSessionStoreLayer(baseDir);
      const cliLayer = yield* makeDiskSessionStoreLayer(baseDir);
      const paths = yield* ServerConfig.deriveServerPaths(
        baseDir,
        new URL("http://127.0.0.1:5173"),
        {
          baseDirIsExplicit: true,
        },
      );
      yield* Effect.gen(function* () {
        const server = yield* SessionStore.SessionStore;
        const owner = yield* server.issue();
        const neighbor = yield* server.issue();
        const grants = new MausbotViewGrants();
        yield* Effect.addFinalizer(() => Effect.sync(() => grants.clear()));
        const key = grants.issue(owner.sessionId, 0, Infinity, undefined, false).split("/")[4]!;
        const other = grants
          .issue(neighbor.sessionId, 0, Infinity, undefined, false)
          .split("/")[4]!;
        expect(grants.authorize(key, 1, yield* server.listActive())).toBe(true);
        const signal = grants.signal(key, 1)!;
        yield* Effect.gen(function* () {
          const cli = yield* SessionStore.SessionStore;
          expect(cli).not.toBe(server);
          expect(yield* cli.revoke(owner.sessionId)).toBe(true);
        }).pipe(Effect.provide(Layer.fresh(cliLayer)));
        expect(grants.authorize(key, 1, yield* server.listActive())).toBe(false);
        expect(signal.aborted).toBe(true);
        expect(() => grants.renew(key, owner.sessionId, 1)).toThrow("expired");
        expect(grants.authorize(other, 1, yield* server.listActive())).toBe(true);
        expect(grants.renew(other, neighbor.sessionId, 1)).toContain(other);
        for (const change of ["downgrade", "scope-removal", "expiry"] as const) {
          const changed = yield* server.issue({ scopes: AuthStandardClientScopes });
          if (change === "expiry") yield* server.markConnected(changed.sessionId);
          const changedKey = grants
            .issue(changed.sessionId, 0, Infinity, undefined, change === "downgrade")
            .split("/")[4]!;
          expect(grants.authorize(changedKey, 1, yield* server.listActive())).toBe(true);
          // A separate SQL connection models persisted edits without local PubSub events.
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            if (change === "expiry") {
              yield* sql`UPDATE auth_sessions SET expires_at = ${"1970-01-01T00:00:00.000Z"} WHERE session_id = ${changed.sessionId}`;
            } else {
              const scopes = change === "downgrade" ? '["orchestration:operate"]' : "[]";
              yield* sql`UPDATE auth_sessions SET scopes = ${scopes} WHERE session_id = ${changed.sessionId}`;
            }
          }).pipe(Effect.provide(SqlitePersistence.layerFromPath(paths.dbPath)));
          expect(grants.authorize(changedKey, 1, yield* server.listActive())).toBe(false);
          expect(() => grants.renew(changedKey, changed.sessionId, 1)).toThrow("expired");
          expect(grants.authorize(other, 1, yield* server.listActive())).toBe(true);
        }
      }).pipe(Effect.provide(serverLayer), Effect.scoped);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("retained credential regressions", (it) => {
  it.effect("keeps the reusable token active after normal sessions expire", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const normal = yield* sessions.issue({ subject: "normal-session" });

      yield* TestClock.adjust(Duration.days(31));

      expect((yield* sessions.verify(token)).subject).toBe("reusable-dev-token");
      expect((yield* Effect.flip(sessions.verify(normal.token)))._tag).toBe(
        "SessionTokenExpiredError",
      );
    }).pipe(
      Effect.provide(
        Layer.merge(
          layerSessionStore({
            mode: "web",
            devUrl: new URL("http://127.0.0.1:5173"),
            devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
          }),
          TestClock.layer(),
        ),
      ),
    ),
  );

  it.effect("issues and verifies signed browser session tokens", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        subject: "desktop-bootstrap",
        scopes: ["orchestration:read", "access:write"],
        client: {
          label: "Desktop app",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
          ipAddress: "127.0.0.1",
        },
      });
      const verified = yield* sessions.verify(issued.token);

      expect(verified.method).toBe("browser-session-cookie");
      expect(verified.subject).toBe("desktop-bootstrap");
      expect(verified.scopes).toEqual(["orchestration:read", "access:write"]);
      expect(verified.client.label).toBe("Desktop app");
      expect(verified.client.browser).toBe("Electron");
      expect(verified.expiresAt?.toString()).toBe(issued.expiresAt.toString());
    }).pipe(Effect.provide(layerSessionStore())),
  );
  it.effect("rejects malformed session tokens", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const error = yield* Effect.flip(sessions.verify("not-a-session-token"));

      expect(error._tag).toBe("MalformedSessionTokenError");
      expect(error.message).toContain("Malformed session token");
    }).pipe(Effect.provide(layerSessionStore())),
  );
  it.effect("verifies session tokens against the Effect clock", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "test-clock",
      });
      const verified = yield* sessions.verify(issued.token);

      expect(verified.method).toBe("bearer-access-token");
      expect(verified.subject).toBe("test-clock");
      expect(verified.scopes).toEqual(AuthStandardClientScopes);
    }).pipe(Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect("includes expiry context when session and websocket tokens expire", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "short-lived-token",
        ttl: Duration.seconds(1),
      });
      const websocket = yield* sessions.issueWebSocketToken(issued.sessionId, {
        ttl: Duration.seconds(1),
      });

      yield* TestClock.adjust(Duration.seconds(2));

      const sessionError = yield* Effect.flip(sessions.verify(issued.token));
      const websocketError = yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token));

      expect(sessionError._tag).toBe("SessionTokenExpiredError");
      if (sessionError._tag === "SessionTokenExpiredError") {
        expect(sessionError.sessionId).toBe(issued.sessionId);
        expect(sessionError.expiresAt.epochMilliseconds).toBe(issued.expiresAt.epochMilliseconds);
        expect(sessionError.observedAt.epochMilliseconds).toBeGreaterThan(
          sessionError.expiresAt.epochMilliseconds,
        );
      }
      expect(websocketError._tag).toBe("WebSocketTokenExpiredError");
      if (websocketError._tag === "WebSocketTokenExpiredError") {
        expect(websocketError.sessionId).toBe(issued.sessionId);
        expect(websocketError.expiresAt.epochMilliseconds).toBe(
          websocket.expiresAt.epochMilliseconds,
        );
        expect(websocketError.observedAt.epochMilliseconds).toBeGreaterThan(
          websocketError.expiresAt.epochMilliseconds,
        );
      }
    }).pipe(Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect("persists lastConnectedAt on first connect and updates it after reconnect", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        subject: "reconnect-test",
        method: "bearer-access-token",
      });

      const beforeConnect = yield* sessions.listActive();
      expect(beforeConnect[0]?.lastConnectedAt).toBeNull();

      yield* TestClock.adjust(Duration.seconds(1));
      yield* sessions.markConnected(issued.sessionId);
      const firstConnect = yield* sessions.listActive();
      const firstConnectedAt = firstConnect[0]?.lastConnectedAt;

      expect(firstConnect[0]?.connected).toBe(true);
      expect(firstConnectedAt).not.toBeNull();

      yield* TestClock.adjust(Duration.seconds(1));
      yield* sessions.markConnected(issued.sessionId);
      const stillConnected = yield* sessions.listActive();

      expect(stillConnected[0]?.lastConnectedAt?.toString()).toBe(firstConnectedAt?.toString());

      yield* sessions.markDisconnected(issued.sessionId);
      yield* sessions.markDisconnected(issued.sessionId);
      const afterDisconnect = yield* sessions.listActive();

      expect(afterDisconnect[0]?.connected).toBe(false);
      expect(afterDisconnect[0]?.lastConnectedAt?.toString()).toBe(firstConnectedAt?.toString());

      yield* TestClock.adjust(Duration.seconds(1));
      yield* sessions.markConnected(issued.sessionId);
      const afterReconnect = yield* sessions.listActive();

      expect(afterReconnect[0]?.connected).toBe(true);
      expect(afterReconnect[0]?.lastConnectedAt).not.toBeNull();
      expect(afterReconnect[0]?.lastConnectedAt?.toString()).not.toBe(firstConnectedAt?.toString());
    }).pipe(Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

});

// Current persistence and SessionStore no longer expose recordClientConnection or
// surface/appVersion columns. Restore the storage/API boundary before this case.
it.todo("records client connection metadata without clearing prior values");
// The old make export and repository-injection fixture were removed upstream.
// Keep these rejection requirements visible pending a current persistence fault fixture.
it.todo("preserves repository failures while verifying session and websocket credentials");
