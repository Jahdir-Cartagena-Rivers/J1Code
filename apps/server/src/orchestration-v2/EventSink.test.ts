import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  NodeId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@j1code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { projectStoredEventForWire } from "./WireProjection.ts";

const threadFixture = (
  sourceId: ThreadId,
  now: DateTime.Utc,
  providerInstanceId: ProviderInstanceId,
): OrchestrationV2AppThread => {
  return {
    id: sourceId,
    projectId: ProjectId.make("project"),
    title: "Source",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: sourceId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
  };
};

const layer = EventSink.layer.pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
  Layer.provide(Sqlite.layerMemory),
);

it.effect("pages V2 command replay across malformed V1 and unrelated rows", () =>
  Effect.gen(function* () {
    const store = yield* EventStore.EventStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("paged-command-replay");
    const unrelatedId = ThreadId.make("unrelated-command-replay");
    const commandId = CommandId.make("route[?*]:replay");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const event = (index: number, id: ThreadId) => ({
      id: EventId.make(`paged-replay:${index}`),
      type: "thread.created" as const,
      threadId: id,
      occurredAt: now,
      payload: threadFixture(id, now, providerInstanceId),
    });
    const head = yield* store.append({
      commandId,
      events: Array.from({ length: 250 }, (_, index) => event(index, threadId)),
    });
    const [decoy] = yield* store.append({
      commandId: CommandId.make("route[?*]:other"),
      events: [event(250, unrelatedId)],
    });
    yield* sql`INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, command_id,
      occurred_at, actor_kind, payload_json, metadata_json, application_event_version
    ) VALUES (
      'legacy-paged-command-replay', 'thread', 'legacy-replay-stream', 1, 'thread.created',
      ${commandId}, ${DateTime.formatIso(now)}, 'server', '{', '{}', 1
    )`;
    const tail = yield* store.append({
      commandId,
      events: Array.from({ length: 253 }, (_, index) => event(index + 251, threadId)),
    });
    const [suffix] = yield* store.append({
      commandId: CommandId.make(`${commandId}:child`),
      events: [event(504, unrelatedId)],
    });
    yield* sql`UPDATE orchestration_events
      SET payload_json = ${"{"} WHERE sequence = ${decoy!.sequence}`;
    const sequences = [...head, ...tail].map(({ sequence }) => sequence);
    const exact = yield* store.readByCommandId({ commandId }).pipe(Stream.runCollect);
    assert.deepEqual(exact.map(({ sequence }) => sequence), sequences);
    const prefix = yield* store.read({
      commandIdPrefix: commandId, afterSequence: sequences[0]!, limit: 501,
    }).pipe(Stream.runCollect);
    assert.deepEqual(prefix.map(({ sequence }) => sequence), sequences.slice(1, 502));
    const prefixTail = yield* store.read({
      commandIdPrefix: commandId, afterSequence: prefix.at(-1)!.sequence, limit: 10,
    }).pipe(Stream.runCollect);
    assert.deepEqual(prefixTail.map(({ sequence }) => sequence), [...sequences.slice(502), suffix!.sequence]);
    assert.deepEqual(
      yield* store.readByCommandId({ commandId: CommandId.make("route[?*]:missing") })
        .pipe(Stream.runCollect),
      [],
    );

    const page = yield* store.read({ threadId, afterSequence: sequences[0]!, limit: 501 })
      .pipe(Stream.runCollect);
    assert.deepEqual(page.map(({ sequence }) => sequence), sequences.slice(1, 502));
    const remaining = yield* store.read({ threadId, afterSequence: page.at(-1)!.sequence, limit: 10 })
      .pipe(Stream.runCollect);
    assert.deepEqual(remaining.map(({ sequence }) => sequence), sequences.slice(502));

    const error = yield* store.read({ afterSequence: decoy!.sequence - 1, limit: 1 })
      .pipe(Stream.runCollect, Effect.flip);
    assert.equal(error._tag, "EventStoreReadEventsError");
  }).pipe(Effect.provide(EventStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("rejects a planned fork whose source was deleted before it committed", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const sourceId = ThreadId.make("fork-source");
    const targetId = ThreadId.make("fork-target");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const source = threadFixture(sourceId, now, providerInstanceId);
    yield* sink.write({
      events: [
        {
          id: EventId.make("source-created"),
          type: "thread.created",
          threadId: sourceId,
          occurredAt: now,
          payload: source,
        },
      ],
    });
    const plannedFork = {
      commandId: CommandId.make("fork"),
      commandType: "thread.fork",
      threadId: targetId,
      acceptedAt: now,
      effects: [],
      events: [
        {
          id: EventId.make("fork-created"),
          type: "thread.created" as const,
          threadId: targetId,
          occurredAt: now,
          payload: {
            ...source,
            id: targetId,
            forkedFrom: { type: "run" as const, threadId: sourceId, runId: RunId.make("run") },
          },
        },
      ],
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make("source-deleted"),
          type: "thread.deleted",
          threadId: sourceId,
          occurredAt: now,
          payload: { ...source, deletedAt: now },
        },
      ],
    });
    const rejected = yield* sink.commitCommand(plannedFork);
    assert.equal(rejected.receipt.status, "rejected");
    assert.isFalse(rejected.committed);
    const replayed = yield* sink.commitCommand(plannedFork);
    assert.deepEqual(replayed.receipt, rejected.receipt);
    assert.isFalse(replayed.committed);
    const missing = yield* projections.getThread(targetId).pipe(Effect.flip);
    assert.instanceOf(missing, ProjectionStore.ProjectionStoreThreadNotFoundError);
  }).pipe(Effect.provide(layer)),
);

it.effect("commits durable route intake privately and preserves the original owner across replay", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "route-intake-event-sink-" });
    const database = () => EventSink.layer.pipe(
      Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
      Layer.provideMerge(Sqlite.layerFromPath(path.join(directory, "state.sqlite"))),
    );
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("route-source");
    const projectId = ProjectId.make("project");
    const runId = RunId.make("first-run");
    const messageId = MessageId.make("authored");
    const source = { threadId, projectId, runId, messageId };
    const owner = { subject: "fixture-private-intake-owner", environmentId: "fixture-environment" };
    const makeCommand = (id: string, message = messageId, run = runId, subject = owner.subject) => ({
      commandId: CommandId.make(id),
      threadId,
      commandType: "message.dispatch",
      acceptedAt: now,
      effects: [],
      routeIntake: { ...owner, subject, messageId: message },
      events: [{
        id: EventId.make(id),
        type: "message.updated" as const,
        threadId,
        runId: run,
        occurredAt: now,
        payload: {
          id: message, threadId, runId: run, nodeId: null, role: "user" as const,
          createdBy: "user" as const, creationSource: "web" as const,
          text: "authored prompt", attachments: [], streaming: false, createdAt: now, updatedAt: now,
        },
      }],
    });
    const assertPrivate = (items: unknown) => {
      assert.notInclude(JSON.stringify(items), owner.subject);
      assert.notInclude(JSON.stringify(items), "routeIntake");
    };
    const sequence = yield* Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      yield* sink.write({ events: [{
        id: EventId.make("route-source-created"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: threadFixture(threadId, now, ProviderInstanceId.make("deepai")),
      }] });
      const accepted = yield* sink.commitCommand(makeCommand("original"));
      assert.isTrue(accepted.committed);
      assert.deepEqual(yield* sink.readRouteIntake!(source), owner);
      const replay = yield* sink.commitCommand(makeCommand("original", messageId, runId, "foreign"));
      assert.isFalse(replay.committed);
      assert.deepEqual(replay.receipt, accepted.receipt);
      assertPrivate(replay.storedEvents.map(projectStoredEventForWire));
      const duplicateRun = RunId.make("duplicate-run");
      yield* sink.commitCommand(makeCommand("duplicate", messageId, duplicateRun, "foreign"));
      assert.isUndefined(yield* sink.readRouteIntake!({ ...source, runId: duplicateRun }));
      assert.deepEqual(yield* sink.readRouteIntake!(source), owner);
      yield* sql`CREATE TRIGGER abort_route_intake_fixture BEFORE UPDATE OF metadata_json ON orchestration_events
        WHEN NEW.event_id = 'rollback' BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END`;
      const rollbackMessage = MessageId.make("rollback-message");
      const failure = yield* sink.commitCommand(makeCommand("rollback", rollbackMessage)).pipe(Effect.result);
      assert.equal(failure._tag, "Failure");
      const rolledBack = yield* Stream.runCollect(sink.readByCommandId({ commandId: CommandId.make("rollback") }));
      assert.lengthOf(rolledBack, 0);
      assert.isUndefined(yield* sink.readRouteIntake!({ ...source, messageId: rollbackMessage }));
      yield* sql`DROP TRIGGER abort_route_intake_fixture`;
      assert.isTrue((yield* sink.commitCommand(makeCommand("rollback", rollbackMessage))).committed);
      return accepted.receipt.resultSequence;
    }).pipe(Effect.provide(database()));
    yield* Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      assert.deepEqual(yield* sink.readRouteIntake!(source), owner);
      assert.isUndefined(yield* sink.readRouteIntake!({ ...source, projectId: ProjectId.make("foreign") }));
      const subscriber = yield* sink.stream({
        threadId, bounded: true, eventType: "message.updated", afterSequence: sequence - 1,
      }).pipe(Stream.take(1), Stream.runCollect);
      assert.lengthOf(subscriber, 1);
      assertPrivate(subscriber.map(projectStoredEventForWire));
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const projection = yield* projections.getThreadProjection(threadId);
      assertPrivate(projection.messages);
    }).pipe(Effect.provide(database()));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rechecks saved input and approval holds when committing a planned route after reopening", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "route-pending-event-sink-" });
    const database = () => EventSink.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(EventStore.layer, ProjectionStore.layer, EffectOutbox.layer)),
      Layer.provideMerge(Sqlite.layerFromPath(path.join(directory, "state.sqlite"))),
    );
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("waiting-destination");
    const runId = RunId.make("route-run");
    const nodeId = NodeId.make("route-node");
    const plan = (id: string, commandType = "thread.route.deliver-idle") => {
      const commandId = CommandId.make(id);
      return {
        commandId, threadId, commandType, acceptedAt: now,
        events: [{
          id: EventId.make(id), type: "message.updated" as const, threadId, runId, occurredAt: now,
          payload: {
            id: MessageId.make(id), threadId, runId, nodeId: null,
            role: "user" as const, createdBy: "agent" as const, creationSource: "server" as const,
            text: id, attachments: [], streaming: false, createdAt: now, updatedAt: now,
          },
        }],
        effects: [{
          id: `effect:${id}`, commandId, threadId,
          request: { type: "provider-turn.start" as const, runId },
        }],
      };
    };
    const hold = (kind: "user_input" | "permission", status: "pending" | "resolved") => ({
      id: EventId.make(`${kind}:${status}`), type: "runtime-request.updated" as const, threadId, occurredAt: now,
      payload: {
        id: RuntimeRequestId.make(kind), nodeId, providerTurnId: null, nativeRequestRef: null,
        kind, status, responseCapability: { type: "message" as const }, createdAt: now,
        resolvedAt: status === "resolved" ? now : null,
      },
    });
    const previous = plan("already-accepted");
    const idle = plan("blocked-idle");
    const strictPlan = (id: string) => {
      const command = plan(id, "message.steer-strict");
      return {
        ...command,
        effects: [{
          ...command.effects[0]!,
          request: {
            type: "provider-turn.steer" as const,
            providerSessionId: ProviderSessionId.make("route-session"),
            providerThreadId: ProviderThreadId.make("route-native-thread"),
            providerTurnId: ProviderTurnId.make("route-active-turn"),
            messageId: MessageId.make(id),
          },
        }],
      };
    };
    const strict = strictPlan("blocked-strict");

    const accepted = yield* Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const instanceId = ProviderInstanceId.make("codex");
      yield* sink.write({ events: [{
        id: EventId.make("waiting-destination-created"), type: "thread.created", threadId, occurredAt: now,
        payload: threadFixture(threadId, now, instanceId),
      }, {
        id: EventId.make("waiting-destination-run"), type: "run.created", threadId, runId, occurredAt: now,
        payload: {
          id: runId, threadId, ordinal: 1, providerInstanceId: instanceId,
          modelSelection: { instanceId, model: "gpt-5" },
          providerThreadId: ProviderThreadId.make("route-native-thread"),
          userMessageId: MessageId.make("already-accepted"), rootNodeId: nodeId,
          activeAttemptId: null, status: "running", requestedAt: now, startedAt: now,
          completedAt: null, checkpointId: null, contextHandoffId: null,
        },
      }] });
      const result = yield* sink.commitCommand(previous);
      assert.isTrue(result.committed);
      // The plans above represent commands checked before these provider writes.
      yield* sink.write({ events: [hold("user_input", "pending"), hold("permission", "pending")] });
      return result.receipt;
    }).pipe(Effect.provide(database()));

    yield* Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const replay = yield* sink.commitCommand(previous);
      assert.isFalse(replay.committed);
      assert.deepEqual(replay.receipt, accepted);
      assert.lengthOf(replay.storedEvents, 1);
      assert.lengthOf(yield* outbox.listByCommandId(previous.commandId), 1);
      for (const command of [idle, strict]) {
        const rejected = yield* sink.commitCommand(command);
        assert.equal(rejected.receipt.status, "rejected");
        assert.match(rejected.receipt.error ?? "", /awaiting approval or user input/);
        assert.isEmpty(rejected.storedEvents);
        assert.isEmpty(yield* outbox.listByCommandId(command.commandId));
      }
      // Regular follow-up planning can still save a message while the route is held.
      const followup = plan("local-followup", "message.dispatch");
      assert.isTrue((yield* sink.commitCommand({ ...followup, effects: [] })).committed);
      yield* sink.write({ events: [hold("user_input", "resolved")] });
      assert.equal((yield* sink.commitCommand(plan("still-held"))).receipt.status, "rejected");
      yield* sink.write({ events: [hold("permission", "resolved")] });
      assert.equal((yield* sink.commitCommand(idle)).receipt.status, "rejected");
      assert.isTrue((yield* sink.commitCommand(plan("allowed-after-resolution"))).committed);

      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const beforeSteer = yield* projections.getThreadRecords(threadId, ["runs", "messages"]);
      assert.deepEqual(beforeSteer.runs.map(({ id, status }) => ({ id, status })), [
        { id: runId, status: "running" },
      ]);
      const steer = strictPlan("allowed-strict");
      const committed = yield* sink.commitCommand(steer);
      assert.isTrue(committed.committed);
      assert.deepEqual(committed.storedEvents.map(({ event }) => event.type), ["message.updated"]);
      const afterSteer = yield* projections.getThreadRecords(threadId, ["runs", "messages"]);
      assert.deepEqual(afterSteer.runs, beforeSteer.runs);
      assert.lengthOf(afterSteer.messages, beforeSteer.messages.length + 1);
      assert.deepInclude(afterSteer.messages.find(({ id }) => id === MessageId.make("allowed-strict")),
        { runId });
      assert.deepEqual((yield* outbox.listByCommandId(steer.commandId)).map(({ request }) => request),
        [steer.effects[0]!.request]);
      const retry = yield* sink.commitCommand(steer);
      assert.isFalse(retry.committed);
      assert.deepEqual(retry.receipt, committed.receipt);
      assert.lengthOf(yield* outbox.listByCommandId(steer.commandId), 1);
    }).pipe(Effect.provide(database()));
  }).pipe(Effect.provide(NodeServices.layer)),
);
