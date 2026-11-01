// @effect-diagnostics nodeBuiltinImport:off

import { CommandId, EventId, ProjectId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ServerConfig } from "../config.ts";

import { makeEngineRouteDrain } from "./engineDrain.ts";
import { makeDurableRoutingStore } from "./durableRoutingStore.ts";

import { makeRouteTransportConsumer } from "./transportConsumer.ts";
function makeOrchestrationLayer(
  databasePath?: string,
  repositoryIdentityResolver?: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"],
) {
  const persistence = databasePath
    ? makeSqlitePersistenceLive(databasePath)
    : SqlitePersistenceMemory;
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-orchestration-engine-test-",
  });
  return Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(
      repositoryIdentityResolver
        ? Layer.succeed(
            RepositoryIdentityResolver.RepositoryIdentityResolver,
            repositoryIdentityResolver,
          )
        : RepositoryIdentityResolver.layer,
    ),
    Layer.provideMerge(persistence),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

for (const { early, outcome } of [
  { early: false, outcome: "sent" },
  { early: true, outcome: "sent" },
  { early: true, outcome: "outcome-unknown" },
  { early: false, outcome: "outcome-unknown" },
])
  effectIt.effect(
    `consumes persisted sent evidence with early=${early} outcome=${outcome}, ignores forgery and replays idempotently`,
    () =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const projectId = ProjectId.make("p");
        const createdAt = "2026-01-01T00:00:00.000Z";
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("p"),
          projectId,
          title: "P",
          workspaceRoot: process.cwd(),
          defaultModelSelection: null,
          createdAt,
        });
        for (const id of ["s", "d"])
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(id),
            threadId: ThreadId.make(id),
            projectId,
            title: id,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
          });
        const store = yield* makeDurableRoutingStore;
        yield* store.create({
          requestId: "r",
          source: { environmentId: "e", projectId: "p", threadId: "s" },
          destination: { environmentId: "e", projectId: "p", threadId: "d" },
          content: "task",
          permissionCeiling: ["runtime:full-access", "provider:codex"],
          destinationPermissions: ["runtime:full-access", "provider:codex"],
          visited: [],
          maxHops: 3,
          ambiguous: false,
          mode: "auto",
          initiation: "automatic",
        });
        const drain = yield* makeEngineRouteDrain;
        if (early) yield* store.transition("r", 0, { type: "begin-send", attemptId: "route:r:0" });
        else yield* drain.drain();
        expect((yield* store.get("r"))?.state.status).toBe(early ? "sending" : "admitted");
        expect((yield* store.get("r"))?.state.receipts).toEqual([]);
        const consumer = yield* makeRouteTransportConsumer;
        const row = (yield* store.get("r"))!;
        const payload = {
          routeId: "r",
          sourceThreadId: "s",
          receivingThreadId: "d",
          commandId: row.state.attemptId!,
          messageId: "route:r",
          outcome,
        };
        const identity = [
          payload.routeId,
          payload.commandId,
          payload.messageId,
          payload.receivingThreadId,
          payload.outcome,
        ]
          .map(encodeURIComponent)
          .join(":");
        const receiptId = `route-transport:${identity}`;
        const append = (id: string, receivingThreadId = "d") =>
          engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(id),
            threadId: ThreadId.make("d"),
            activity: {
              id: EventId.make(id),
              kind: "route.transport",
              tone: "info",
              summary: "evidence",
              payload: { ...payload, receivingThreadId },
              turnId: null,
              createdAt,
            },
            createdAt,
          });
        yield* append("forged");
        yield* consumer.reconcile;
        expect((yield* store.get("r"))?.state.status).toBe(early ? "sending" : "admitted");
        yield* append(receiptId);
        yield* consumer.reconcile;
        const delivered = (yield* store.get("r"))!;
        expect(delivered.state.status).toBe(outcome === "sent" ? "delivered" : "uncertain");
        expect(delivered.state.receipts.map((r) => r.receiptId)).toEqual(
          outcome === "sent" ? [receiptId] : [],
        );
        const restarted = yield* makeRouteTransportConsumer;
        yield* restarted.reconcile;
        expect((yield* store.get("r"))?.revision).toBe(delivered.revision);
        yield* drain.drain();
        expect((yield* store.get("r"))?.state.status).toBe(
          outcome === "sent" ? "delivered" : "uncertain",
        );
      }).pipe(Effect.provide(makeOrchestrationLayer())),
  );
