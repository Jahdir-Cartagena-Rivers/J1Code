import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId, EnvironmentId, EventId, MessageId, ProjectId, ProviderInstanceId,
  ProviderSessionId, ProviderThreadId, ProviderTurnId, RunAttemptId, RunId, ThreadId,
  type OrchestrationV2AppThread, type OrchestrationV2StoredEvent,
} from "@j1code/contracts";
import { DateTime, Deferred, Effect, Layer } from "effect";

import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Outbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { makeDurableRoutingStore } from "./durableRoutingStore.ts";
import { strictRouteDescriptorFingerprint, type RouteRequest } from "./routeState.ts";
import { makeRouteTransportConsumer, strictRouteWakeCommand } from "./transportConsumer.ts";
import type { PreparedStrictRouteDelivery } from "./v2StrictDelivery.ts";

const request = {
  requestId: "strict-route",
  source: { environmentId: "local", projectId: "project", threadId: "source" },
  destination: { environmentId: "local", projectId: "project", threadId: "target" },
  content: "Use the already active turn.",
  permissionCeiling: [],
  destinationPermissions: [],
  visited: [],
  maxHops: 2,
  ambiguous: false,
  mode: "auto",
  initiation: "manual",
  monitorSource: true,
} satisfies RouteRequest;
const deliveryAttempt = "attempt-1";
const routeMode = { runtimeMode: "approval-required", interactionMode: "default" } as const;
const source = {
  environmentId: EnvironmentId.make(request.source.environmentId),
  threadId: ThreadId.make(request.source.threadId),
};
const destination = {
  ...routeMode,
  environmentId: EnvironmentId.make(request.destination.environmentId),
  threadId: ThreadId.make(request.destination.threadId),
  projectId: ProjectId.make(request.destination.projectId),
  providerInstanceId: ProviderInstanceId.make("codex"),
  runId: RunId.make("run"),
};
const target = {
  ...routeMode,
  projectId: destination.projectId,
  providerInstanceId: destination.providerInstanceId,
  runId: destination.runId,
  attemptId: RunAttemptId.make("run-attempt"),
  providerSessionId: ProviderSessionId.make("provider-session"),
  providerThreadId: ProviderThreadId.make("provider-thread"),
  providerTurnId: ProviderTurnId.make("provider-turn"),
  nativeThreadId: "native-thread",
  nativeTurnId: "native-turn",
  policyFingerprint: "policy",
};
const identity = strictRouteDescriptorFingerprint([request.requestId, deliveryAttempt]);
const prepared: PreparedStrictRouteDelivery = {
  attempt: {
    requestId: request.requestId, attemptId: deliveryAttempt, source, destination,
    ceiling: routeMode, text: request.content, attachments: [],
  },
  command: {
    type: "message.steer-strict",
    commandId: CommandId.make(`command:route-steer:${identity}`),
    messageId: MessageId.make(`message:route-steer:${identity}`),
    threadId: destination.threadId, senderThreadId: source.threadId, target,
    createdBy: "agent", creationSource: "server", text: request.content, attachments: [],
  },
};
const effectId = `effect:strict-steer:${strictRouteDescriptorFingerprint(prepared.command)}`;


const layer = EventSink.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Projection.layer, EventStore.layer, Receipts.layer, Outbox.layer)),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(NodeServices.layer),
);

it.effect("uses claimed exact V2 evidence, and wakes once for native settlement", () =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const now = yield* DateTime.now;
    const store = yield* makeDurableRoutingStore;
    const sink = yield* EventSink.EventSinkV2;
    const outbox = yield* Outbox.EffectOutboxV2;
    const settled = yield* Deferred.make<void>();
    let notices = 0;
    const consumer = yield* makeRouteTransportConsumer({
      scope, withRouteFence: (_id, work) => work,
      wake: Deferred.succeed(settled, undefined).pipe(Effect.asVoid),
      notify: () => Effect.sync(() => { notices += 1; return "published" as const; }),
    });
    let row = yield* store.create(request);
    row = yield* store.transition(request.requestId, row.revision, { type: "begin-send", attemptId: deliveryAttempt });
    yield* store.claimStrictSubmission(request.requestId, row.revision, row.state.fingerprint, prepared);
    yield* store.recoverInterruptedSends();
    yield* consumer.recover();
    yield* consumer.recover();
    assert.equal((yield* store.get(request.requestId))?.state.status, "uncertain");
    assert.deepEqual(yield* store.queued(), []);
    assert.equal(notices, 0);
    assert.isNull(strictRouteWakeCommand({ event: { type: "thread.activity-appended" } } as unknown as OrchestrationV2StoredEvent));

    const threadId = destination.threadId;
    const thread: OrchestrationV2AppThread = {
      id: threadId, projectId: destination.projectId, title: "Strict route", createdBy: "user",
      creationSource: "web", providerInstanceId: destination.providerInstanceId,
      modelSelection: { instanceId: destination.providerInstanceId, model: "test" },
      runtimeMode: routeMode.runtimeMode, interactionMode: routeMode.interactionMode, branch: null,
      worktreePath: null, activeProviderThreadId: null,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null, createdAt: now, updatedAt: now, archivedAt: null, deletedAt: null,
      settledOverride: null, settledAt: null, snoozedUntil: null, snoozedAt: null, lastVisitedAt: null,
    };
    yield* sink.write({ events: [{
      type: "thread.created", id: EventId.make("strict-created"), occurredAt: now,
      threadId, payload: thread,
    }] });
    const command = prepared.command;
    const committed = yield* sink.commitCommand({
      commandId: command.commandId, commandType: command.type, threadId, acceptedAt: now,
      events: [{
        id: EventId.make("strict-committed"), occurredAt: now, type: "message.updated", threadId,
        payload: {
          id: command.messageId, threadId, runId: target.runId, nodeId: null, role: "user",
          createdBy: "agent", creationSource: "server", text: command.text, attachments: [], streaming: false,
          createdAt: now, updatedAt: now,
          strictSteer: { target, commandFingerprint: strictRouteDescriptorFingerprint(command) },
        },
      }],
      effects: [{
        id: effectId, commandId: command.commandId, threadId, request: {
          type: "provider-turn.steer", providerSessionId: target.providerSessionId,
          providerThreadId: target.providerThreadId, providerTurnId: target.providerTurnId,
          messageId: command.messageId,
        },
      }],
    });
    const [event] = committed.storedEvents;
    if (event === undefined) return yield* Effect.die("Expected the persisted command event");
    yield* consumer.consume({ ...event, commandId: CommandId.make("foreign-command") });
    assert.equal((yield* store.get(request.requestId))?.state.status, "uncertain");
    yield* consumer.consume(event);
    yield* consumer.consume(event);
    assert.equal((yield* store.get(request.requestId))?.state.status, "admitted");
    assert.equal(notices, 1);
    const workerId = "transport-fixture";
    yield* outbox.claimNext({ workerId });
    assert.isTrue(yield* outbox.succeed({ effectId, workerId }));
    yield* Deferred.await(settled);
    assert.equal((yield* store.get(request.requestId))?.state.status, "delivered");
    assert.equal(notices, 2);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
