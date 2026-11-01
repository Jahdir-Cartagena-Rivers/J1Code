import * as NodeCrypto from "node:crypto";
import { makeTaskOwnerStore } from "./taskOwnerStore.ts";
import { ThreadId } from "@t3tools/contracts";
import { Clock, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { RoutingBoundaryPorts } from "../mcp/toolkits/routing/boundary.ts";
import { makeDurableRoutingStore } from "./durableRoutingStore.ts";
import { makeSnapshotRoutingAdapter } from "./snapshotRoutingAdapter.ts";
import { makeEngineRouteDrain } from "./engineDrain.ts";
import { makeRouteTransportConsumer } from "./transportConsumer.ts";
const encodeIdentity = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** Runtime registration shares the persisted store with admission and receipt consumers. */
export const RoutingRuntimeLive = Layer.effect(
  RoutingBoundaryPorts,
  Effect.gen(function* () {
    const snapshots = yield* ProjectionSnapshotQuery;
    const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
    const settings = yield* ServerSettingsService;
    const sql = yield* SqlClient.SqlClient;
    const store = yield* makeDurableRoutingStore;
    const drain = yield* makeEngineRouteDrain;
    const consumer = yield* makeRouteTransportConsumer;
    yield* consumer.start;
    yield* drain.start;
    const error = () => "Routing operation unavailable.";
    const shell = (id: string) =>
      snapshots
        .getThreadShellById(ThreadId.make(id))
        .pipe(Effect.map(Option.getOrNull), Effect.mapError(error));
    const adapter = makeSnapshotRoutingAdapter({
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
    return RoutingBoundaryPorts.of({
      ...adapter,
      release: (endpoint, taskId, requestId) =>
        Effect.gen(function* () {
          const actual = yield* adapter.current(endpoint.environmentId, endpoint.threadId);
          if (!actual || actual.projectId !== endpoint.projectId)
            return yield* Effect.fail("Source unavailable.");
          const owners = yield* makeTaskOwnerStore({
            verify: () =>
              Effect.gen(function* () {
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
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(error)),
      claim: (endpoint, taskId, requestId) =>
        Effect.gen(function* () {
          const actual = yield* adapter.current(endpoint.environmentId, endpoint.threadId);
          if (!actual || actual.projectId !== endpoint.projectId)
            return yield* Effect.fail("Source unavailable.");
          const owners = yield* makeTaskOwnerStore({
            verify: () =>
              Effect.gen(function* () {
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
            bindingId: NodeCrypto.createHash("sha256")
              .update(yield* encodeIdentity([endpoint, taskId, requestId]))
              .digest("hex"),
          });
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(error)),
      policy: (source, requestId, taskId) =>
        Effect.gen(function* () {
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
        }).pipe(Effect.mapError(error)),
      owner: (source, taskId, candidate) =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            thread_id: string;
          }>`SELECT DISTINCT thread_id FROM task_owner_bindings
        WHERE task_id = ${taskId} AND environment_id = ${source.environmentId}
        AND revocation_json IS NULL`;
          if (rows.length !== 1) return yield* adapter.owner(source, taskId, candidate);
          const destination = yield* adapter.current(source.environmentId, rows[0]!.thread_id);
          return { destination, ambiguous: destination === null };
        }).pipe(Effect.mapError(error)),
      receipt: (endpoint, id, kind) =>
        Effect.gen(function* () {
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
          return (yield* store.transition(id, row.revision, {
            type: "receipt",
            receipt: {
              requestId: id,
              fingerprint: row.state.fingerprint,
              attemptId: row.state.attemptId,
              destination,
              kind,
              receiptId: `recipient:${id}:${row.state.attemptId}:${kind}`,
            },
          })).state;
        }).pipe(Effect.mapError(error)),
      submit: (input) =>
        Effect.gen(function* () {
          const source = yield* adapter.inspect(input.route.source);
          const destination = input.route.destination
            ? yield* adapter.inspect(input.route.destination)
            : null;
          const existing = yield* store.get(input.route.requestId);
          const row = yield* store.create({
            ...input.route,
            sourceUrl: input.sourceUrl,
            permissionCeiling:
              existing?.state.originalRequest.permissionCeiling ?? source.permissions,
            destinationPermissions:
              existing?.state.originalRequest.destinationPermissions ??
              destination?.permissions ??
              [],
          });
          yield* drain.drain();
          return (yield* store.get(row.state.request.requestId))!.state;
        }).pipe(Effect.mapError(error)),
      get: (id) =>
        store.get(id).pipe(
          Effect.map((r) => r?.state ?? null),
          Effect.mapError(error),
        ),
      list: (endpoint) =>
        Effect.gen(function* () {
          const rows = yield* sql<{ request_id: string }>`SELECT request_id FROM durable_routes
        WHERE json_extract(state_json, '$.request.source.threadId') = ${endpoint.threadId}
        OR json_extract(state_json, '$.request.destination.threadId') = ${endpoint.threadId}`;
          const routes = yield* Effect.forEach(rows, (r) => store.get(r.request_id));
          return routes.flatMap((r) => (r ? [r.state] : []));
        }).pipe(Effect.mapError(error)),
    });
  }),
);
