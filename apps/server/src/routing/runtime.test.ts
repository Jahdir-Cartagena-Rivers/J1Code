// @effect-diagnostics nodeBuiltinImport:off

import {
  EnvironmentId,
  CommandId,
  ProjectId,
  ThreadId,
  EventId,
  ProviderDriverKind,
  MessageId,
  ProviderInstanceId,
  type OrchestrationV2DomainEvent,
} from "@j1code/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { expect, it } from "vite-plus/test";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as DateTime from "effect/DateTime";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import type { ProviderAdapterV2 } from "@j1code/provider-core/server/ProviderAdapter";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";

import { layerV2RoutingOwner, shouldWakeRouteDrain } from "./engineDrain.ts";
import { layerLocalRouteNoticeWriter } from "./localRouteNotice.ts";
import { layerV2RouteAdmission } from "./v2RouteAdmission.ts";
import { automaticRouteFeedback } from "./feedback.ts";
import { makeDurableRoutingStore } from "./durableRoutingStore.ts";
import * as Schema from "effect/Schema";
import { RoutingRuntimeLive } from "./runtime.ts";
import { RoutingBoundaryPorts } from "../mcp/toolkits/routing/boundary.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ExternalRouteEndpoints } from "./ExternalRouteEndpoints.ts";
import type { ExternalRouteDelivery } from "@j1code/contracts";

const decodeReplyReceipt = Schema.decodeUnknownEffect(Schema.Struct({ requestId: Schema.String }));

it("wakes for release of an approval, not routine tool activity", () => {
  const request = (status: string, kind: string) =>
    ({ type: "runtime-request.updated", payload: { status, kind } }) as OrchestrationV2DomainEvent;
  const event = (type: OrchestrationV2DomainEvent["type"]) =>
    ({ type }) as OrchestrationV2DomainEvent;
  expect(shouldWakeRouteDrain(event("turn-item.updated"))).toBe(false);
  expect(shouldWakeRouteDrain(request("pending", "command"))).toBe(false);
  expect(shouldWakeRouteDrain(request("resolved", "command"))).toBe(true);
  expect(shouldWakeRouteDrain(request("resolved", "user_input"))).toBe(true);
  expect(shouldWakeRouteDrain(event("thread.runtime-mode-updated"))).toBe(true);
  expect(shouldWakeRouteDrain(event("provider-thread.updated"))).toBe(true);
});

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "default" };
const replayAdapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Routing tests do not launch a provider"),
} satisfies ProviderAdapterV2["Service"];

const persistence = Sqlite.layerMemory;
const orchestration = ProviderReplayHarness.layerWithRegistry(
  { name: "routing-runtime" },
  ProviderAdapterRegistry.layerFromAdapters([replayAdapter]),
  { databaseLayer: persistence, runEffectWorker: false },
);
const routingTestServices = layerV2RoutingOwner.pipe(
  Layer.provideMerge(layerLocalRouteNoticeWriter),
  Layer.provide(layerV2RouteAdmission),
  Layer.provideMerge(Layer.mergeAll(
    orchestration,
    ProjectionStore.layer,
    ProjectStore.layer,
    CommandReceiptStore.layer,
    RuntimePolicy.layer,
    Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    ExternalRouteEndpoints.layer,
    Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(EnvironmentId.make("env")) }),
    ServerSettings.layerTest({ chatRoutingMode: "auto" }),
  )),
  Layer.provideMerge(persistence),
  Layer.provide(NodeServices.layer),
);

const seedProject = Effect.fn("RoutingRuntimeTest.seedProject")(function* (
  id: string, title: string, workspaceRoot: string,
) {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const now = DateTime.formatIso(yield* DateTime.now);
  const projectId = ProjectId.make(id);
  yield* projects.apply({
    sequence: 1, eventId: EventId.make(`seed:${id}`), aggregateKind: "project", aggregateId: projectId,
    occurredAt: now, commandId: null, causationEventId: null, correlationId: null, metadata: {},
    type: "project.created",
    payload: { projectId, title, workspaceRoot, defaultModelSelection: null, scripts: [], createdAt: now, updatedAt: now },
  });
});

effectIt.effect(
  "joins native transport receipts, acknowledgement and ancestry through the real registered runtime",
  () =>
    Effect.gen(function* () {
      const engine = yield* OrchestratorV2;
      const registry = yield* ExternalRouteEndpoints;
      yield* seedProject("merged-p", "Original project", process.cwd());
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("merged-source"),
        threadId: ThreadId.make("merged-source"),
        projectId: ProjectId.make("merged-p"),
        title: "Original chat",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const source = { environmentId: "env", projectId: "merged-p", threadId: "merged-source" };
      const destination = {
        environmentId: "env",
        projectId: "mausbot:crown",
        threadId: "mausbot:crown:main",
      };
      let pending: ExternalRouteDelivery | undefined;
      registry.register({
        kind: "mausbot",
        accepts: (id) => id === destination.threadId,
        source: () =>
          Effect.succeed({
            endpoint: destination,
            url: "/assistants",
            runtimeMode: "full-access",
            providerKey: "native-codex",
            permissionsKnown: true,
            archived: false,
            blocked: false,
            activeGeneration: "generation",
            canSteer: true,
          }),
        deliver: (input) =>
          Effect.gen(function* () {
            pending = input;
            expect(yield* registry.receive({ kind: "routeSourceCheck", delivery: input })).toBe(
              true,
            );
            return "admitted" as const;
          }),
        notice: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        const actor = {
          kind: "mausbot",
          environmentId: "env",
          botId: "crown",
          threadId: "main",
          generation: "generation",
        } as const;
        expect(yield* registry.call(actor, "list_chat_projects", {})).toEqual([
          { id: "merged-p", title: "Original project", workspaceRoot: process.cwd() },
        ]);
        expect(
          yield* registry
            .call(actor, "list_chat_projects", { source: "forged" })
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
        expect(
          yield* registry
            .call({ ...actor, environmentId: "foreign" }, "list_chat_projects", {})
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
        expect(
          yield* registry
            .call({ ...actor, threadId: "missing" }, "list_chat_projects", {})
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
        const ports = yield* RoutingBoundaryPorts;
        const requestId = "a".repeat(64);
        const result = yield* ports.submit({
          route: {
            requestId,
            taskId: "merged-task",
            source,
            destination,
            content: "Current user instruction",
            mode: "auto",
            initiation: "automatic",
            ambiguous: false,
            visited: [],
            maxHops: 8,
          },
          fingerprint: "b".repeat(64),
          originalRequest: "Current user instruction",
          sourceUrl: "/env/merged-source",
        });
        expect(result.status).toBe("admitted");
        expect(result.receipts).toEqual([]);
        expect(pending).toBeDefined();
        const delivery = pending!;
        expect(
          yield* registry
            .receive({
              kind: "routeTransport",
              delivery: { ...delivery, fingerprint: "forged" },
              generation: "generation",
              providerTurnId: "native-turn",
            })
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
        expect((yield* ports.get(requestId))?.status).toBe("admitted");
        yield* registry.receive({
          kind: "routeTransport",
          delivery,
          generation: "generation",
          providerTurnId: "native-turn",
        });
        yield* registry.receive({
          kind: "routeTransport",
          delivery,
          generation: "generation",
          providerTurnId: "native-turn",
        });
        expect((yield* ports.get(requestId))?.status).toBe("delivered");
        expect((yield* ports.policy(destination, "next", "merged-task")).visited).toContainEqual(
          source,
        );
        expect(
          yield* registry.call(
            {
              kind: "mausbot",
              environmentId: "env",
              botId: "crown",
              threadId: "main",
              generation: "generation",
            },
            "route_task",
            {
              taskId: "merged-task",
              requestId: "return-to-origin",
              request: "Return this work",
              candidate: source,
            },
          ),
        ).toMatchObject({ status: "blocked", reason: "routing-loop" });
        expect((yield* ports.receipt!(destination, requestId, "accepted")).status).toBe("accepted");
        const earlyReply = yield* decodeReplyReceipt(
          yield* registry.call(actor, "reply_to_route", {
            requestId,
            replyId: "stable-\u96ea-across-completion",
            message: "Here is the evidence so far.",
          }),
        );
        expect(
          (yield* ports.receipt!(
            destination,
            requestId,
            "completed",
            "Already fixed in commit abc.",
          )).status,
        ).toBe("completed");
        expect(earlyReply.requestId).toBe(
          "2d322dea429c7f9c5b98df4ec0147d99b025a567eac3ee265762d8a3841bb208",
        );
        const completedState = (yield* ports.get(requestId))!;
        const returned = yield* ports.get(automaticRouteFeedback(completedState)!.requestId);
        expect(returned?.request.destination).toEqual(source);
        expect(returned?.request.feedbackFor).toBe(requestId);
        expect(returned?.request.content).toContain("Already fixed in commit abc.");
        expect(
          yield* registry.call(actor, "reply_to_route", {
            requestId,
            replyId: "stable-\u96ea-across-completion",
            message: "Here is the evidence so far.",
          }),
        ).toMatchObject({ requestId: earlyReply.requestId });
        const reply = yield* decodeReplyReceipt(
          yield* registry.call(actor, "reply_to_route", {
            requestId,
            replyId: "commit-evidence",
            message: "The tests are in commit abc.",
          }),
        );
        expect((yield* ports.get(reply.requestId))?.request.feedbackFor).toBe(requestId);
        const store = yield* makeDurableRoutingStore;
        const feedbackIds = [earlyReply.requestId, returned!.request.requestId, reply.requestId];
        expect((yield* store.queued()).filter((id) => feedbackIds.includes(id))).toEqual(feedbackIds);
        expect(
          yield* registry.call(actor, "reply_to_route", {
            requestId,
            replyId: "commit-evidence",
            message: "The tests are in commit abc.",
          }),
        ).toMatchObject({ requestId: reply.requestId });
        expect(
          yield* ports.reply!(
            { ...source, threadId: "outsider" },
            requestId,
            "forged",
            "Pretend",
          ).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
        expect(
          yield* registry
            .call(actor, "reply_to_route", {
              requestId,
              replyId: "commit-evidence",
              message: "Changed result under same identity",
            })
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
      }).pipe(Effect.provide(RoutingRuntimeLive), Effect.scoped);

      yield* Effect.gen(function* () {
        const ports = yield* RoutingBoundaryPorts;
        const requestId = "a".repeat(64);
        const completed = yield* ports.get(requestId);
        expect(completed?.status).toBe("completed");
        expect(completed?.receipts.map(({ kind }) => kind)).toEqual(["delivered", "accepted", "completed"]);
        const feedback = completed === null ? null : automaticRouteFeedback(completed);
        expect(feedback).not.toBeNull();
        if (feedback === null) return yield* Effect.die("Missing durable completion feedback");
        expect((yield* ports.get(feedback.requestId))?.request.feedbackFor).toBe(requestId);
      }).pipe(Effect.provide(RoutingRuntimeLive), Effect.scoped);
    }).pipe(Effect.provide(routingTestServices)),
);

effectIt.effect(
  "registered runtime persists suggestions, discovers owners and holds unavailable auto routes",
  () =>
    Effect.gen(function* () {
      const engine = yield* OrchestratorV2;
      yield* seedProject("p", "P", process.cwd());
      yield* seedProject("p2", "Destination project", `${process.cwd()}/route-target`);
      for (const id of ["source", "destination"])
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(id),
          threadId: ThreadId.make(id),
          projectId: ProjectId.make(id === "source" ? "p" : "p2"),
          title: id,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
      yield* Effect.gen(function* () {
        const ports = yield* RoutingBoundaryPorts;
        const source = { environmentId: "env", projectId: "p", threadId: "source" };
        const destination = { ...source, projectId: "p2", threadId: "destination" };
        yield* ports.claim!(destination, "task", "claim-\u96ea");
        yield* ports.claim!(destination, "task", "claim-\u96ea");
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql<{ binding_id: string }>`
          SELECT binding_id FROM task_owner_bindings WHERE task_id = 'task'
        `).toEqual([{
          binding_id: "1e1e3299f5196b21f82037d584db12d1f1b206f86aa919e1421c62a5d4a726d8",
        }]);
        expect(yield* ports.owner(source, "task")).toEqual({ destination, ambiguous: false });
        const suggestion = yield* ports.submit({
          route: {
            requestId: "suggestion",
            taskId: "task",
            source,
            destination,
            content: "review",
            mode: "suggest",
            initiation: "automatic",
            ambiguous: false,
            visited: [],
            maxHops: 8,
          },
          fingerprint: "c".repeat(64),
          originalRequest: "review",
          sourceUrl: "/env/source",
        });
        expect(suggestion.status).toBe("suggested");
        const row = yield* ports.submit({
          route: {
            requestId: "r",
            taskId: "task",
            source,
            destination,
            content: "request",
            mode: "auto",
            initiation: "automatic",
            ambiguous: false,
            visited: [],
            maxHops: 8,
          },
          fingerprint: "b".repeat(64),
          originalRequest: "request",
          sourceUrl: "/env/source",
        });
        expect(row.status).toBe("queued");
        expect(row.receipts).toEqual([]);
        expect((yield* ports.list(source)).length).toBe(2);
        // A queued route has not reached the destination. The native receipt test
        // above checks ancestry once the destination has actually received it.
        expect((yield* ports.policy(destination, "next", "task")).visited).toEqual([]);
        expect((yield* ports.policy(destination, "other", "unrelated-task")).visited).toEqual([]);
        expect(yield* ports.receipt!(source, "r", "accepted").pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
        });
        expect(
          yield* ports.receipt!(destination, "r", "completed").pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
        yield* ports.release!(source, "task", "wrong-owner-release");
        expect((yield* ports.owner(source, "task")).destination).toEqual(destination);
        yield* ports.release!(destination, "task", "release");
        yield* ports.release!(destination, "task", "release");
        expect((yield* ports.owner(source, "task")).destination).toBeNull();
        expect((yield* ports.get("r"))?.status).toBe("queued");
        const coordinator = { ...source, threadId: "coordinator" };
        for (const id of ["coordinator", "competing-coordinator"])
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(id),
            threadId: ThreadId.make(id),
            projectId: ProjectId.make("p"),
            title: id,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
        yield* engine.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("coordinator-busy"),
          threadId: ThreadId.make("coordinator"),
          messageId: MessageId.make("coordinator-prompt"),
          text: "Work on transcription",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const proposed = yield* ports.owner(
          source,
          "new-audio-work",
          undefined,
          "Improve transcription",
        );
        expect(proposed).toEqual({ destination: coordinator, ambiguous: true });
        const proposedRoute = yield* ports.submit({
          route: {
            requestId: "working-proposal",
            taskId: "new-audio-work",
            source,
            destination: proposed.destination,
            content: "Improve transcription",
            mode: "auto",
            initiation: "automatic",
            ambiguous: proposed.ambiguous,
            visited: [],
            maxHops: 8,
          },
          fingerprint: "d".repeat(64),
          originalRequest: "Improve transcription",
          sourceUrl: "/env/source",
        });
        expect(proposedRoute.status).toBe("suggested");
        expect(proposedRoute.receipts).toEqual([]);
        yield* engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive-proposal"),
          threadId: ThreadId.make("coordinator"),
        });
        expect(
          (yield* ports.owner(source, "new-audio-work", undefined, "Improve transcription"))
            .destination,
        ).toBeNull();
        yield* engine.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make("restore-proposal"),
          threadId: ThreadId.make("coordinator"),
        });

        for (const mode of ["auto", "suggest"] as const)
          yield* ports.submit({
            route: {
              requestId: `integration-${mode}`,
              taskId: "audio-build-integration",
              source,
              destination: null,
              content: "Include completed audio changes in the next build",
              mode,
              initiation: "automatic",
              ambiguous: true,
              visited: [],
              maxHops: 8,
            },
            fingerprint: (mode === "auto" ? "e" : "f").repeat(64),
            originalRequest: "Include completed audio changes in the next build",
            sourceUrl: "/env/source",
          });
        expect((yield* ports.get("integration-auto"))?.status).toBe("suggested");
        yield* ports.claim!(coordinator, "project-build-integration", "claim-coordinator");
        expect(yield* ports.owner(source, "audio-build-integration")).toEqual({
          destination: coordinator,
          ambiguous: false,
        });
        expect((yield* ports.get("integration-auto"))?.status).toBe("queued");
        expect((yield* ports.get("integration-suggest"))?.status).toBe("suggested");
        expect((yield* ports.get("integration-auto"))?.receipts).toEqual([]);
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const sourceShell = yield* projections.getThreadShell(ThreadId.make("source"));
        expect(sourceShell?.pendingRuntimeRequest).toBeNull();
        expect(sourceShell?.routeNotices).toBeUndefined();
        const sourceThread = yield* projections.getThread(ThreadId.make("source"));
        expect(sourceThread.routeNotices).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ requestId: "integration-auto", status: "queued" }),
          ]),
        );
        expect((yield* ports.owner(source, "unrelated-audio-fix")).ambiguous).toBe(true);
        expect((yield* ports.owner(destination, "audio-build-integration")).destination).toBeNull();
        yield* ports.claim!(
          { ...coordinator, threadId: "competing-coordinator" },
          "project-build-integration",
          "claim-competing",
        );
        expect((yield* ports.owner(source, "audio-build-integration")).ambiguous).toBe(true);
        yield* ports.claim!(destination, "audio-build-integration", "claim-exact");
        expect(yield* ports.owner(source, "audio-build-integration")).toEqual({
          destination,
          ambiguous: false,
        });
      }).pipe(Effect.provide(RoutingRuntimeLive));
    }).pipe(Effect.provide(routingTestServices)),
);
