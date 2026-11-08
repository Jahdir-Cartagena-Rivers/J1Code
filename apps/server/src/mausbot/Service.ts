import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
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
import { SessionStore } from "../auth/SessionStore.ts";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { AuthAccessWriteScope } from "@t3tools/contracts";
import type { MausbotApprovalModeInput } from "@t3tools/contracts";
import { isMausbotDesktopSession } from "./DesktopTrust.ts";
import { MausbotHiveMemory } from "./HiveMemory.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ExternalConversations } from "../conversations/ExternalConversations.ts";
import { makeMausbotConversationSource } from "../conversations/MausbotConversationSource.ts";
import { MausbotConversationInvocation } from "@t3tools/contracts";
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
} from "@t3tools/contracts";
import { ExternalRouteEndpoints } from "../routing/ExternalRouteEndpoints.ts";
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
>()("t3/mausbot/Service/MausbotService") {
  static readonly layer = Layer.effect(
    MausbotService,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const platform = yield* HostProcessPlatform;
      const path = yield* Path.Path;
      const settings = yield* ServerSettingsService;
      const sessions = yield* SessionStore;
      const conversations = yield* ExternalConversations;
      const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
      const effectContext = yield* Effect.context<never>();
      const externalRoutes = yield* Effect.serviceOption(ExternalRouteEndpoints);
      const handleConversation = (input: unknown, active: () => boolean) =>
        Effect.gen(function* () {
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
          if (!("call" in request))
            return yield* Effect.fail("Unsupported conversation operation.");
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
        }).pipe(Effect.runPromiseWith(effectContext));
      const grants = new MausbotViewGrants();
      const hiveMemory = new MausbotHiveMemory({
        file: path.join(config.stateDir, "hive-mind.json"),
        indexDir: path.join(config.stateDir, "mausbot-hive-index"),
      });
      yield* sessions.streamChanges.pipe(
        Stream.runForEach((change) =>
          Effect.sync(() => {
            if (change.type === "clientRemoved") grants.revoke(change.sessionId);
            else if (!change.clientSession.scopes.includes(AuthAccessWriteScope))
              grants.revoke(change.clientSession.sessionId);
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
              catch: () => "The bundled assistant runtime failed verification.",
            });
            const current = yield* settings.getSettings.pipe(
              Effect.mapError(() => "Could not load browser settings."),
            );
            runtime = new MausbotRuntime({
              platform,
              resources: expanded,
              dataDir: path.join(config.baseDir, "userdata", "mausbot"),
              lightpandaExecutablePath: browserExecutable(current.lightpandaExecutablePath),
              memory: (input, active) => hiveMemory.handle(input, active),
              conversationCall: handleConversation,
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
      const forward = Effect.fn("Mausbot.forward")(function* (
        url: string,
        method: string,
        contentType?: string,
        body?: Uint8Array,
        viewKey?: string,
      ) {
        const signal = viewKey ? grants.signal(viewKey, yield* Clock.currentTimeMillis) : undefined;
        if (viewKey && !signal)
          return yield* Effect.fail("This assistant window expired. Reopen it from J1.");
        const child = yield* getRuntime();
        return yield* Effect.tryPromise({
          try: async () => {
            await child.start();
            return child.forward(
              url,
              method,
              contentType,
              body,
              signal,
              viewKey ? grants.frameOrigin(viewKey) : undefined,
            );
          },
          catch: (error) =>
            error instanceof Error ? error.message : "The assistant runtime is unavailable.",
        });
      });
      const open = Effect.fn("Mausbot.open")(function* (
        session: AuthenticatedSession,
        frameOrigin?: string,
        viewKey?: string,
      ) {
        if (!config.mausbotResourcesPath)
          return yield* Effect.fail("The Mausbot runtime is not bundled in this server build.");
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: () => ({
            relativeUrl: viewKey
              ? grants.renew(viewKey, session.sessionId, now)
              : grants.issue(
                  session.sessionId,
                  now,
                  session.expiresAt ? DateTime.toEpochMillis(session.expiresAt) : undefined,
                  frameOrigin,
                ),
          }),
          catch: (error) =>
            error instanceof Error ? error.message : "Could not open the assistant workspace.",
        });
      });
      const authorizeView = Effect.fnUntraced(function* (key: string) {
        return grants.valid(key, yield* Clock.currentTimeMillis);
      });
      return MausbotService.of({
        status: Effect.sync(() => ({
          available: Boolean(config.mausbotResourcesPath),
          running: runtime?.running ?? false,
        })),
        forward,
        stop,
        setApprovalMode: (session, input) =>
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
        open,
        authorizeView,
      });
    }),
  );
}
