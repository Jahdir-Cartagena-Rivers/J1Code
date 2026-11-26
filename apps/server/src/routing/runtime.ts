import { hashTelemetryId as hashUtf8Sha256 } from "@j1code/shared/telemetryId";
import { makeTaskOwnerStore } from "./taskOwnerStore.ts";
import { ThreadId } from "@j1code/contracts";
import { Clock, Effect, Layer, Option, Schema, Stream } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { RoutingBoundaryPorts, makeRoutingBoundary } from "../mcp/toolkits/routing/boundary.ts";
import { ExternalRouteEndpoints } from "./ExternalRouteEndpoints.ts";
import { DeliveryDispatchError } from "./deliveryDispatcher.ts";
import { routeEndpointUrl } from "@j1code/shared/routeEndpointUrl";
import { replayRouteInput, type RouteEndpoint, type RouteState } from "./routeState.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { makeDurableRoutingStore, RoutingStoreError } from "./durableRoutingStore.ts";
import { makeSnapshotRoutingAdapter } from "./snapshotRoutingAdapter.ts";
import { makeEngineRouteDrain } from "./engineDrain.ts";
import { isBuildIntegrationRequest, PROJECT_BUILD_OWNER_TASK } from "./integrationOwner.ts";
import { makeRouteSourceNotifier } from "./sourceActivity.ts";
import { suggestWorkingChat } from "./workingChatSuggestion.ts";
import { createRouteFeedback } from "./feedback.ts";
const encodeIdentity = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeTaskIdentity = Schema.decodeUnknownEffect(
  Schema.Struct({ taskId: Schema.String, requestId: Schema.String }),
);
const decodeRouteIdentity = Schema.decodeUnknownEffect(Schema.Struct({ requestId: Schema.String }));
const decodeReceipt = Schema.decodeUnknownEffect(
  Schema.Struct({
    requestId: Schema.String,
    kind: Schema.Literals(["accepted", "completed", "failed"]),
    message: Schema.optionalKey(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_000)),
    ),
  }),
);
const decodeReply = Schema.decodeUnknownEffect(
  Schema.Struct({
    requestId: Schema.String,
    replyId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_000)),
  }),
);
const decodeEmpty = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Never));
const routeSummary = (state: RouteState) => ({
  requestId: state.request.requestId,
  status: state.status,
  reason: state.reason,
  destinationUrl: state.request.destination ? routeEndpointUrl(state.request.destination) : null,
  sourceUrl: routeEndpointUrl(state.request.source),
});

/** Runtime registration shares the persisted store with admission and receipt consumers. */
export const RoutingRuntimeLive = Layer.effect(
  RoutingBoundaryPorts,
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const projects = yield* ProjectStoreV2;
    const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
    const settings = yield* ServerSettingsService;
    const external = yield* Effect.serviceOption(ExternalRouteEndpoints);
    const sql = yield* SqlClient.SqlClient;
    const store = yield* makeDurableRoutingStore;
    const notify = yield* makeRouteSourceNotifier;
    const drain = yield* makeEngineRouteDrain;
    yield* drain.start;
    const error = () => "Routing operation unavailable.";
    const shell = (id: string) => projections.getThreadShell(ThreadId.make(id)).pipe(
      Effect.map((thread) => thread === null || thread.deletedAt !== null ? null : {
        ...thread,
        hasPendingApprovals: thread.pendingRuntimeRequest !== null,
        hasPendingUserInput: false,
        // This preflight marker is never used as a provider/native turn identity.
        session: thread.activeRunId === null ? null : {
          activeTurnId: thread.activeRunId, status: thread.activityRunStatus ?? "running",
        },
      }),
      Effect.mapError(error),
    );
    const localAdapter = makeSnapshotRoutingAdapter({
      environmentId,
      thread: shell,
      settings: () => settings.getSettings.pipe(Effect.mapError(error)),
      permissions: (endpoint) =>
        shell(endpoint.threadId).pipe(
          Effect.map((s) =>
            s && endpoint.environmentId === environmentId && s.projectId === endpoint.projectId
              ? [`runtime:${s.runtimeMode}`]
              : null,
          ),
        ),
    });
    const nativeSource = (id: string) =>
      shell(id).pipe(
        Effect.flatMap((existing) =>
          !existing && Option.isSome(external) ? external.value.source(id) : Effect.succeed(null),
        ),
      );
    const current: RoutingBoundaryPorts["Service"]["current"] = (env, id) =>
      id.startsWith("mausbot:")
        ? nativeSource(id).pipe(
            Effect.map((source) =>
              source &&
              !source.archived &&
              source.endpoint.environmentId === env &&
              env === environmentId
                ? source.endpoint
                : null,
            ),
          )
        : localAdapter.current(env, id);
    const adapter = {
      ...localAdapter,
      current,
      policy: (source: RouteEndpoint, _requestId?: string) =>
        source.threadId.startsWith("mausbot:")
          ? Effect.gen(function* () {
              if (!(yield* current(source.environmentId, source.threadId)))
                return yield* Effect.fail("Source unavailable.");
              return {
                mode: (yield* settings.getSettings).chatRoutingMode,
                manual: false,
                visited: [],
                maxHops: 1,
              };
            }).pipe(Effect.mapError(error))
          : localAdapter.policy(source, "mode"),
      inspect: (endpoint: RouteEndpoint) =>
        endpoint.threadId.startsWith("mausbot:")
          ? Effect.gen(function* () {
              const source = yield* nativeSource(endpoint.threadId);
              if (
                !source ||
                source.archived ||
                source.endpoint.environmentId !== endpoint.environmentId ||
                source.endpoint.projectId !== endpoint.projectId ||
                source.endpoint.environmentId !== environmentId
              )
                return yield* Effect.fail("Endpoint unavailable.");
              if (!source.permissionsKnown || source.runtimeMode !== "full-access")
                return yield* Effect.fail(
                  "This native execution profile has no verified cross-engine permission mapping.",
                );
              return { permissions: [`runtime:${source.runtimeMode}`], status: "ready" as const };
            }).pipe(Effect.mapError((message) => new DeliveryDispatchError({ message })))
          : localAdapter.inspect(endpoint),
    };
    const owner: RoutingBoundaryPorts["Service"]["owner"] = Effect.fn("owner")(
      function* (source, taskId, candidate, request) {
        const exact = yield* sql<{
          thread_id: string;
        }>`SELECT DISTINCT thread_id FROM task_owner_bindings
        WHERE task_id = ${taskId} AND environment_id = ${source.environmentId} AND revocation_json IS NULL
        AND (${taskId} <> ${PROJECT_BUILD_OWNER_TASK} OR project_id = ${source.projectId})`;
        // Existing task ownership always wins, including an unavailable or conflicting owner.
        if (exact.length) {
          if (exact.length !== 1) return { destination: null, ambiguous: true };
          const destination = yield* adapter.current(source.environmentId, exact[0]!.thread_id);
          return { destination, ambiguous: destination === null };
        }
        if (isBuildIntegrationRequest(taskId, request)) {
          const coordinators = yield* sql<{
            thread_id: string;
          }>`SELECT DISTINCT thread_id FROM task_owner_bindings
          WHERE task_id = ${PROJECT_BUILD_OWNER_TASK} AND environment_id = ${source.environmentId}
          AND project_id = ${source.projectId} AND revocation_json IS NULL`;
          if (coordinators.length) {
            if (coordinators.length !== 1) return { destination: null, ambiguous: true };
            const destination = yield* adapter.current(
              source.environmentId,
              coordinators[0]!.thread_id,
            );
            return { destination, ambiguous: destination === null };
          }
        }
        const hinted = yield* adapter.owner(source, taskId, candidate);
        if (hinted.destination) return hinted;
        return {
          destination: yield* suggestWorkingChat(source, `${taskId} ${request ?? ""}`),
          ambiguous: true,
        };
      },
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(error),
    );
    const reconsider = Effect.gen(function* () {
      const settingsNow = yield* settings.getSettings;
      if (settingsNow.chatRoutingMode !== "auto") {
        yield* drain.drain();
        return;
      }
      const rows = yield* sql<{
        request_id: string;
      }>`SELECT request_id FROM durable_routes WHERE status = 'suggested'
        AND json_extract(state_json, '$.originalRequest.mode') = 'auto'
        AND json_extract(state_json, '$.originalRequest.source.environmentId') = ${environmentId}`;
      for (const entry of rows) {
        const row = yield* store.get(entry.request_id);
        if (!row || row.state.status !== "suggested") continue;
        const request = row.state.originalRequest;
        const resolved = yield* owner(
          request.source,
          request.taskId ?? "",
          undefined,
          request.content,
        );
        if (
          !resolved.destination ||
          resolved.ambiguous ||
          resolved.destination.threadId === request.source.threadId
        )
          continue;
        const target = yield* adapter.inspect(resolved.destination).pipe(Effect.result);
        if (target._tag === "Failure") continue;
        const changed = yield* store
          .commitDiscoveredOwner(
            entry.request_id,
            row.revision,
            resolved.destination,
            target.success.permissions,
          )
          .pipe(Effect.result);
        if (changed._tag === "Success") yield* notify(changed.success);
      }
      yield* drain.drain();
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Pending routing rediscovery could not finish", { cause }),
      ),
    );
    yield* reconsider;
    const ports = RoutingBoundaryPorts.of({
      ...adapter,
      release: Effect.fn("RoutingBoundaryPorts.release")(
        function* (endpoint, taskId, requestId) {
          const actual = yield* adapter.current(endpoint.environmentId, endpoint.threadId);
          if (!actual || actual.projectId !== endpoint.projectId)
            return yield* Effect.fail("Source unavailable.");
          const owners = yield* makeTaskOwnerStore({
            verify: Effect.fn("verify")(function* () {
              return {
                principalId: `thread:${endpoint.threadId}`,
                requestId,
                authenticatedAt: yield* Clock.currentTimeMillis,
              };
            }),
          });
          const rows = yield* sql<{
            binding_id: string;
          }>`SELECT binding_id FROM task_owner_bindings WHERE task_id = ${taskId} AND environment_id = ${endpoint.environmentId} AND project_id = ${endpoint.projectId} AND thread_id = ${endpoint.threadId} AND revocation_json IS NULL`;
          for (const row of rows) yield* owners.revoke(row.binding_id);
          yield* reconsider;
        },
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(error),
      ),
      claim: Effect.fn("RoutingBoundaryPorts.claim")(
        function* (endpoint, taskId, requestId) {
          const actual = yield* adapter.current(endpoint.environmentId, endpoint.threadId);
          if (!actual || actual.projectId !== endpoint.projectId)
            return yield* Effect.fail("Source unavailable.");
          const owners = yield* makeTaskOwnerStore({
            verify: Effect.fn("verify")(function* () {
              return {
                principalId: `thread:${endpoint.threadId}`,
                requestId,
                authenticatedAt: yield* Clock.currentTimeMillis,
              };
            }),
          });
          yield* owners.bind({
            ...endpoint,
            taskId,
            bindingId: hashUtf8Sha256(yield* encodeIdentity([endpoint, taskId, requestId])),
          });
          yield* reconsider;
        },
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(error),
      ),
      policy: Effect.fn("RoutingBoundaryPorts.policy")(
        function* (source, requestId, taskId) {
          const policy = yield* adapter.policy(source, requestId);
          const rows = yield* sql<{ request_id: string }>`SELECT request_id FROM durable_routes
        WHERE json_extract(state_json, '$.request.destination.threadId') = ${source.threadId}
        AND json_extract(state_json, '$.request.taskId') = ${taskId ?? ""}
        AND status IN ('sending', 'admitted', 'uncertain', 'delivered', 'accepted')`;
          const incoming = yield* Effect.forEach(rows, (r) => store.get(r.request_id));
          const ancestry = incoming.flatMap((r) =>
            r ? [...r.state.request.visited, r.state.request.source] : [],
          );
          const visited = [
            ...new Map(
              ancestry.map((endpoint) => [
                JSON.stringify([endpoint.environmentId, endpoint.projectId, endpoint.threadId]),
                endpoint,
              ]),
            ).values(),
          ];
          return { ...policy, visited, maxHops: 8 };
        },
        Effect.mapError(error),
      ),
      owner,
      reply: Effect.fn("RoutingBoundaryPorts.reply")(
        function* (endpoint, id, replyId, message) {
          const original = yield* store.get(id);
          if (!original) return yield* Effect.fail("Route unavailable.");
          const identity = yield* encodeIdentity(["route-reply-v1", id, endpoint, replyId]);
          const feedback = yield* Effect.try({
            try: () =>
              createRouteFeedback(
                original.state,
                endpoint,
                hashUtf8Sha256(identity),
                message,
              ),
            catch: () => "Route reply unavailable.",
          });
          const existing = yield* store.get(feedback.requestId);
          if (
            existing &&
            (existing.state.originalRequest.feedbackFor !== feedback.feedbackFor ||
              existing.state.originalRequest.feedbackMessageHash !== feedback.feedbackMessageHash)
          )
            return yield* Effect.fail("Reply identity conflict.");
          const row = existing ?? (yield* store.create(feedback));
          yield* drain.drain();
          return (yield* store.get(row.state.request.requestId))!.state;
        },
        Effect.mapError(error),
      ),
      receipt: Effect.fn("RoutingBoundaryPorts.receipt")(
        function* (endpoint, id, kind, message) {
          const row = yield* store.get(id);
          const destination = row?.state.request.destination;
          if (
            !row ||
            !destination ||
            !row.state.attemptId ||
            destination.threadId !== endpoint.threadId ||
            destination.projectId !== endpoint.projectId ||
            destination.environmentId !== endpoint.environmentId
          )
            return yield* Effect.fail("Route unavailable.");
          const changed = yield* store.transition(id, row.revision, {
            type: "receipt",
            receipt: {
              requestId: id,
              fingerprint: row.state.fingerprint,
              attemptId: row.state.attemptId,
              destination,
              kind,
              ...(message === undefined ? {} : { message }),
              receiptId: `recipient:${id}:${row.state.attemptId}:${kind}`,
            },
          });
          yield* notify(changed);
          return changed.state;
        },
        Effect.mapError(error),
      ),
      submit: Effect.fn("RoutingBoundaryPorts.submit")(
        function* (input) {
          const prior = yield* store.get(input.route.requestId);
          if (prior) {
            return yield* Effect.try({
              try: () => replayRouteInput(prior.state, input.fingerprint),
              catch: (cause) => new RoutingStoreError({ operation: "replay-input", cause }),
            });
          }
          const source = yield* adapter.inspect(input.route.source);
          const destination = input.route.destination
            ? yield* adapter.inspect(input.route.destination)
            : null;
          const existing = yield* store.get(input.route.requestId);
          const monitorSource = existing ? existing.state.request.monitorSource : true;
          const row = yield* store.create({
            ...input.route,
            ...(monitorSource === undefined ? {} : { monitorSource }),
            sourceUrl: input.sourceUrl,
            permissionCeiling:
              existing?.state.originalRequest.permissionCeiling ?? source.permissions,
            destinationPermissions:
              existing?.state.originalRequest.destinationPermissions ??
              destination?.permissions ??
              [],
          }, input.fingerprint);
          yield* notify(row);
          yield* drain.drain();
          const latest = (yield* store.get(row.state.request.requestId))!;
          if (latest.revision !== row.revision) yield* notify(latest);
          return latest.state;
        },
        Effect.mapError(error),
      ),
      get: Effect.fn("RoutingBoundaryPorts.get")(
        (id: string) => store.get(id).pipe(Effect.map((row) => row?.state ?? null)),
        Effect.mapError(error),
      ),
      list: Effect.fn("RoutingBoundaryPorts.list")(
        function* (endpoint) {
          const rows = yield* sql<{ request_id: string }>`SELECT request_id FROM durable_routes
        WHERE json_extract(state_json, '$.request.source.threadId') = ${endpoint.threadId}
        OR json_extract(state_json, '$.request.destination.threadId') = ${endpoint.threadId}`;
          const routes = yield* Effect.forEach(rows, (r) => store.get(r.request_id));
          return routes.flatMap((r) => (r ? [r.state] : []));
        },
        Effect.mapError(error),
      ),
    });
    if (Option.isSome(external)) {
      const removeReceiver = external.value.registerReceiver((event) =>
        Effect.gen(function* () {
          if (event.kind === "routingWake") {
            yield* external.value.wake;
            return true;
          }
          const input = event.delivery;
          const row = yield* store.get(input.requestId);
          const request = row?.state.request;
          if (
            !row ||
            !request?.destination ||
            row.state.fingerprint !== input.fingerprint ||
            row.state.attemptId !== input.attemptId ||
            request.source.environmentId !== environmentId ||
            request.destination.environmentId !== environmentId ||
            request.destination.threadId !== input.destination.threadId ||
            request.destination.projectId !== input.destination.projectId ||
            request.source.threadId !== input.source.threadId ||
            request.source.projectId !== input.source.projectId ||
            request.content !== input.content
          )
            return yield* Effect.fail("Route identity changed.");
          if (event.kind === "routeSourceCheck") {
            if (row.state.status !== "sending") return false;
            const source = yield* adapter.inspect(request.source).pipe(Effect.option);
            return (
              Option.isSome(source) &&
              source.value.permissions.includes("runtime:full-access") &&
              request.permissionCeiling.includes("runtime:full-access")
            );
          }
          if (event.kind === "routeTransport" && (!event.generation || !event.providerTurnId))
            return yield* Effect.fail("Transport proof missing.");
          const kind = event.kind === "routeFailed" ? "failed" : "delivered";
          const receiptId = `native:${input.requestId}:${input.attemptId}:${kind}`;
          if (row.state.receipts.some((receipt) => receipt.receiptId === receiptId)) return true;
          const next = yield* store.transition(input.requestId, row.revision, {
            type: "receipt",
            receipt: {
              receiptId,
              requestId: input.requestId,
              fingerprint: input.fingerprint,
              attemptId: input.attemptId,
              destination: request.destination,
              kind,
            },
          });
          yield* notify(next);
          return true;
        }).pipe(Effect.mapError(error)),
      );
      yield* Effect.addFinalizer(() => Effect.sync(removeReceiver));
      const remove = external.value.registerRouter((actor, operation, input) => {
        if (actor.kind !== "mausbot" || actor.environmentId !== environmentId)
          return Effect.fail("Routing source unavailable.");
        const boundary = makeRoutingBoundary(
          Effect.gen(function* () {
            const endpoint = yield* current(
              environmentId,
              `mausbot:${actor.botId}:${actor.threadId}`,
            );
            if (!endpoint) return yield* Effect.fail("Routing source unavailable.");
            return endpoint;
          }),
        );
        return Effect.gen(function* () {
          switch (operation) {
            case "list_chat_projects": {
              yield* decodeEmpty(input, { onExcessProperty: "error" });
              yield* boundary.routingMode;
              return (yield* projects.listShells()).filter((project) => project.archivedAt == null).map(({ id, title, workspaceRoot }) => ({
                id,
                title,
                workspaceRoot,
              }));
            }
            case "route_task":
              return routeSummary(yield* boundary.routeRequest(input));
            case "routing_mode":
              yield* decodeEmpty(input, { onExcessProperty: "error" });
              return yield* boundary.routingMode;
            case "list_routes":
              yield* decodeEmpty(input, { onExcessProperty: "error" });
              return (yield* boundary.listRoutes).map(routeSummary);
            case "claim_task": {
              const args = yield* decodeTaskIdentity(input, { onExcessProperty: "error" });
              return yield* boundary.claimTask(args.taskId, args.requestId);
            }
            case "release_task": {
              const args = yield* decodeTaskIdentity(input, { onExcessProperty: "error" });
              return yield* boundary.releaseTask(args.taskId, args.requestId);
            }
            case "routing_status": {
              const args = yield* decodeRouteIdentity(input, { onExcessProperty: "error" });
              return routeSummary(yield* boundary.routeStatus(args.requestId));
            }
            case "acknowledge_route": {
              const args = yield* decodeReceipt(input, { onExcessProperty: "error" });
              return routeSummary(
                yield* boundary.recipientReceipt(args.requestId, args.kind, args.message),
              );
            }
            case "reply_to_route": {
              const args = yield* decodeReply(input, { onExcessProperty: "error" });
              return routeSummary(
                yield* boundary.replyToRoute(args.requestId, args.replyId, args.message),
              );
            }
            default:
              return yield* Effect.fail("Unsupported routing operation.");
          }
        }).pipe(Effect.provideService(RoutingBoundaryPorts, ports), Effect.mapError(error));
      });
      yield* Effect.addFinalizer(() => Effect.sync(remove));
      const changes = yield* external.value.subscribe;
      yield* changes.pipe(
        Stream.runForEach(() => reconsider),
        Effect.forkScoped,
      );
    }
    return ports;
  }),
);
