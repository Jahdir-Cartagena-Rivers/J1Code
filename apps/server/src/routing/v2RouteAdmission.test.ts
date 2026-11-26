import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderAdapterV2RuntimePolicy } from "@j1code/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@j1code/provider-core/server/IdAllocator";
import { assert, it } from "@effect/vitest";
import {
  CommandId, EnvironmentId, EventId, MessageId, NodeId, ProjectId, ProviderDriverKind,
  ProviderInstanceId, ProviderSessionId, ProviderThreadId, ProviderTurnId, RunAttemptId,
  RunId, RuntimeRequestId, ThreadId,
  type OrchestrationV2AppThread, type OrchestrationV2DomainEvent, type OrchestrationV2ProviderThread,
  type OrchestrationV2RuntimeRequest, type OrchestrationV2ProviderTurn, type OrchestrationV2Run, type OrchestrationV2RunAttempt,
  type ExternalRouteSourceSnapshot, type ServerProvider,
} from "@j1code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import { CheckpointServiceV2 } from "../orchestration-v2/CheckpointService.ts";
import * as CommandPolicy from "../orchestration-v2/CommandPolicy.ts";
import * as ContextHandoffService from "../orchestration-v2/ContextHandoffService.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { ProviderAdapterRegistryV2 } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@j1code/provider-core/server/ProviderContinuationRequests";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { ProviderSwitchServiceV2 } from "../orchestration-v2/ProviderSwitchService.ts";
import * as ThreadForkService from "../orchestration-v2/ThreadForkService.ts";
import { strictSteerFingerprint, STRICT_STEER_EFFECT_PREFIX } from "../orchestration-v2/ProviderTurnControlService.ts";
import { RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeDurableRoutingStore } from "./durableRoutingStore.ts";
import { ExternalRouteEndpoints } from "./ExternalRouteEndpoints.ts";
import { type RouteRequest } from "./routeState.ts";
import { layerV2RouteAdmission, V2RouteAdmission } from "./v2RouteAdmission.ts";
import type { PreparedStrictRouteDelivery } from "./v2StrictDelivery.ts";
import { idleRouteDraft, readIdleDeliveryEvidence } from "./v2IdleDelivery.ts";

const threadId = ThreadId.make("strict-thread");
const projectId = ProjectId.make("strict-project");
const runId = RunId.make("strict-run");
const attemptId = RunAttemptId.make("strict-run-attempt");
const rootNodeId = NodeId.make("strict-root-node");
const providerThreadId = ProviderThreadId.make("strict-provider-thread");
const providerTurnId = ProviderTurnId.make("strict-provider-turn");
const providerSessionId = ProviderSessionId.make("strict-session");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5" };
const sourceInstanceId = ProviderInstanceId.make("claudeAgent");
const sourceModelSelection = { instanceId: sourceInstanceId, model: "claude-sonnet-4-6" };
const policy = {
  runtimeMode: "approval-required", interactionMode: "default", cwd: "/workspace",
} satisfies ProviderAdapterV2RuntimePolicy;
const environmentId = EnvironmentId.make("strict-environment");

const seed = Effect.fn("routeAdmissionTest.seed")(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const thread: OrchestrationV2AppThread = {
    id: threadId, projectId, title: "Strict", createdBy: "user", creationSource: "web",
    providerInstanceId: instanceId, modelSelection,
    runtimeMode: policy.runtimeMode, interactionMode: policy.interactionMode, branch: null,
    worktreePath: "/workspace", activeProviderThreadId: providerThreadId,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null, createdAt: now, updatedAt: now, archivedAt: null, deletedAt: null,
    settledOverride: null, settledAt: null, snoozedUntil: null, snoozedAt: null, lastVisitedAt: null,
  };
  const sourceThread: OrchestrationV2AppThread = {
    ...thread, id: sourceId, providerInstanceId: sourceInstanceId, modelSelection: sourceModelSelection,
    activeProviderThreadId: null,
    lineage: { rootThreadId: sourceId, parentThreadId: null, relationshipToParent: null },
  };
  const run: OrchestrationV2Run = {
    id: runId, threadId, ordinal: 1, providerInstanceId: instanceId, modelSelection,
    providerThreadId, userMessageId: MessageId.make("first-message"), rootNodeId,
    activeAttemptId: attemptId, status: "running", requestedAt: now, startedAt: now,
    completedAt: null, checkpointId: null, contextHandoffId: null,
  };
  const attempt: OrchestrationV2RunAttempt = {
    id: attemptId, runId, attemptOrdinal: 1, rootNodeId, providerInstanceId: instanceId,
    providerThreadId, providerTurnId, reason: "initial", status: "running",
    startedAt: now, completedAt: null,
  };
  const providerThread: OrchestrationV2ProviderThread = {
    id: providerThreadId, driver, providerInstanceId: instanceId, providerSessionId,
    appThreadId: threadId, ownerNodeId: null,
    nativeThreadRef: { driver, strength: "strong", nativeId: "native-thread" },
    nativeConversationHeadRef: null, status: "active", firstRunOrdinal: 1, lastRunOrdinal: 1,
    handoffIds: [], forkedFrom: null, createdAt: now, updatedAt: now,
  };
  const providerTurn: OrchestrationV2ProviderTurn = {
    id: providerTurnId, providerThreadId, nodeId: rootNodeId, runAttemptId: attemptId,
    nativeTurnRef: { driver, strength: "strong", nativeId: "native-turn" },
    ordinal: 1, status: "running", startedAt: now, completedAt: null,
  };
  const base = { threadId, occurredAt: now, providerInstanceId: instanceId };
  yield* sink.write({
    events: [
      {
        ...base, id: EventId.make("source-thread-created"), threadId: sourceId, type: "thread.created",
        providerInstanceId: sourceInstanceId, payload: sourceThread,
      },
      { ...base, id: EventId.make("strict-thread-created"), type: "thread.created", payload: thread },
      { ...base, id: EventId.make("strict-provider-thread"), type: "provider-thread.updated", payload: providerThread },
      { ...base, id: EventId.make("strict-run-created"), type: "run.created", runId, payload: run },
      { ...base, id: EventId.make("strict-attempt-created"), type: "run-attempt.created", runId, payload: attempt },
      { ...base, id: EventId.make("strict-provider-turn"), type: "provider-turn.updated", runId, payload: providerTurn },
    ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>,
  });
  return { sink, base, thread, sourceThread, providerThread };
});


const sourceId = ThreadId.make("route-source");
const request: RouteRequest = {
  requestId: "validator-route",
  source: { environmentId, projectId, threadId: sourceId },
  destination: { environmentId, projectId, threadId },
  content: "Use the active turn",
  permissionCeiling: [`runtime:${policy.runtimeMode}`],
  destinationPermissions: [`runtime:${policy.runtimeMode}`],
  visited: [], maxHops: 1, ambiguous: false, mode: "auto", initiation: "automatic",
};
const baseProvider: ServerProvider = {
  instanceId, driver, enabled: true, installed: true, version: "0.0.0", status: "ready",
  auth: { status: "authenticated" }, checkedAt: "2026-01-01T00:00:00Z",
  models: [{ slug: modelSelection.model, name: modelSelection.model, isCustom: false, capabilities: null }],
  slashCommands: [], skills: [],
};

const baseSourceProvider: ServerProvider = {
  ...baseProvider, instanceId: sourceInstanceId, driver: ProviderDriverKind.make("claudeAgent"),
  models: [{ slug: sourceModelSelection.model, name: sourceModelSelection.model, isCustom: false, capabilities: null }],
};
const changedSourceEndpoint: ServerProvider = {
  ...baseSourceProvider, auth: { ...baseSourceProvider.auth, endpoint: "https://changed.example.invalid" },
};

function descriptor(requestId: string, attempt: string): PreparedStrictRouteDelivery {
  const identity = strictSteerFingerprint([requestId, attempt]);
  return {
    attempt: {
      requestId, attemptId: attempt, source: { environmentId, threadId: sourceId },
      destination: { environmentId, projectId, threadId, providerInstanceId: instanceId, runId,
        runtimeMode: policy.runtimeMode, interactionMode: policy.interactionMode },
      ceiling: { runtimeMode: policy.runtimeMode, interactionMode: policy.interactionMode },
      text: request.content, attachments: [],
    },
    command: {
      type: "message.steer-strict", commandId: CommandId.make(`command:route-steer:${identity}`),
      messageId: MessageId.make(`message:route-steer:${identity}`), text: request.content,
      senderThreadId: sourceId, threadId, createdBy: "agent", creationSource: "server", attachments: [],
      target: {
        projectId, runId, attemptId, providerInstanceId: instanceId, providerSessionId,
        providerThreadId, providerTurnId, nativeThreadId: "native-thread", nativeTurnId: "native-turn",
        runtimeMode: policy.runtimeMode, interactionMode: policy.interactionMode,
        policyFingerprint: strictSteerFingerprint(policy),
      },
    },
  };
}

it.effect("uses live route, provider, projection and claimed outbox state at both authorization boundaries", () =>
  Effect.gen(function* () {
    const provider = yield* Ref.make(baseProvider);
    const sourceProvider = yield* Ref.make(baseSourceProvider);
    const getProviders = Effect.all([Ref.get(provider), Ref.get(sourceProvider)]);
    const layer = layerV2RouteAdmission.pipe(
      Layer.provideMerge(Layer.mergeAll(
        Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(environmentId) }),
        Layer.mock(ProviderRegistry)({ getProviders }),
        Layer.succeed(RuntimePolicyV2, { resolve: () => Effect.succeed(policy) }),
        ServerSettings.layerTest({ chatRoutingMode: "auto" }),
      )),
      Layer.provideMerge(EventSink.layer),
      Layer.provideMerge(Layer.mergeAll(ProjectionStore.layer, EventStore.layer, EffectOutbox.layer)),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provide(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const { sink, base, sourceThread, providerThread } = yield* seed();
      const store = yield* makeDurableRoutingStore;
      const service = yield* V2RouteAdmission;
      const begin = (input: RouteRequest) => store.create(input).pipe(Effect.flatMap((queued) =>
        store.transition(input.requestId, queued.revision, { type: "begin-send", attemptId: "delivery" }),
      ));
      const sending = yield* begin(request);
      const delivery = descriptor(request.requestId, "delivery");
      assert.deepEqual(yield* service.validate(sending, delivery), delivery.attempt.ceiling);
      const manual = yield* begin({ ...request, requestId: "manual", initiation: "manual" });
      assert.deepEqual(yield* service.validate(manual, descriptor("manual", "delivery")), delivery.attempt.ceiling);
      const suggested = yield* store.create({ ...request, requestId: "confirmed", mode: "suggest" });
      const resolved = yield* store.commitResolution("confirmed", suggested.revision, {
        authenticatedUser: true, userId: "old-subject", source: request.source,
        destination: request.destination!, destinationPermissions: request.destinationPermissions,
      });
      const confirmed = yield* store.transition("confirmed", resolved.revision, {
        type: "begin-send", attemptId: "delivery",
      });
      assert.deepEqual(yield* service.validate(confirmed, descriptor("confirmed", "delivery")), delivery.attempt.ceiling);
      assert.isNull(yield* service.validate(sending, descriptor(request.requestId, "stale")));
      for (const unavailableDestination of [
        { ...baseProvider, enabled: false },
        { ...baseProvider, installed: false },
        { ...baseProvider, availability: "unavailable" as const },
        { ...baseProvider, models: [] },
        { ...baseProvider, auth: { status: "unauthenticated" as const } },
      ]) {
        yield* Ref.set(provider, unavailableDestination);
        assert.isNull(yield* service.validate(sending, delivery));
        assert.isUndefined((yield* store.get(request.requestId))?.state.strictSubmission);
      }
      yield* Ref.set(provider, baseProvider);

      const pending: OrchestrationV2RuntimeRequest = {
        id: RuntimeRequestId.make("pending-approval"),
        nodeId: rootNodeId, providerTurnId, nativeRequestRef: null,
        kind: "user_input", status: "pending",
        responseCapability: { type: "message" }, createdAt: base.occurredAt, resolvedAt: null,
      };
      yield* sink.write({ events: [{
        ...base, id: EventId.make("runtime-request-open"), type: "runtime-request.updated", payload: pending,
      }] });
      assert.isNull(yield* service.validate(sending, delivery));
      yield* sink.write({ events: [{
        ...base, id: EventId.make("runtime-request-closed"), type: "runtime-request.updated",
        payload: { ...pending, status: "resolved", resolvedAt: base.occurredAt },
      }] });
      const commandFingerprint = strictSteerFingerprint(delivery.command);
      const native = { threadId, messageId: delivery.command.messageId,
        commandFingerprint, target: delivery.command.target };
      assert.isNull(yield* service.authorizeNative(native));
      yield* store.claimStrictSubmission(request.requestId, sending.revision, sending.state.fingerprint, delivery);
      assert.isNull(yield* service.authorizeNative(native));
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* outbox.enqueue([{
        id: `${STRICT_STEER_EFFECT_PREFIX}${commandFingerprint}`, commandId: delivery.command.commandId,
        threadId, request: { type: "provider-turn.steer", providerSessionId, providerThreadId,
          providerTurnId, messageId: delivery.command.messageId },
      }]);
      yield* outbox.claimNext({ workerId: "validator-fixture" });
      const authorized = yield* service.authorizeNative(native);
      assert.isString(authorized);
      yield* Ref.set(provider, { ...baseProvider, driver: baseSourceProvider.driver });
      assert.isNull(yield* service.authorizeNative(native));
      yield* Ref.set(provider, baseProvider);
      yield* sink.write({ events: [{
        ...base, id: EventId.make("strict-provider-session-changed"), type: "provider-thread.updated",
        payload: { ...providerThread, providerSessionId: ProviderSessionId.make("other-session") },
      }] });
      assert.isNull(yield* service.authorizeNative(native));
      yield* sink.write({ events: [{
        ...base, id: EventId.make("strict-provider-session-restored"), type: "provider-thread.updated",
        payload: providerThread,
      }] });
      assert.equal(yield* service.authorizeNative(native), authorized);
      yield* Ref.set(sourceProvider, changedSourceEndpoint);
      const changedAuthority = yield* service.authorizeNative(native);
      assert.isString(changedAuthority);
      assert.notEqual(changedAuthority, authorized);
      yield* Ref.set(sourceProvider, { ...baseSourceProvider, models: [] });
      assert.isNull(yield* service.authorizeNative(native));
      yield* Ref.set(sourceProvider, baseSourceProvider);
      assert.equal(yield* service.authorizeNative(native), authorized);
      yield* Ref.set(provider, { ...baseProvider, auth: { status: "authenticated", profileId: "changed" } });
      assert.notEqual(yield* service.authorizeNative(native), authorized);
      yield* Ref.set(provider, baseProvider);
      assert.isNull(yield* service.authorizeNative({ ...native, commandFingerprint: "changed" }));
      yield* Ref.set(provider, { ...baseProvider, auth: { status: "unauthenticated" } });
      assert.isNull(yield* service.authorizeNative(native));
      yield* Ref.set(provider, baseProvider);

      yield* sink.write({ events: [{
        ...base, id: EventId.make("changed-source-mode"), threadId: sourceId,
        type: "thread.runtime-mode-updated",
        providerInstanceId: sourceInstanceId,
        payload: { ...sourceThread, runtimeMode: "full-access" },
      }] });
      assert.isNull(yield* service.authorizeNative(native));

      yield* sink.write({ events: [{
        ...base, id: EventId.make("restored-source-mode"), threadId: sourceId,
        type: "thread.runtime-mode-updated",
        providerInstanceId: sourceInstanceId, payload: sourceThread,
      }] });
      assert.isString(yield* service.authorizeNative(native));
      const sql = yield* SqlClient.SqlClient;
      // Even a corrupted duplicate association must not choose one row by order.
      yield* sql`INSERT INTO durable_routes(request_id, fingerprint, revision, status, state_json)
        SELECT 'duplicate-claim', fingerprint, revision, status, state_json
        FROM durable_routes WHERE request_id = ${request.requestId}`;
      assert.isNull(yield* service.authorizeNative(native));
      yield* sql`DELETE FROM durable_routes WHERE request_id = 'duplicate-claim'`;
      assert.equal(yield* service.authorizeNative(native), authorized);

      // A unique row with a malformed proof must also fail closed.
      yield* sql`UPDATE durable_routes
        SET state_json = json_set(state_json, '$.strictSubmission.descriptorFingerprint', ${"f".repeat(64)})
        WHERE request_id = ${request.requestId}`;
      const rejected = yield* Effect.flip(store.get(request.requestId));
      assert.equal(rejected.operation, "get");
      assert.isNull(yield* service.authorizeNative(native));
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("keeps the durable manual idle command exact across revocation and first-lease recovery", () =>
  Effect.gen(function* () {
    const provider = yield* Ref.make(baseProvider);
    const sourceProvider = yield* Ref.make(baseSourceProvider);
    const getProviders = Effect.all([Ref.get(provider), Ref.get(sourceProvider)]);
    const external = yield* Ref.make<ExternalRouteSourceSnapshot | null>(null);
    const resolved = yield* Ref.make<ProviderAdapterV2RuntimePolicy>(policy);
    const stores = Layer.mergeAll(
      ProjectionStore.layer, EventStore.layer, EffectOutbox.layer, CommandReceiptStore.layer, ProjectStore.layer,
    );
    const layer = Orchestrator.layer.pipe(
      Layer.provideMerge(layerV2RouteAdmission),
      Layer.provideMerge(Layer.mergeAll(
        Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(environmentId) }),
        Layer.mock(ProviderRegistry)({ getProviders }),
        Layer.effect(
          ExternalRouteEndpoints,
          Effect.map(ExternalRouteEndpoints, (endpoints) => ({
            ...endpoints,
            source: () => Ref.get(external),
          })),
        ).pipe(Layer.provide(ExternalRouteEndpoints.layer)),
        Layer.mock(CheckpointServiceV2)({}), Layer.mock(ProviderAdapterRegistryV2)({}),
        Layer.mock(ProviderSessionManagerV2)({}), Layer.mock(ProviderSwitchServiceV2)({}),
        IdAllocator.layer, CommandPolicy.layer, ProviderContinuationRequests.layer, ThreadForkService.layer,
        ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer)),
        Layer.succeed(RuntimePolicyV2, { resolve: () => Ref.get(resolved) }),
        ServerSettings.layerTest({ chatRoutingMode: "off" }),
      )),
      Layer.provideMerge(EventSink.layer),
      Layer.provideMerge(stores),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provide(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const { sink, base, thread } = yield* seed();
      const projects = yield* ProjectStore.ProjectStoreV2;
      const createdAt = DateTime.formatIso(thread.createdAt);
      yield* projects.apply({
        sequence: 1, eventId: EventId.make("idle-project-created"), aggregateKind: "project", aggregateId: projectId,
        occurredAt: createdAt, commandId: null, causationEventId: null, correlationId: null, metadata: {},
        type: "project.created",
        payload: {
          projectId, title: "Idle project", workspaceRoot: "/workspace", defaultModelSelection: modelSelection,
          scripts: [], createdAt, updatedAt: createdAt,
        },
      });
      const idleId = ThreadId.make("idle-target");
      const idle = { ...thread, id: idleId, activeProviderThreadId: null,
        lineage: { rootThreadId: idleId, parentThreadId: null, relationshipToParent: null } };
      const now = thread.createdAt;
      yield* sink.write({ events: [{
        ...base, id: EventId.make("idle-created"), threadId: idleId, type: "thread.created", payload: idle,
      }] });
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const store = yield* makeDurableRoutingStore;
      const service = yield* V2RouteAdmission;
      const worker = yield* EffectOutbox.EffectOutboxV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const foreignTarget = ThreadId.make("foreign-idle-target");
      const foreignSource = {
        environmentId, projectId: ProjectId.make("foreign-project"), threadId: ThreadId.make("mausbot:native-source"),
      };
      yield* sink.write({ events: [{
        ...base, id: EventId.make("foreign-idle-created"), threadId: foreignTarget, type: "thread.created",
        payload: { ...idle, id: foreignTarget, runtimeMode: "full-access",
          lineage: { ...idle.lineage, rootThreadId: foreignTarget } },
      }] });
      yield* Ref.set(resolved, { ...policy, runtimeMode: "full-access" });
      const foreignRequest = {
        ...request, requestId: "foreign-idle", initiation: "manual" as const, source: foreignSource,
        destination: { environmentId, projectId, threadId: foreignTarget },
        permissionCeiling: ["runtime:full-access"], destinationPermissions: ["runtime:full-access"],
      };
      const foreignRow = yield* store.create(foreignRequest);
      const foreignShell = yield* projection.getThreadShell(foreignTarget);
      if (!foreignShell) return yield* Effect.die("missing foreign route destination");
      const foreignDraft = idleRouteDraft(foreignRow, "foreign-attempt", foreignShell);
      assert.isNull(yield* service.prepareIdle(foreignRow, foreignDraft));
      const nativeSource = {
        endpoint: foreignSource, url: "https://example.invalid/native", archived: false,
        permissionsKnown: true, providerKey: "mausbot-provider", runtimeMode: "full-access",
      } as const;
      yield* Ref.set(external, nativeSource);
      const foreignAuthority = yield* service.prepareIdle(foreignRow, foreignDraft);
      if (!foreignAuthority) return yield* Effect.die("verified native source should be admitted");
      assert.isNull(yield* projection.getThreadShell(foreignSource.threadId));
      const foreignCommand = { ...foreignDraft, ...foreignAuthority };
      yield* store.claimIdleSubmission(foreignCommand.requestId, foreignRow.revision, foreignRow.state.fingerprint, foreignCommand);
      assert.isString(yield* service.authorizeIdle(foreignCommand, "intake"));
      for (const snapshot of [
        null,
        { ...nativeSource, permissionsKnown: false },
        { ...nativeSource, archived: true },
        { ...nativeSource, providerKey: "changed-provider" },
        { ...nativeSource, endpoint: { ...foreignSource, projectId } },
      ]) {
        yield* Ref.set(external, snapshot);
        assert.isNull(yield* service.authorizeIdle(foreignCommand, "intake"));
      }
      yield* Ref.set(external, nativeSource);
      assert.isString(yield* service.authorizeIdle(foreignCommand, "intake"));
      yield* Ref.set(resolved, policy);

      const row = yield* store.create({
        ...request, requestId: "manual-idle", initiation: "manual", taskId: "unbound-manual-owner",
        destination: { environmentId, projectId, threadId: idleId },
      });
      const shell = yield* projection.getThreadShell(idleId);
      if (!shell) return yield* Effect.die("missing idle shell");
      const draft = idleRouteDraft(row, "only-idle-attempt", shell);
      yield* Ref.set(provider, { ...baseProvider, models: [] });
      assert.isNull(yield* service.prepareIdle(row, draft));
      assert.isNull(yield* service.readIdleClaim(draft.runId, draft.messageId));
      assert.deepEqual(yield* worker.listByCommandId(draft.commandId), []);
      yield* Ref.set(provider, baseProvider);
      const authority = yield* service.prepareIdle(row, draft);
      if (!authority) return yield* Effect.die("manual idle source and destination should validate");
      const command = { ...draft, ...authority };
      assert.isNull(yield* service.authorizeIdle(command, "intake"));
      const claimed = yield* store.claimIdleSubmission(command.requestId, row.revision, row.state.fingerprint, command);
      assert.equal(claimed.state.status, "sending");
      assert.equal((yield* Effect.result(store.claimIdleSubmission(
        command.requestId, row.revision, row.state.fingerprint, { ...command, text: "changed" },
      )))._tag, "Failure");
      assert.isString(yield* service.authorizeIdle(command, "intake"));
      yield* Ref.set(provider, { ...baseProvider, driver: baseSourceProvider.driver });
      assert.isNull(yield* service.authorizeIdle(command, "intake"));
      yield* Ref.set(provider, { ...baseProvider, enabled: false });
      assert.isNull(yield* service.authorizeIdle(command, "intake"));
      yield* Ref.set(provider, baseProvider);
      yield* Ref.set(resolved, { ...policy, cwd: "/changed" });
      assert.isNull(yield* service.authorizeIdle(command, "intake"));
      yield* Ref.set(resolved, policy);
      const pending: OrchestrationV2RuntimeRequest = {
        id: RuntimeRequestId.make("idle-permission"),
        nodeId: rootNodeId, providerTurnId: null, nativeRequestRef: null,
        kind: "user_input", status: "pending", responseCapability: { type: "message" },
        createdAt: now, resolvedAt: null,
      };
      yield* sink.write({ events: [{
        id: EventId.make("idle-awaiting-permission"), type: "runtime-request.updated", threadId: idleId,
        occurredAt: now, payload: pending,
      }] });
      assert.isNull(yield* service.authorizeIdle(command, "intake"));
      yield* sink.write({ events: [{
        id: EventId.make("idle-permission-resolved"), type: "runtime-request.updated", threadId: idleId,
        occurredAt: now, payload: { ...pending, status: "resolved", resolvedAt: now },
      }] });
      assert.isString(yield* service.authorizeIdle(command, "intake"));

      yield* store.recoverInterruptedSends();
      assert.deepEqual(yield* service.readIdleClaim(command.runId, command.messageId), command);
      assert.equal((yield* readIdleDeliveryEvidence(command)).evidence, "uncertain");
      assert.equal((yield* store.get(command.requestId))?.state.status, "uncertain");

      const attempt = {
        id: RunAttemptId.make("idle-run-attempt"), runId: command.runId, attemptOrdinal: 1,
        rootNodeId, providerInstanceId: instanceId, providerThreadId, providerTurnId: null,
        reason: "initial", status: "pending", startedAt: null, completedAt: null,
      } satisfies OrchestrationV2RunAttempt;
      const run = {
        id: command.runId, threadId: idleId, ordinal: 1, providerInstanceId: instanceId,
        modelSelection, providerThreadId, userMessageId: command.messageId, rootNodeId,
        activeAttemptId: attempt.id, status: "starting", requestedAt: now, startedAt: null,
        completedAt: null, checkpointId: null, contextHandoffId: null,
      } satisfies OrchestrationV2Run;
      const effectId = `effect:${command.commandId}:provider-turn.start:${command.runId}`;
      yield* sink.commitCommand({
        commandId: command.commandId, commandType: command.type, threadId: idleId, acceptedAt: now,
        events: [
          { type: "run.created", id: EventId.make("idle-run"), threadId: idleId, runId: run.id,
            occurredAt: now, payload: run },
          { type: "run-attempt.created", id: EventId.make("idle-attempt"), threadId: idleId, runId: run.id,
            occurredAt: now, payload: attempt },
          { type: "message.updated", id: EventId.make("idle-message"), threadId: idleId, runId: run.id,
            occurredAt: now, payload: {
              id: command.messageId, threadId: idleId, runId: run.id, nodeId: rootNodeId,
              role: "user", createdBy: "agent", creationSource: "server", text: command.text,
              senderThreadId: sourceId, attachments: [], streaming: false, createdAt: now, updatedAt: now,
              idleRouteFingerprint: strictSteerFingerprint(command),
            } },
        ],
        effects: [{ id: effectId, commandId: command.commandId, threadId: idleId,
          request: { type: "provider-turn.start", runId: run.id } }],
      });
      assert.isNull(yield* service.authorizeIdle(command, "intake"));
      yield* sink.write({ events: [{
        id: EventId.make("input-open-before-replay"), type: "runtime-request.updated", threadId: idleId,
        occurredAt: now, payload: pending,
      }] });
      yield* Ref.set(sourceProvider, changedSourceEndpoint);
      assert.isTrue((yield* orchestrator.dispatch(command)).replayed === true);
      yield* Ref.set(sourceProvider, baseSourceProvider);
      assert.equal((yield* Effect.result(orchestrator.dispatch({ ...command, text: "changed replay" })))._tag, "Failure");
      const raced = yield* store.create({ ...row.state.request, requestId: "raced-idle-route" });
      const racedDraft = idleRouteDraft(raced, "raced-attempt", shell);
      const racedCommand = { ...racedDraft, ...authority };
      yield* store.claimIdleSubmission(racedCommand.requestId, raced.revision, raced.state.fingerprint, racedCommand);
      assert.equal((yield* Effect.result(orchestrator.dispatch(racedCommand)))._tag, "Failure");
      assert.deepEqual(yield* worker.listByCommandId(racedCommand.commandId), []);
      assert.equal((yield* readIdleDeliveryEvidence(racedCommand)).evidence, "failed");
      assert.equal((yield* readIdleDeliveryEvidence(command)).evidence, "admitted");
      const workerId = "idle-route-fixture";
      yield* worker.claimNext({ workerId });
      assert.isNull(yield* service.authorizeIdle(command, "starting", workerId));
      yield* sink.write({ events: [{
        id: EventId.make("input-resolved-after-replay"), type: "runtime-request.updated", threadId: idleId,
        occurredAt: now, payload: { ...pending, status: "resolved", resolvedAt: now },
      }] });
      assert.equal(yield* service.authorizeIdle(command, "starting"), workerId);
      assert.isNull(yield* service.authorizeIdle(command, "starting", "foreign-worker"));
      yield* Ref.set(provider, { ...baseProvider, auth: { status: "unauthenticated" } });
      assert.isNull(yield* service.authorizeIdle(command, "starting", workerId));
      yield* Ref.set(provider, baseProvider);
      yield* worker.succeed({ effectId, workerId });
      assert.isNull(yield* service.authorizeIdle(command, "starting", workerId));
      assert.equal((yield* readIdleDeliveryEvidence(command)).evidence, "uncertain");
      yield* sink.write({ events: [
        { type: "run-attempt.updated", id: EventId.make("idle-native-attempt"), threadId: idleId, runId: run.id,
          occurredAt: now, payload: { ...attempt, status: "running", startedAt: now, providerTurnId } },
        { type: "provider-turn.updated", id: EventId.make("idle-native-ack"), threadId: idleId, runId: run.id,
          occurredAt: now, payload: {
            id: providerTurnId, providerThreadId, runAttemptId: attempt.id, nodeId: rootNodeId,
            ordinal: 1, status: "running", startedAt: now, completedAt: null,
            nativeTurnRef: { driver, strength: "strong", nativeId: "native-idle-turn" },
          } },
      ] });
      const evidence = yield* readIdleDeliveryEvidence(command);
      assert.equal(evidence.evidence, "delivered");
      const latest = yield* store.get(command.requestId);
      if (!latest?.state.idleSubmission) return yield* Effect.die("missing saved claim");
      const final = yield* store.settleIdleSubmission(command.requestId, latest.revision,
        latest.state.idleSubmission.commandFingerprint, evidence.evidence);
      assert.equal(final.state.status, "delivered");
      assert.deepEqual(yield* store.queued(), []);
    }).pipe(Effect.provide(layer));
  }),
);
