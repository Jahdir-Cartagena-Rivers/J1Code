import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import type { Digest } from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { MausbotRuntime } from "./Runtime.ts";
import { resolveMausbotResources } from "./Resources.ts";
import { MausbotViewGrants } from "./ViewGrants.ts";
import {
  SAVED_APP_FILE_KEY_HEADER,
  savedAppDocumentPath,
  upstreamSavedAppFilePath,
} from "./SavedAppFiles.ts";
import { SessionStore } from "../auth/SessionStore.ts";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { AuthAccessWriteScope, AuthOrchestrationOperateScope } from "@j1code/contracts";
import type { MausbotApprovalModeInput } from "@j1code/contracts";
import { isMausbotDesktopSession } from "./DesktopTrust.ts";
import { MausbotHiveMemory } from "./HiveMemory.ts";
import { HostProcessPlatform } from "@j1code/shared/hostProcess";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ExternalConversations } from "../conversations/ExternalConversations.ts";
import { makeMausbotConversationSource } from "../conversations/MausbotConversationSource.ts";
import { MausbotConversationInvocation } from "@j1code/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { conversationCall } from "../conversations/query.ts";
import {
  MausbotRoutingInvocation,
  ExternalRouteSourceSnapshot,
  ExternalRouteDeliveryResult,
  ExternalRouteHostEvent,
  ExternalRouteTransportProof,
  type ConversationQuery,
} from "@j1code/contracts";
import { ExternalRouteEndpoints } from "../routing/ExternalRouteEndpoints.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as ProviderCredentialStore from "../provider/ProviderCredentialStore.ts";
import { makeDeepAIClient } from "../provider/deepai/DeepAIClient.ts";
import { deepAIMachineDigest } from "../provider/deepai/DeepAIMachine.ts";
import { resolveProviderInstanceEnabled } from "@j1code/contracts";
import { MausbotExecutionHost } from "./ExecutionHost.ts";

const decodeHostInvocation = Schema.decodeUnknownEffect(
  Schema.Union([MausbotConversationInvocation, MausbotRoutingInvocation, ExternalRouteHostEvent]),
);
const decodeRoutingSource = Schema.decodeUnknownEffect(Schema.NullOr(ExternalRouteSourceSnapshot));
const decodeRoutingEvent = Schema.decodeUnknownEffect(ExternalRouteHostEvent);
const decodeTransportProof = Schema.decodeUnknownEffect(Schema.NullOr(ExternalRouteTransportProof));
const decodeRoutingDeliveryResult = Schema.decodeUnknownEffect(ExternalRouteDeliveryResult);

export class MausbotService extends Context.Service<
  MausbotService,
  {
    readonly status: Effect.Effect<{ available: boolean; running: boolean }>;
    readonly forward: (
      path: string,
      method: string,
      contentType?: string,
      body?: Uint8Array,
      viewKey?: string,
    ) => Effect.Effect<Response, string>;
    readonly readSavedAppFile: (
      path: string,
      method: string,
      range?: string,
    ) => Effect.Effect<Response>;
    readonly stop: Effect.Effect<void, string>;
    readonly setApprovalMode: (
      session: AuthenticatedSession,
      input: MausbotApprovalModeInput,
    ) => Effect.Effect<unknown, string>;
    readonly open: (
      session: AuthenticatedSession,
      frameOrigin?: string,
      viewKey?: string,
    ) => Effect.Effect<{ relativeUrl: string }, string>;
    readonly authorizeView: (key: string) => Effect.Effect<boolean>;
  }
>()("@j1code/server/mausbot/Service/MausbotService") {
  static readonly layer = Layer.effect(
    MausbotService,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const platform = yield* HostProcessPlatform;
      const hostContext = yield* Effect.context<ServerSecretStore | Digest>();
      const runHost = Effect.runPromiseWith(hostContext);
      const deepAIClient = makeDeepAIClient({
        resolveMachineDigest: () => deepAIMachineDigest(platform),
      });
      const deepAICredentials = () =>
        runHost(
          Effect.gen(function* () {
            const current = yield* settings.getSettings;
            for (const [id, instance] of Object.entries(current.providerInstances).sort(
              ([a], [b]) => a.localeCompare(b),
            )) {
              if (instance.driver !== "deepai" || !resolveProviderInstanceEnabled(instance))
                continue;
              const store = yield* ProviderCredentialStore.make("deepai", id);
              const value = yield* store.get;
              if (Option.isSome(value)) return new TextDecoder().decode(value.value);
            }
            return yield* Effect.fail("Connect a DeepAI account in Model providers first.");
          }),
        );

      const path = yield* Path.Path;
      const settings = yield* ServerSettingsService;
      const execution = yield* MausbotExecutionHost;
      const sessions = yield* SessionStore;
      const conversations = yield* ExternalConversations;
      const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
      const effectContext = yield* Effect.context<never>();
      const externalRoutes = yield* Effect.serviceOption(ExternalRouteEndpoints);
      const handleConversation = Effect.fn("Mausbot.handleConversation")(function* (
        input: unknown,
        active: () => boolean,
      ) {
        const request = yield* decodeHostInvocation(input, {
          onExcessProperty: "error",
        });
        if (!active()) return yield* Effect.fail("Conversation runtime disconnected.");
        if (
          "kind" in request &&
          ["routingWake", "routeSourceCheck", "routeTransport", "routeFailed"].includes(
            request.kind,
          )
        ) {
          if (Option.isNone(externalRoutes)) return yield* Effect.fail("Routing unavailable.");
          const event = yield* decodeRoutingEvent(request);
          return event.kind === "routingWake"
            ? yield* externalRoutes.value.wake
            : yield* externalRoutes.value.receive(event);
        }
        if ("operation" in request) {
          if (Option.isNone(externalRoutes))
            return yield* Effect.fail("The routing adapter is unavailable.");
          const result = yield* externalRoutes.value.call(
            {
              kind: "mausbot",
              environmentId,
              botId: request.botId,
              threadId: request.threadId,
              generation: request.generation,
            },
            request.operation,
            request.arguments,
          );
          if (!active()) return yield* Effect.fail("Conversation runtime disconnected.");
          return result;
        }
        if (!("call" in request)) return yield* Effect.fail("Unsupported conversation operation.");
        const result = yield* conversationCall(
          conversations,
          {
            kind: "mausbot",
            environmentId,
            botId: request.botId,
            threadId: request.threadId,
            generation: request.generation,
          },
          request.call,
        );
        if (!active()) return yield* Effect.fail("Conversation runtime disconnected.");
        return result;
      });
      const run = Effect.runPromiseWith(effectContext);
      const grants = new MausbotViewGrants();
      const hiveMemory = new MausbotHiveMemory({
        file: path.join(config.stateDir, "hive-mind.json"),
        indexDir: path.join(config.stateDir, "mausbot-hive-index"),
      });
      yield* sessions.streamChanges.pipe(
        Stream.runForEach((change) =>
          Effect.sync(() => {
            if (change.type === "clientRemoved") grants.revoke(change.sessionId);
            else if (!change.clientSession.scopes.includes(AuthOrchestrationOperateScope))
              grants.revoke(change.clientSession.sessionId);
            else if (!change.clientSession.scopes.includes(AuthAccessWriteScope))
              grants.revokeAdministrative(change.clientSession.sessionId);
          }),
        ),
        Effect.forkScoped,
      );
      const gate = Semaphore.makeUnsafe(1);
      let runtime: MausbotRuntime | undefined;
      const browserExecutable = (value: string) => {
        const override = value.trim();
        return override.toLowerCase() === "disabled"
          ? ""
          : override || config.lightpandaExecutablePath || "";
      };
      const changes = yield* settings.subscribeChanges;
      yield* changes.pipe(
        Stream.runForEach((current) =>
          Effect.tryPromise({
            try: async () => {
              await runtime?.setBrowserExecutablePath(
                browserExecutable(current.lightpandaExecutablePath),
              );
            },
            catch: () => "Could not apply the assistant browser setting.",
          }).pipe(Effect.catch((message) => Effect.logWarning(message))),
        ),
        Effect.forkScoped,
      );
      const stop = Effect.tryPromise({
        try: async () => {
          grants.clear();
          await runtime?.stop();
        },
        catch: () => "Could not stop the assistant runtime.",
      });
      yield* Effect.addFinalizer(() => stop.pipe(Effect.ignore));
      const getRuntime = Effect.fn("Mausbot.runtime")(function* () {
        const resources = config.mausbotResourcesPath;
        if (!resources)
          return yield* Effect.fail("The Mausbot runtime is not bundled in this server build.");
        return yield* gate.withPermit(
          Effect.gen(function* () {
            if (runtime) return runtime;
            const expanded = yield* Effect.tryPromise({
              try: () =>
                resolveMausbotResources(resources, path.join(config.baseDir, "cache", "mausbot")),
              catch: (error) => String(error),
            }).pipe(
              Effect.tapError((error) =>
                Effect.logError("Assistant runtime verification failed", error),
              ),
              Effect.mapError(() => "The bundled assistant runtime failed verification."),
            );
            const current = yield* settings.getSettings.pipe(
              Effect.mapError(() => "Could not load browser settings."),
            );
            runtime = new MausbotRuntime({
              platform,
              deepAI: {
                client: deepAIClient,
                credentials: deepAICredentials,
                catalog: async (signal) => {
                  const key = await deepAICredentials();
                  const allowance = await deepAIClient.allowance(key, signal);
                  if (!allowance.enabled)
                    throw new Error("DeepAI is unavailable for this account.");
                  return deepAIClient.models(signal);
                },
              },
              resources: expanded,
              ...(config.devUrl && config.mausbotDevUiDir ? { uiDir: config.mausbotDevUiDir } : {}),
              ...(config.devUrl && config.mausbotDevServerDir
                ? { serverDir: config.mausbotDevServerDir }
                : {}),
              dataDir: path.join(config.baseDir, "userdata", "mausbot"),
              lightpandaExecutablePath: browserExecutable(current.lightpandaExecutablePath),
              memory: (input, active) => hiveMemory.handle(input, active),
              conversationCall: (input, active) => run(handleConversation(input, active)),
              execution,
            });
            return runtime;
          }),
        );
      });
      const removeSource = conversations.register(
        makeMausbotConversationSource(environmentId, (input) =>
          getRuntime().pipe(
            Effect.flatMap((child) =>
              Effect.tryPromise({
                try: (signal) => child.conversation(input, signal),
                catch: () => "The assistant conversation runtime is unavailable.",
              }),
            ),
          ),
        ),
      );
      yield* Effect.addFinalizer(() => Effect.sync(removeSource));
      if (Option.isSome(externalRoutes)) {
        const remove = externalRoutes.value.register({
          kind: "mausbot",
          accepts: (id) => id.startsWith("mausbot:"),
          proof: (key) =>
            getRuntime().pipe(
              Effect.flatMap((child) =>
                Effect.tryPromise({
                  try: (signal) =>
                    child.conversation({ action: "routeDeliveryStatus", key }, signal),
                  catch: () => "Native transport proof unavailable.",
                }),
              ),
              Effect.flatMap(decodeTransportProof),
              Effect.mapError(() => "Native transport proof unavailable."),
            ),
          deliver: (input) =>
            getRuntime().pipe(
              Effect.flatMap((child) =>
                Effect.tryPromise({
                  try: (signal) =>
                    child.conversation({ action: "routeDeliver", delivery: input }, signal),
                  catch: () => "Native route delivery was not confirmed.",
                }),
              ),
              Effect.flatMap(decodeRoutingDeliveryResult),
              Effect.mapError(() => "Native route delivery was not confirmed."),
            ),
          notice: (notice) =>
            getRuntime().pipe(
              Effect.flatMap((child) =>
                Effect.tryPromise({
                  try: (signal) => child.conversation({ action: "routeNotice", ...notice }, signal),
                  catch: () => "Could not publish the native routing notice.",
                }),
              ),
              Effect.asVoid,
            ),
          source: (id) => {
            const match = /^mausbot:([\w-]{1,120}):([\w-]{1,120})$/.exec(id);
            if (!match) return Effect.succeed(null);
            const input: ConversationQuery = {
              action: "routingSource",
              endpoint: { environmentId, projectId: `mausbot:${match[1]}`, threadId: id },
            };
            return getRuntime().pipe(
              Effect.flatMap((child) =>
                Effect.tryPromise({
                  try: (signal) => child.conversation(input, signal),
                  catch: () => "Native routing source is unavailable.",
                }),
              ),
              Effect.flatMap(decodeRoutingSource),
              Effect.mapError(() => "Native routing source is unavailable."),
            );
          },
        });
        yield* Effect.addFinalizer(() => Effect.sync(remove));
        yield* externalRoutes.value.wake;
      }
      const authorizeView = Effect.fnUntraced(function* (key: string) {
        const now = yield* Clock.currentTimeMillis;
        if (!grants.valid(key, now)) return undefined;
        // The CLI has its own SessionStore and cannot publish into this process's stream.
        const active = yield* sessions.listActive().pipe(Effect.orElseSucceed(() => []));
        if (!grants.authorize(key, yield* Clock.currentTimeMillis, active)) return undefined;
        return { pairedSettingsSession: grants.pairedSettingsSession(key, active) };
      });
      const expiredView = "This assistant window expired. Reopen it from J1.";
      const runtimeFailure = (error: unknown) =>
        error instanceof Error ? error.message : "The assistant runtime is unavailable.";
      const unavailableSavedAppFile = () =>
        new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
      const forward = Effect.fn("Mausbot.forward")(function* (
        url: string,
        method: string,
        contentType?: string,
        body?: Uint8Array,
        viewKey?: string,
      ) {
        let view = viewKey ? yield* authorizeView(viewKey) : undefined;
        if (viewKey && !view) return yield* Effect.fail(expiredView);
        const child = yield* getRuntime();
        const wasRunning = child.running;
        yield* Effect.tryPromise({ try: () => child.start(), catch: runtimeFailure });
        // start() can still await startup or a replacement while running is true.
        const namedSettings = url === "/api/config?j1NamedCredential=1";
        if (viewKey && (!wasRunning || namedSettings)) {
          view = yield* authorizeView(viewKey);
          if (!view) return yield* Effect.fail(expiredView);
        }
        if (namedSettings && !view?.pairedSettingsSession)
          return new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
        const signal = viewKey ? grants.signal(viewKey, yield* Clock.currentTimeMillis) : undefined;
        if (viewKey && !signal) return yield* Effect.fail(expiredView);
        const savedAppView =
          method === "GET" && savedAppDocumentPath.test(url.split("?")[0]!) ? viewKey : undefined;
        const response = yield* Effect.tryPromise({
          try: (requestSignal) =>
            child.forward(
              url,
              method,
              contentType,
              body,
              signal ? AbortSignal.any([signal, requestSignal]) : requestSignal,
              viewKey ? grants.frameOrigin(viewKey) : undefined,
              viewKey ? grants.clientSession(viewKey) : undefined,
              view?.pairedSettingsSession,
              undefined,
              savedAppView,
            ),
          catch: runtimeFailure,
        });
        const token = response.headers.get(SAVED_APP_FILE_KEY_HEADER);
        if (token !== null) {
          response.headers.delete(SAVED_APP_FILE_KEY_HEADER);
          if (viewKey && response.ok)
            grants.bindSavedAppFiles(token, viewKey, yield* Clock.currentTimeMillis);
        }
        return response;
      });
      const readSavedAppFile = Effect.fn("Mausbot.readSavedAppFile")(function* (
        path: string,
        method: string,
        range?: string,
      ) {
        const token = upstreamSavedAppFilePath.exec(path)?.[1];
        if (!token || !["GET", "HEAD", "OPTIONS"].includes(method)) {
          return unavailableSavedAppFile();
        }
        const key = grants.savedAppFileView(token, yield* Clock.currentTimeMillis);
        const child = runtime;
        if (!key || !child?.running || !(yield* authorizeView(key))) {
          return unavailableSavedAppFile();
        }
        const signal = grants.signal(key, yield* Clock.currentTimeMillis);
        if (!signal) return unavailableSavedAppFile();
        return yield* Effect.tryPromise({
          try: (requestSignal) =>
            child.forward(
              path,
              method,
              undefined,
              undefined,
              AbortSignal.any([signal, requestSignal]),
              undefined,
              grants.clientSession(key),
              undefined,
              range,
            ),
          catch: runtimeFailure,
        }).pipe(Effect.orElseSucceed(unavailableSavedAppFile));
      });
      const open = Effect.fn("Mausbot.open")(function* (
        session: AuthenticatedSession,
        frameOrigin?: string,
        viewKey?: string,
      ) {
        if (!config.mausbotResourcesPath)
          return yield* Effect.fail("The Mausbot runtime is not bundled in this server build.");
        const now = yield* Clock.currentTimeMillis;
        if (viewKey && !(yield* authorizeView(viewKey)))
          return yield* Effect.fail("This assistant window expired. Reopen it from J1.");
        return yield* Effect.try({
          try: () => ({
            relativeUrl: viewKey
              ? grants.renew(viewKey, session.sessionId, now)
              : grants.issue(
                  session.sessionId,
                  now,
                  session.expiresAt ? DateTime.toEpochMillis(session.expiresAt) : undefined,
                  frameOrigin,
                  session.scopes.includes(AuthAccessWriteScope),
                ),
          }),
          catch: (error) =>
            error instanceof Error ? error.message : "Could not open the assistant workspace.",
        });
      });
      return MausbotService.of({
        status: Effect.sync(() => ({
          available: Boolean(config.mausbotResourcesPath),
          running: runtime?.running ?? false,
        })),
        forward,
        readSavedAppFile,
        stop,
        setApprovalMode: Effect.fn("MausbotService.setApprovalMode")((session, input) =>
          Effect.tryPromise({
            try: async () => {
              if (!isMausbotDesktopSession(config.mode, session))
                throw new Error("Confirm this permission change in the local J1 desktop.");
              if (!runtime) throw new Error("Open an assistant before changing its permissions.");
              return runtime.setApprovalMode(input);
            },
            catch: (error) =>
              error instanceof Error ? error.message : "Could not change assistant permissions.",
          }),
        ),
        open,
        authorizeView: Effect.fn("MausbotService.authorizeView")((key) =>
          authorizeView(key).pipe(Effect.map(Boolean)),
        ),
      });
    }),
  );
}
