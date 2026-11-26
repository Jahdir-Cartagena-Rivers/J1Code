import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@j1code/contracts";
import type * as ProviderAdapter from "@j1code/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import * as Sqlite from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectStoreV2 } from "./ProjectStore.ts";
import { layerFromAdapters } from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const home = ProjectId.make("j1-home");
const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Thread creation must not open a provider session"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layer = ProviderReplayHarness.layerWithRegistry(
  { name: "home-creation" },
  layerFromAdapters([adapter]),
  { databaseLayer: Sqlite.layerMemory, runEffectWorker: false },
);

const create = (id: string, projectId = home) => ({
  type: "thread.create" as const,
  commandId: CommandId.make(`create:${id}`),
  threadId: ThreadId.make(id),
  projectId,
  title: id,
  modelSelection: { instanceId, model: "gpt-5" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  createdBy: "user" as const,
  creationSource: "web" as const,
});

const completedRunId = (threadId: ThreadId) => RunId.make(`completed:${threadId}`);

const fork = (sourceThreadId: ThreadId, id: string, sideChat = false) => ({
  type: "thread.fork" as const,
  commandId: CommandId.make(`fork:${id}`),
  sourceThreadId,
  targetThreadId: ThreadId.make(id),
  sourcePoint: sideChat
    ? { type: "latest_stable" as const }
    : { type: "run" as const, runId: completedRunId(sourceThreadId) },
  sideChat,
  createdBy: "user" as const,
  creationSource: "web" as const,
});

const recordStableRun = Effect.fn("homeTest.recordStableRun")(function* (threadId: ThreadId) {
  const sink = yield* EventSinkV2;
  const now = yield* DateTime.now;
  const runId = completedRunId(threadId);
  yield* sink.write({ events: [{
    type: "run.created",
    id: EventId.make(`run:${threadId}`),
    threadId,
    runId,
    occurredAt: now,
    payload: {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-5" },
      providerThreadId: null,
      userMessageId: MessageId.make(`user:${threadId}`),
      rootNodeId: null,
      activeAttemptId: null,
      status: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    },
  }] });
});

it.effect("keeps one Home conversation across concurrent creates, archive and replacement", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const attempts = [create("home-first"), create("home-second")];
    const results = yield* Effect.forEach(
      attempts,
      (command) => orchestrator.dispatch(command).pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    expect(results.filter(Result.isSuccess)).toHaveLength(1);
    const original = attempts[results.findIndex(Result.isSuccess)]!.threadId;
    const rejected = results.find(Result.isFailure);
    expect(rejected?.failure).toMatchObject({
      _tag: "OrchestratorHomeThreadAlreadyExistsError",
      message: "Home already has a conversation.",
    });

    yield* recordStableRun(original);
    const homeFork = fork(original, "home-fork");
    const refusedFork = yield* orchestrator.dispatch(homeFork).pipe(Effect.flip);
    expect(refusedFork._tag).toBe("OrchestratorHomeThreadAlreadyExistsError");
    expect(yield* orchestrator.getThreadShell(homeFork.targetThreadId)).toBeNull();

    const sideChat = fork(original, "home-side-chat", true);
    yield* orchestrator.dispatch(sideChat);
    const side = (yield* orchestrator.getThreadRecords(sideChat.targetThreadId, [])).thread;
    expect(side.lineage).toMatchObject({ parentThreadId: original, sideChat: true });
    yield* recordStableRun(side.id);
    const promotedSideChat = yield* orchestrator.dispatch(
      fork(sideChat.targetThreadId, "home-fork-from-side"),
    ).pipe(Effect.flip);
    expect(promotedSideChat._tag).toBe("OrchestratorHomeThreadAlreadyExistsError");

    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive-home"),
      threadId: original,
    });
    const archived = yield* orchestrator.dispatch(create("home-archived-conflict")).pipe(Effect.flip);
    expect(archived._tag).toBe("OrchestratorHomeThreadAlreadyExistsError");
    const archivedFork = yield* orchestrator.dispatch(fork(original, "archived-home-fork")).pipe(Effect.flip);
    expect(archivedFork._tag).toBe("OrchestratorHomeThreadAlreadyExistsError");

    const project = ProjectId.make("ordinary-project");
    const ordinary = create("ordinary-first", project);
    yield* orchestrator.dispatch(ordinary);
    yield* orchestrator.dispatch(create("ordinary-second", project));
    yield* recordStableRun(ordinary.threadId);
    const ordinaryFork = fork(ordinary.threadId, "ordinary-fork");
    yield* orchestrator.dispatch(ordinaryFork);
    const forked = (yield* orchestrator.getThreadRecords(ordinaryFork.targetThreadId, [])).thread;
    expect(forked.projectId).toBe(project);
    expect(forked.lineage.parentThreadId).toBe(ordinary.threadId);

    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-home"),
      threadId: original,
    });
    expect((yield* orchestrator.getThreadRecords(side.id, [])).thread.deletedAt).not.toBeNull();

    // Historical data can retain a child without its original context transfer.
    const sink = yield* EventSinkV2;
    const descendant = ThreadId.make("retained-home-side-chat");
    yield* sink.write({ events: [{
      type: "thread.created",
      id: EventId.make("retained-home-side-chat"),
      threadId: descendant,
      occurredAt: yield* DateTime.now,
      payload: { ...side, id: descendant },
    }] });
    const replacement = create("home-replacement");
    yield* orchestrator.dispatch(replacement);
    expect((yield* orchestrator.getThreadRecords(replacement.threadId, [])).thread.projectId).toBe(home);
    expect((yield* orchestrator.getThreadRecords(descendant, [])).thread.deletedAt).toBeNull();
  }).pipe(Effect.provide(layer)),
);

it.effect("serializes Home adoption with creation and preserves an ordinary folder move", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projects = yield* ProjectStoreV2;
    const at = DateTime.formatIso(yield* DateTime.now);
    const destination = ProjectId.make("adopt-ordinary");
    const source = ProjectId.make("adopt-scratch");
    const homeRoot = "/workspace/home-admission";
    const ordinaryRoot = "/workspace/ordinary-admission";
    for (const [projectId, workspaceRoot] of [[home, homeRoot], [destination, ordinaryRoot]] as const) {
      yield* projects.apply({
        sequence: 1,
        eventId: EventId.make(`project:${projectId}`),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: at,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: { projectId, title: projectId, workspaceRoot, defaultModelSelection: null,
          scripts: [], createdAt: at, updatedAt: at },
      });
    }
    const initial = create("adopt-original-home");
    const candidate = { ...create("adopt-candidate", source), worktreePath: homeRoot };
    const neighbor = { ...create("adopt-neighbor", source), worktreePath: ordinaryRoot };
    for (const command of [initial, candidate, neighbor]) yield* orchestrator.dispatch(command);
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("adopt-archive-home"),
      threadId: initial.threadId,
    });
    const adopt = {
      type: "thread.project.adopt-folder" as const,
      commandId: CommandId.make("adopt-home-occupied"),
      projectId: home,
      threadId: candidate.threadId,
    };
    const before = (yield* orchestrator.getThreadRecords(candidate.threadId, [])).thread;
    expect((yield* orchestrator.dispatch(adopt).pipe(Effect.flip))._tag)
      .toBe("OrchestratorHomeThreadAlreadyExistsError");
    expect((yield* orchestrator.getThreadRecords(candidate.threadId, [])).thread).toEqual(before);
    yield* orchestrator.dispatch({
      ...adopt,
      commandId: CommandId.make("adopt-ordinary-neighbor"),
      projectId: destination,
      threadId: neighbor.threadId,
    });
    expect((yield* orchestrator.getThreadRecords(neighbor.threadId, [])).thread).toMatchObject({
      projectId: destination,
      worktreePath: null,
    });
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("adopt-delete-home"),
      threadId: initial.threadId,
    });

    const retry = { ...adopt, commandId: CommandId.make("adopt-home-race") };
    const replacement = create("adopt-create-race");
    const results = yield* Effect.forEach(
      [retry, replacement],
      (command) => orchestrator.dispatch(command).pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    expect(results.filter(Result.isSuccess)).toHaveLength(1);
    expect(results.find(Result.isFailure)?.failure._tag).toBe("OrchestratorHomeThreadAlreadyExistsError");
    const winningIndex = results.findIndex(Result.isSuccess);
    const winningCommand = winningIndex === 0 ? retry : replacement;
    expect(yield* orchestrator.dispatch(winningCommand))
      .toEqual({ ...results.find(Result.isSuccess)?.success, replayed: true });
    expect((yield* orchestrator.getThreadRecords(candidate.threadId, [])).thread.projectId)
      .toBe(winningIndex === 0 ? home : source);
  }).pipe(Effect.provide(layer)),
);
