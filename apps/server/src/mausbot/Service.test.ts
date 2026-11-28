import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type AuthClientSession,
} from "@j1code/contracts";
import { HostProcessPlatform } from "@j1code/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { expect, vi } from "vite-plus/test";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { SessionStore } from "../auth/SessionStore.ts";
import { ServerConfig } from "../config.ts";
import { ExternalConversations } from "../conversations/ExternalConversations.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { MausbotExecutionHost } from "./ExecutionHost.ts";
import { MausbotRuntime } from "./Runtime.ts";
import { SAVED_APP_FILE_KEY_HEADER } from "./SavedAppFiles.ts";
import { MausbotService } from "./Service.ts";

vi.mock("./Resources.ts", () => ({
  resolveMausbotResources: async (resources: string) => resources,
}));

it.effect("reauthorizes paired settings and saved app requests against persisted sessions", () =>
  Effect.gen(function* () {
    const session: AuthClientSession = {
      sessionId: AuthSessionId.make("phone"),
      subject: "fixture",
      scopes: [AuthOrchestrationOperateScope, AuthAccessWriteScope, AuthSettingsWriteScope],
      method: "bearer-access-token",
      client: { deviceType: "mobile" },
      issuedAt: DateTime.makeUnsafe(0),
      expiresAt: DateTime.makeUnsafe(10_000),
      lastConnectedAt: null,
      connected: true,
      current: false,
    };
    const narrowed = { ...session, scopes: [AuthOrchestrationOperateScope, AuthAccessWriteScope] };
    let active: ReadonlyArray<AuthClientSession> = [session];
    let listActive = () => Effect.sync(() => active);
    const running = vi.spyOn(MausbotRuntime.prototype, "running", "get").mockReturnValue(true);
    const start = vi.spyOn(MausbotRuntime.prototype, "start");
    const forward = vi.spyOn(MausbotRuntime.prototype, "forward").mockImplementation(
      async (url, _method, _contentType, _body, _signal, _origin, _client, phone) =>
        new Response(null, {
          status: url === "/api/config?j1NamedCredential=1" && !phone ? 403 : 204,
        }),
    );
    const stop = vi.spyOn(MausbotRuntime.prototype, "stop").mockResolvedValue(undefined);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        running.mockRestore();
        start.mockRestore();
        forward.mockRestore();
        stop.mockRestore();
      }),
    );

    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      NodeCrypto.layerDigest,
      Layer.succeed(HostProcessPlatform, "linux"),
      Layer.effect(
        ServerConfig,
        Effect.map(ServerConfig, (config) => ({ ...config, mausbotResourcesPath: "fixture" })),
      ).pipe(
        Layer.provide(ServerConfig.layerTest("fixture", { prefix: "j1-maus-service-test-" })),
        Layer.provide(NodeServices.layer),
      ),
      Layer.mock(ServerSecretStore)({}),
      Layer.mock(ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        subscribeChanges: Effect.succeed(Stream.empty),
      }),
      Layer.succeed(MausbotExecutionHost, {
        call: async () => {
          throw new Error("Unexpected bot execution");
        },
        disconnect: async () => {},
      }),
      Layer.mock(SessionStore)({
        cookieName: "fixture-session",
        legacyCookieName: undefined,
        listActive: () => listActive(),
        streamChanges: Stream.empty,
      }),
      ExternalConversations.layer,
      Layer.mock(ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("fixture")),
      }),
    );
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const service = yield* MausbotService;
      const named = "/api/config?j1NamedCredential=1";
      for (const change of ["revoked", "narrowed", "unchanged"] as const) {
        active = [session];
        forward.mockClear();
        const entered = yield* Deferred.make<void>();
        const release = Promise.withResolvers<void>();
        start.mockImplementation(() => {
          Deferred.doneUnsafe(entered, Effect.void);
          return release.promise;
        });
        const opened = yield* service.open(session);
        const view = opened.relativeUrl.split("/")[4]!;
        const pending = yield* service
          .forward(named, "GET", undefined, undefined, view)
          .pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(entered);
        if (change === "revoked") active = [];
        if (change === "narrowed") active = [narrowed];
        release.resolve();
        const result = yield* Fiber.join(pending);

        if (change === "revoked") {
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: expect.stringContaining("expired"),
          });
          expect(forward).not.toHaveBeenCalled();
        } else if (change === "narrowed") {
          expect(result).toMatchObject({ _tag: "Success", success: { status: 403 } });
          expect(forward).not.toHaveBeenCalled();
          const ordinary = yield* service.forward("/api/bots", "GET", undefined, undefined, view);
          expect(ordinary.status).toBe(204);
          expect(forward).toHaveBeenCalledExactlyOnceWith(
            "/api/bots",
            "GET",
            undefined,
            undefined,
            expect.any(AbortSignal),
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
          );
        } else {
          expect(result).toMatchObject({ _tag: "Success", success: { status: 204 } });
          expect(forward).toHaveBeenCalledExactlyOnceWith(
            named,
            "GET",
            undefined,
            undefined,
            expect.any(AbortSignal),
            undefined,
            undefined,
            session.sessionId,
            undefined,
            undefined,
          );
        }
      }

      forward.mockClear();
      start.mockClear();
      const reading = yield* Deferred.make<void>();
      const finishRead = yield* Deferred.make<void>();
      listActive = () =>
        Deferred.succeed(reading, undefined).pipe(
          Effect.andThen(Deferred.await(finishRead)),
          Effect.as([session]),
        );
      const opened = yield* service.open({
        sessionId: session.sessionId,
        subject: session.subject,
        method: session.method,
        scopes: session.scopes,
      });
      const expired = yield* service
        .forward(named, "GET", undefined, undefined, opened.relativeUrl.split("/")[4]!)
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(reading);
      yield* TestClock.setTime(10_000);
      yield* Deferred.succeed(finishRead, undefined);
      expect(yield* Fiber.join(expired)).toMatchObject({
        _tag: "Failure",
        failure: expect.stringContaining("expired"),
      });
      expect(start).not.toHaveBeenCalled();
      expect(forward).not.toHaveBeenCalled();

      const fileToken = "a".repeat(43);
      const file = `/api/local-app-files/${fileToken}/page.js`;
      const document = "/api/local-apps/la_1234567890abcdef/app";
      yield* TestClock.setTime(1_000);
      listActive = () => Effect.succeed(active);
      const client = { ...session, scopes: [AuthOrchestrationOperateScope] };
      active = [client];
      start.mockResolvedValue(undefined);
      forward.mockImplementation(async (path) =>
        path === document
          ? new Response("{}", { headers: { [SAVED_APP_FILE_KEY_HEADER]: fileToken } })
          : new Response("a", { status: 206 }),
      );
      const savedAppView = (yield* service.open(client)).relativeUrl.split("/")[4]!;
      expect((yield* service.readSavedAppFile(file, "GET")).status).toBe(404);
      expect(start).not.toHaveBeenCalled();
      const page = yield* service.forward(document, "GET", undefined, undefined, savedAppView);
      expect(page.headers.has(SAVED_APP_FILE_KEY_HEADER)).toBe(false);
      expect((yield* service.readSavedAppFile(file, "POST")).status).toBe(404);
      expect((yield* service.readSavedAppFile(file, "GET", "bytes=0-0")).status).toBe(206);
      expect(forward).toHaveBeenLastCalledWith(
        file,
        "GET",
        undefined,
        undefined,
        expect.any(AbortSignal),
        undefined,
        client.sessionId,
        undefined,
        "bytes=0-0",
      );
      active = [];
      forward.mockClear();
      expect((yield* service.readSavedAppFile(file, "GET")).status).toBe(404);
      expect(forward).not.toHaveBeenCalled();
    }).pipe(Effect.provide(MausbotService.layer.pipe(Layer.provide(dependencies))));
  }),
);
