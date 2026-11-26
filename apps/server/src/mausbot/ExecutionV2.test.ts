import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";
import { vi } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { layerTest as configLayerTest } from "../config.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ProviderTurnControlServiceV2 } from "../orchestration-v2/ProviderTurnControlService.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { MausbotNativeProofError } from "../orchestration-v2/MausbotNativeProofError.ts";
import { MausbotExecutionHost, type MausbotExecutionOwner } from "./ExecutionHost.ts";
import * as ExecutionV2Live from "./ExecutionV2Live.ts";
import { DispatchModeLimit, type DispatchModeLimitValue } from "../orchestration-v2/DispatchModeLimit.ts";
import { MausbotProjectOverride, type MausbotProjectOverrideProof } from "../orchestration-v2/MausbotProjectOverride.ts";
import { OrchestratorCommandPreviouslyRejectedError, OrchestratorDispatchError, OrchestratorThreadAlreadyExistsError, OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { readNativeRoomMemberEnrollment, type ReadSavedNativeBotEnrollment, type SavedNativeBotEnrollment } from "./NativeBotEnrollment.ts";
import { MausbotHistoryImport } from "../orchestration-v2/MausbotHistoryImport.ts";
import { MAUSBOT_ROOM_THREAD_PREFIX, MausbotOrigin, MausbotRoomCreation } from "../orchestration-v2/MausbotOrigin.ts";
import { captureBotExecutionContext } from "./ExecutionContext.ts";
import {
  BotId, ServerSettingsError, DEFAULT_SERVER_SETTINGS, EventId, MessageId, NodeId, ProjectId, ProviderDriverKind,
  ProviderInstanceId, ProviderThreadId, ProviderTurnId, RunAttemptId, RunId, ThreadId,
  type BotProfile, type OrchestrationProjectShell, type ServerProvider, type ServerSettings,
  type OrchestrationV2DomainEvent, type OrchestrationV2StoredEvent, type OrchestrationV2ThreadShell,
  type OrchestrationV2ServerCommand,
} from "@j1code/contracts";
import {
  ExecutionV2Turns, botExecutionThreadIdV2, createMausbotExecutionV2,
  type ExecutionV2Services, type ExecutionV2StartInput,
} from "./ExecutionV2.ts";

// Delegate to real temporary files except for the exact operation under fault injection.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), rm: vi.fn(actual.rm) };
});

const isDispatchError = Schema.is(OrchestratorDispatchError);
const isNativeProofError = Schema.is(MausbotNativeProofError);

const input = (threadId = "thread-one"): ExecutionV2StartInput => ({
  action: "start", botId: "bot-one", threadId, turnId: "turn-one", botName: "Saved bot", title: "Original task",
  instanceId: ProviderInstanceId.make("codex-personal"), model: "selected-model", cwd: NodePath.resolve("workspace"),
  text: "Continue the original task", system: "Keep the original objective", sharedContinuation: false,
  restrictedTools: true, guestConfined: false, approvalMode: "ask", images: [],
  tools: [{ name: "bot_call", inputSchema: { type: "object" } }],
});
const unexpected = () => Effect.die(new Error("Unexpected V2 service call"));
const owners = {
  owner: { id: "owner" },
  other: { id: "other" },
  a: { id: "owner-a" },
  b: { id: "owner-b" },
  next: { id: "next-owner" },
  fresh: { id: "new-owner" },
  stale: { id: "stale-owner" },
} as const satisfies Record<string, MausbotExecutionOwner>;
const projectId = ProjectId.make("project-one");
const botId = BotId.make("mausbot:bot-one");
const at = "2026-11-19T00:00:00.000Z";
const selected = { instanceId: input().instanceId, model: input().model };
const savedProfile: BotProfile = {
  id: botId, name: "Stored Lin", description: "", instructions: "Saved identity instructions",
  projectId, modelSelection: selected, archived: false, pinned: false, createdAt: at, updatedAt: at,
};
const project: OrchestrationProjectShell = {
  id: projectId, title: "Scoped project", workspaceRoot: input().cwd,
  defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at,
};
const provider: ServerProvider = {
  instanceId: selected.instanceId, driver: ProviderDriverKind.make("codex"),
  enabled: true, installed: true, version: null, checkedAt: at, status: "ready",
  auth: { status: "authenticated" }, slashCommands: [], skills: [],
  models: [{ slug: selected.model, name: "Selected model", isCustom: false, capabilities: null }],
};
const modelsSettings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: { [selected.instanceId]: { driver: provider.driver, enabled: true } },
};
type Create = Extract<OrchestrationV2ServerCommand, { type: "thread.bot.create" }>;
type RoomAdmissionCommand = "thread.bot.create" | "message.dispatch";
type FixtureOptions = {
  readonly beforeRoomAdmission?: (command: RoomAdmissionCommand) => void;
  readonly attachmentsDir?: string;
  readonly attachmentDispatchFailure?: "refused" | "ambiguous";
  readonly profiles?: ServerSettings["bots"];
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  readonly provider?: ServerProvider;
  readonly settings?: Partial<ServerSettings>;
  readonly managedPolicy?: ExecutionV2Services["settings"]["managedPolicy"];
  readonly readEnrollment?: ReadSavedNativeBotEnrollment;
  readonly warnings?: unknown[];
  readonly competingProfile?: (profile: BotProfile) => BotProfile;
  readonly race?: (created: OrchestrationV2ThreadShell) => OrchestrationV2ThreadShell | null;
};
function fixture(shell: OrchestrationV2ThreadShell | null = null, options: FixtureOptions = {}) {
  const commands: OrchestrationV2ServerCommand[] = [];
  const roomAdmissionAttempts: RoomAdmissionCommand[] = [];
  const inserted: BotProfile[] = [];
  const proofs: MausbotProjectOverrideProof[] = [];
  let persisted: ServerSettings = {
    ...modelsSettings,
    bots: options.profiles ?? {},
    ...options.settings,
  };
  const limits: Array<DispatchModeLimitValue | undefined> = [];
  const contexts: Array<ReturnType<typeof captureBotExecutionContext>> = [];
  const projects = options.projects ?? [project];
  const snapshot = options.provider ?? provider;
  const createShell = (command: Create): OrchestrationV2ThreadShell => ({
    ...shellFor(command.projectId), id: command.threadId, title: command.title,
    providerInstanceId: command.modelSelection.instanceId, modelSelection: command.modelSelection,
    runtimeMode: command.runtimeMode, interactionMode: command.interactionMode,
    bot: { id: command.botId, name: persisted.bots[command.botId]?.name ?? savedProfile.name },
  });
  const deps: ExecutionV2Services = {
    orchestrator: {
      dispatch: command => Effect.gen(function* () {
        if ((command.type === "thread.bot.create" || command.type === "message.dispatch") &&
            command.threadId.startsWith(MAUSBOT_ROOM_THREAD_PREFIX)) {
          roomAdmissionAttempts.push(command.type);
          options.beforeRoomAdmission?.(command.type);
          const proof = command.type === "thread.bot.create" ? yield* MausbotRoomCreation : yield* MausbotOrigin;
          if (!proof || proof.command !== command || !proof.current() ||
              !(yield* proof.refresh.pipe(Effect.orDie)) || !proof.current()) {
            return yield* new OrchestratorDispatchError({
              commandId: command.commandId, commandType: command.type, cause: "Room admission proof refused",
            });
          }
        }
        commands.push(command);
        limits.push(yield* DispatchModeLimit);
        if (command.type === "thread.bot.create") {
          const proof = yield* MausbotProjectOverride;
          if (proof) {
            proofs.push(proof);
            const saved = yield* proof.read.pipe(Effect.orDie);
            if (!saved) return yield* Effect.die(new Error("Missing fresh override proof"));
          }
          const created = createShell(command);
          shell = options.race ? options.race(created) : created;
          if (options.race) return yield* new OrchestratorThreadAlreadyExistsError({
            commandId: command.commandId, threadId: command.threadId,
          });
        } else if (command.type === "thread.bot.history.import") {
          const proof = yield* MausbotHistoryImport;
          assert.strictEqual(proof?.command, command);
          assert.isTrue(proof?.current());
          if (!proof || !(yield* proof.read.pipe(Effect.orDie))) {
            return yield* Effect.die(new Error("Expected a saved native history owner."));
          }
        } else if (command.type === "message.dispatch") {
          contexts.push(captureBotExecutionContext(command.threadId));
          if (options.attachmentDispatchFailure === "refused") {
            return yield* new OrchestratorCommandPreviouslyRejectedError({
              commandId: command.commandId, commandType: command.type, detail: "Fixture refused",
            });
          }
          if (options.attachmentDispatchFailure === "ambiguous") {
            return yield* new OrchestratorDispatchError({
              commandId: command.commandId, commandType: command.type,
              cause: new Error("Fixture lost the acknowledgement"),
            });
          }
        }
        return { sequence: 1, storedEvents: [] };
      }),
      getThreadShell: () => Effect.sync(() => shell),
      getThreadRecords: unexpected, getThreadProjection: unexpected,
    },
    projects: {
      getShell: id => Effect.succeed(Option.fromNullishOr(projects.find(row => row.id === id))),
      listShells: () => Effect.succeed(projects),
    },
    instances: {
      getInstance: id => Effect.succeed(id === selected.instanceId
        ? { instanceId: id, enabled: true, snapshot: { getSnapshot: Effect.succeed(snapshot) } } as never
        : undefined),
      listInstances: unexpected(), listUnavailable: unexpected(),
    },
    control: { interrupt: unexpected },
    settings: {
      getSettings: Effect.sync(() => persisted),
      insertBotProfileIfAbsent: (profile) => Effect.gen(function* () {
        inserted.push(profile);
        const competitor = options.competingProfile?.(profile);
        persisted = { ...persisted, bots: { ...persisted.bots, [profile.id]: competitor ?? profile } };
        if (competitor) return yield* new ServerSettingsError({
          settingsPath: "fixture-settings.json",
          operation: "write-file",
          cause: new Error("A bot profile with this identity already exists."),
        });
        return persisted;
      }),
      managedPolicy: options.managedPolicy,
    },
    attachmentsDir: options.attachmentsDir ?? "unused-test-attachments",
  };
  const log = Logger.layer([Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn") options.warnings?.push(message);
  })], { mergeWithExisting: false });
  const run = Effect.runPromise;
  const host = createMausbotExecutionV2(deps, (effect) =>
    run(options.warnings ? Effect.provide(effect, log) : effect),
  );
  const runStart = async (request: ExecutionV2StartInput = input()) => {
    try {
      return await host.call(request, () => true, () => {}, owners.owner, options.readEnrollment);
    } finally {
      const threadId = botExecutionThreadIdV2(request.botId, request.threadId);
      const turn = host.turns.get(threadId);
      if (turn) host.turns.release(threadId, turn);
    }
  };
  return { host, deps, commands, roomAdmissionAttempts, limits, contexts, runStart, inserted, proofs, settings: () => persisted };
}
const shellFor = (scope = projectId): OrchestrationV2ThreadShell => {
  const id = botExecutionThreadIdV2("bot-one", "thread-one"); const at = DateTime.makeUnsafe(0);
  return { id, projectId: scope, title: "Saved title", bot: { id: botId, name: "Original saved Lin" },
    providerInstanceId: input().instanceId,
    modelSelection: { instanceId: input().instanceId, model: input().model }, runtimeMode: "approval-required", interactionMode: "default",
    createdBy: "user", creationSource: "server", branch: null, worktreePath: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id }, forkedFrom: null,
    activeProviderThreadId: null, latestRunId: null, activeRunId: null, status: "idle", pendingRuntimeRequest: null,
    latestVisibleMessage: null, latestUserMessageAt: null, hasActionableProposedPlan: false,
    pendingBackgroundTasks: [], providerInstanceHistory: [], itemCount: 0, visibleItemCount: 0,
    createdAt: at, updatedAt: at, archivedAt: null, settledOverride: null, settledAt: null, deletedAt: null };
};

it("lists the default provider without a legacy providers settings map", async () => {
  const { deps } = fixture();
  const snapshot = { ...provider, instanceId: ProviderInstanceId.make(String(provider.driver)) };
  const host = createMausbotExecutionV2({
    ...deps,
    instances: {
      ...deps.instances, listInstances: Effect.succeed([]), listUnavailable: Effect.succeed([snapshot]),
    },
  }, Effect.runPromise);
  const catalog = await host.call({ action: "catalog" }, () => true, () => {}, owners.owner);
  assert.deepEqual(catalog, [{ ...snapshot, nativeDefault: undefined }]);
});
it("rejects a guest before registering execution or calling the provider", async () => {
  const { host, commands } = fixture();
  await NodeAssert.rejects(host.call({ ...input(), guestConfined: true }, () => true, () => {}, owners.owner), /guest/);
  assert.equal(host.turns.owners().length, 0); assert.equal(commands.length, 0);
});
it("refuses native room turns before private task admission or ordinary Resume", async () => {
  const { host } = fixture();
  for (const request of [
    { ...input(), nativeRoomTurn: true },
    { ...input(), nativeRoomTurn: true, sharedContinuation: true, text: "" },
    { ...input(), nativeRoomTurn: true, nativeOriginStart: true },
  ]) {
    await NodeAssert.rejects(host.call(request, () => true, () => {}, owners.owner,
      () => { throw new Error("Private task enrollment must not read room history."); }), /room-member ownership/);
  }
});

it("rechecks the provider approval mode at staging and admission boundaries for a cold room turn", async () => {
  const request = { ...input(), nativeRoomTurn: true };
  const rows = [{
    id: "room-request", at: 1, role: "user" as const, kind: "text", text: request.text,
    provenance: { authority: "own" as const, sender: { id: "person", name: "Person" } },
  }];
  const snapshot = readNativeRoomMemberEnrollment({
    botId: request.botId, threadId: request.threadId, turnId: request.turnId, groupId: "room", dm: false,
    roster: [request.botId],
    enrollment: { name: savedProfile.name, workspace: request.cwd, selection: selected,
      approvalMode: request.approvalMode, restrictedTools: request.restrictedTools },
    operation: { id: "operation", generation: "generation", kind: "chat", requestId: "room-request",
      sourceRowIds: ["room-request"], queuedIds: [], renderedWindowIds: ["room-request"],
      instructionsBeforeHistory: "", historicalInstructionText: "", instructionsAfterHistory: "" },
    rows,
  }, request.botId, request.threadId, request.turnId);
  NodeAssert.ok(snapshot);

  for (const revokeAt of ["stage", "thread.bot.create", "message.dispatch", null] as const) {
    let modes: ServerProvider["supportedRuntimeModes"] = ["approval-required"];
    let inAdmission: RoomAdmissionCommand | undefined;
    const { host, commands, roomAdmissionAttempts, contexts } = fixture(null, {
      profiles: { [botId]: savedProfile },
      provider: { ...provider, get supportedRuntimeModes() { return modes; } },
      beforeRoomAdmission: commandType => { inAdmission = commandType; },
    });
    const start = host.call(request, () => true, () => {}, owners.owner, undefined,
      async () => {
        if (inAdmission && inAdmission === revokeAt) modes = ["full-access"];
        return snapshot;
      },
      async () => {
        if (revokeAt === "stage") modes = ["full-access"];
        return { ...snapshot, rows: snapshot.rows.map(row => ({ ...row, stagedAttachments: [] })) };
      });

    if (revokeAt === null) {
      await start;
      assert.deepEqual(roomAdmissionAttempts, ["thread.bot.create", "message.dispatch"]);
      assert.deepEqual(commands.map(command => command.type), roomAdmissionAttempts);
      assert.include(commands[0]!, { threadId: ThreadId.make("j1-mausbot:room:room:thread-one:bot-one") });
      assert.lengthOf(contexts, 1);
      const [owned] = host.turns.forOwner(owners.owner);
      if (owned) host.turns.release(...owned);
      continue;
    }

    await NodeAssert.rejects(start, revokeAt === "stage"
      ? /room operation changed during staging/
      : (error: unknown) => isDispatchError(error) && error.commandType === revokeAt);
    assert.deepEqual(roomAdmissionAttempts, revokeAt === "stage" ? []
      : revokeAt === "thread.bot.create" ? ["thread.bot.create"]
        : ["thread.bot.create", "message.dispatch"]);
    assert.deepEqual(commands.map(command => command.type),
      revokeAt === "message.dispatch" ? ["thread.bot.create"] : []);
    assert.deepEqual(contexts, []);
    assert.lengthOf(host.turns.owners(), 0);
  }
});

it("rejects another connection's controls and repeated active starts", async () => {
  const { host, commands } = fixture();
  host.turns.claim(input(), owners.a, () => true, () => {});
  await NodeAssert.rejects(host.call({ action: "stop", botId: "bot-one", threadId: "thread-one" }, () => true, () => {}, owners.b), /another runtime/);
  await NodeAssert.rejects(host.call(input(), () => true, () => {}, owners.a), /already has an active/);
  assert.equal(commands.length, 0);
});
it("admits only one of two concurrent starts for the same saved bot thread", async () => {
  const { host, commands } = fixture(null, { profiles: { [botId]: savedProfile } });
  const request = input();
  const threadId = botExecutionThreadIdV2(request.botId, request.threadId);
  const start = () => host.call(request, () => true, () => {}, owners.owner);
  try {
    const [first, duplicate] = await Promise.allSettled([start(), start()]);
    assert.deepEqual(first, { status: "fulfilled", value: { turnId: request.turnId } });
    if (duplicate.status !== "rejected") return assert.fail("Expected the duplicate to be refused");
    assert.match(String(duplicate.reason), /already has an active/);
    assert.deepEqual(commands.map((command) => command.type), ["thread.bot.create", "message.dispatch"]);
    const owned = host.turns.owned(threadId, owners.owner);
    const dispatched = commands[1];
    if (dispatched?.type !== "message.dispatch") return assert.fail("Expected one owned dispatch");
    assert.equal(dispatched.threadId, threadId);
    assert.equal(dispatched.messageId, owned.messageId);
  } finally {
    const turn = host.turns.get(threadId);
    if (turn) host.turns.release(threadId, turn);
  }
});

it("rejects a changed saved project without creating a new thread or provider run", async () => {
  const { host, commands } = fixture(shellFor());
  await NodeAssert.rejects(host.call({ ...input(), projectId: ProjectId.make("different") }, () => true, () => {}, owners.owner), /change its project/);
  assert.equal(host.turns.owners().length, 0); assert.equal(commands.length, 0);
});
it("creates the exact external thread through private admission before dispatching its owned turn", async () => {
  const { runStart, commands, limits, contexts } = fixture(null, { profiles: { [botId]: savedProfile } });
  const request = { ...input(), botName: "Forged display", title: "Forged display", effort: "high", approvalMode: "edits" as const };
  assert.deepEqual(await runStart(request), { turnId: request.turnId });
  assert.equal(commands.length, 2);
  const [creation, message] = commands;
  if (creation?.type !== "thread.bot.create" || message?.type !== "message.dispatch")
    throw new Error("Expected private bot creation before message dispatch.");
  const threadId = botExecutionThreadIdV2(request.botId, request.threadId);
  assert.deepEqual(creation, {
    type: "thread.bot.create", commandId: creation.commandId, threadId, botId, projectId,
    title: savedProfile.name, modelSelection: {
      ...selected, options: [{ id: "reasoningEffort", value: "high" }],
    }, branch: null, worktreePath: null,
    runtimeMode: "auto-accept-edits", interactionMode: "default", createdBy: "user", creationSource: "server",
  });
  assert.equal(message.threadId, threadId);
  const expectedLimit: DispatchModeLimitValue = { runtimeMode: "auto-accept-edits", interactionMode: "default" };
  assert.deepEqual(limits, [expectedLimit, expectedLimit]);
  assert.deepEqual(contexts[0]?.owner, { botId: request.botId, messageId: message.messageId });
  assert.include(contexts[0]?.prompt ?? "", "You are Stored Lin.");
  assert.include(contexts[0]?.prompt ?? "", request.cwd);
  assert.notInclude(contexts[0]?.prompt ?? "", "Forged display");
  assert.isUndefined(captureBotExecutionContext(threadId));
});

it("preserves the existing durable association, saved workspace and interaction mode", async () => {
  const { runStart, commands, contexts, limits } = fixture({
    ...shellFor(), worktreePath: "C:/saved-worktree", interactionMode: "plan", itemCount: 1,
  });
  await runStart({ ...input(), cwd: "C:/saved-worktree", botName: "Forged display", sharedContinuation: true });
  assert.deepEqual(commands.map(command => command.type), ["message.dispatch"]);
  assert.include(contexts[0]?.prompt ?? "", "You are Original saved Lin.");
  assert.include(contexts[0]?.prompt ?? "", "C:/saved-worktree");
  assert.equal(limits[0]?.interactionMode, "plan");
});

it("rejects missing, archived and foreign profile or thread bindings before mutation", async () => {
  const profiles = { [botId]: savedProfile };
  for (const [shell, settings] of [
    [null, {}],
    [null, { [BotId.make("bot-one")]: { ...savedProfile, id: BotId.make("bot-one") } }],
    [null, { [botId]: { ...savedProfile, archived: true } }],
    [null, { [botId]: { ...savedProfile, id: BotId.make("mausbot:foreign") } }],
    [{ ...shellFor(), bot: { id: BotId.make("mausbot:foreign"), name: savedProfile.name } }, profiles],
  ] as const) {
    const { runStart, commands } = fixture(shell, { profiles: settings });
    await NodeAssert.rejects(runStart(), /profile|different bot/);
    assert.deepEqual(commands, []);
  }
});

const nativeEnrollment: SavedNativeBotEnrollment = {
  botId: "bot-one",
  threadId: "thread-one",
  name: savedProfile.name,
  description: savedProfile.description,
  instructions: savedProfile.instructions,
  projectId: null,
  threadProjectId: projectId,
  modelSelection: selected,
  threadSelection: selected,
  approvalMode: "ask",
  restrictedTools: true,
  coldHistory: {
    turnId: input().turnId, anchorMessageId: "anchor", promptText: input().text,
    messages: [], promptAttachments: [],
  },
};

it("enrolls the saved native bot through the private read and keeps its global default", async () => {
  const read: ReadSavedNativeBotEnrollment = async (botId, threadId) => {
    assert.deepEqual([botId, threadId], ["bot-one", "thread-one"]);
    return nativeEnrollment;
  };
  const taskModel = "saved-task-model";
  const { runStart, commands, inserted } = fixture(null, {
    readEnrollment: async (bot, thread) => ({
      ...(await read(bot, thread))!,
      threadSelection: { ...selected, model: taskModel },
    }),
    provider: { ...provider, models: [...provider.models, { ...provider.models[0]!, slug: taskModel }] },
  });
  await runStart({ ...input(), model: taskModel, botName: "Caller text", title: "Caller title" });
  assert.lengthOf(inserted, 1);
  assert.include(inserted[0]!, { id: botId, name: savedProfile.name, projectId: null });
  assert.deepEqual(inserted[0]?.modelSelection, selected);
  assert.deepEqual(commands.map(command => command.type), ["thread.bot.create", "message.dispatch"]);
  const created = commands[0];
  if (created?.type !== "thread.bot.create") throw new Error("Expected exact bot admission");
  assert.equal(created.modelSelection.model, taskModel);
});

it("provides exact task proof for a cross-project creation and leaves its default intact", async () => {
  const destination = { ...project, id: ProjectId.make("task-project"), workspaceRoot: "C:/task" };
  const task = { ...nativeEnrollment, projectId, threadProjectId: destination.id };
  const request = { ...input(), projectId: destination.id, cwd: destination.workspaceRoot };
  const reads: string[][] = [];
  const existing = fixture(null, {
    profiles: { [botId]: savedProfile },
    projects: [project, destination],
    readEnrollment: async (bot, thread) => { reads.push([bot, thread]); return task; },
  });
  await existing.runStart(request);
  assert.deepEqual(reads, [
    ["bot-one", "thread-one"], ["bot-one", "thread-one"], ["bot-one", "thread-one"],
  ]);
  assert.strictEqual(existing.proofs[0]?.command, existing.commands[0]);
  assert.equal(existing.proofs[0]?.command.projectId, destination.id);
  assert.equal(existing.proofs[0]?.defaultProjectId, projectId);
  assert.deepEqual(existing.settings().bots[botId], savedProfile);
  assert.deepEqual(existing.inserted, []);

  const pinned = fixture(shellFor(destination.id), {
    profiles: { [botId]: savedProfile },
    projects: [project, destination],
    readEnrollment: async () => task,
  });
  await pinned.runStart(request);
  assert.deepEqual(pinned.commands.map(command => command.type), ["message.dispatch"]);
  await NodeAssert.rejects(pinned.runStart({ ...request, projectId }), /change its project/);
  assert.deepEqual(pinned.proofs, []);
  assert.deepEqual(pinned.inserted, []);
});

it("rejects moved, foreign, elevated or broadened native enrollment before writing", async () => {
  const cases = [
    { snapshot: { ...nativeEnrollment, botId: "foreign" }, request: input() },
    { snapshot: { ...nativeEnrollment, threadSelection: { ...selected, model: "foreign" } }, request: input() },
    { snapshot: { ...nativeEnrollment, projectId: ProjectId.make("foreign") }, request: input() },
    { snapshot: { ...nativeEnrollment, modelSelection: { ...selected, model: "missing-default" } }, request: input() },
    { snapshot: nativeEnrollment, request: { ...input(), approvalMode: "full" as const } },
    { snapshot: nativeEnrollment, request: { ...input(), restrictedTools: false } },
  ];
  for (const { snapshot, request } of cases) {
    const { runStart, commands, inserted } = fixture(null, { readEnrollment: async () => snapshot });
    await NodeAssert.rejects(runStart(request), /enrollment|bound J1 profile|default project/);
    assert.deepEqual(commands, []);
    assert.deepEqual(inserted, []);
  }
});

it("reconciles the exact insert winner while leaving a conflicting profile intact", async () => {
  const readEnrollment = async () => nativeEnrollment;
  const exact = fixture(null, {
    readEnrollment,
    competingProfile: profile => ({ ...profile, pinned: true }),
  });
  await exact.runStart();
  assert.isTrue(exact.settings().bots[botId]?.pinned);
  assert.equal(exact.commands[0]?.type, "thread.bot.create");

  const foreign = fixture(null, {
    readEnrollment,
    competingProfile: profile => ({ ...profile, name: "Independently saved" }),
  });
  await NodeAssert.rejects(foreign.runStart(), /different saved J1 bot profile/);
  assert.equal(foreign.settings().bots[botId]?.name, "Independently saved");
  assert.deepEqual(foreign.commands, []);
});

it("does not insert a profile after the captured connection goes stale during the read", async () => {
  const stopped = fixture();
  let active = true;
  await NodeAssert.rejects(stopped.host.call(input(), () => active, () => {}, owners.owner, async () => {
    active = false;
    return nativeEnrollment;
  }), /not active/);
  assert.deepEqual(stopped.inserted, []);
  assert.deepEqual(stopped.commands, []);
});

it("uses an existing warm thread without reading or inserting enrollment", async () => {
  const existing = fixture({ ...shellFor(), itemCount: 1 }, {
    profiles: { [botId]: savedProfile },
    readEnrollment: async () => { throw new Error("Should not reread an existing profile"); },
  });
  await existing.runStart();
  assert.deepEqual(existing.inserted, []);
});

it("rejects caller-supplied profile authority as a transport error", async () => {
  const { host, commands } = fixture(null, { profiles: { [botId]: savedProfile } });
  const error = host.call(
    { ...input(), profileId: botId, profile: savedProfile },
    () => true,
    () => {},
    owners.owner,
  );
  await NodeAssert.rejects(error, /profileId|profile/);
  await NodeAssert.rejects(
    host.call({ ...input(), future: true }, () => true, () => {}, owners.owner),
    /future/,
  );
  assert.deepEqual(commands, []);
});

it("validates the saved profile for an existing binding and preserves a legacy exact owner", async () => {
  const binding = { action: "binding", botId: "bot-one", threadId: "thread-one" };
  const call = (host: ReturnType<typeof createMausbotExecutionV2>) =>
    host.call(binding, () => true, () => {}, owners.owner);
  const legacy = fixture(shellFor());
  assert.deepEqual(await call(legacy.host), { locked: true, projectId });
  const archived = fixture(shellFor(), { profiles: { [botId]: { ...savedProfile, archived: true } } });
  await NodeAssert.rejects(call(archived.host), /profile is unavailable/);
  const moved = fixture(shellFor(), { profiles: {
    [botId]: { ...savedProfile, projectId: ProjectId.make("different") },
  } });
  await NodeAssert.rejects(call(moved.host), /different project/);
  assert.deepEqual([...legacy.commands, ...archived.commands, ...moved.commands], []);
});

it("keeps the private native selection for a new thread when the account and model are allowed", async () => {
  const model = { ...provider.models[0]!, slug: "allowed-thread-model" };
  const selectedProvider = { ...provider, models: [...provider.models, model] };
  const { runStart, commands } = fixture(null, {
    profiles: { [botId]: savedProfile },
    provider: selectedProvider,
  });
  await runStart({ ...input(), model: model.slug });
  const created = commands[0];
  assert.equal(created?.type, "thread.bot.create");
  if (created?.type !== "thread.bot.create") throw new Error("Expected exact bot admission");
  assert.deepEqual(created.modelSelection, { instanceId: input().instanceId, model: model.slug });
});

it("rejects mismatched cwd, archived and foreign project bindings before mutation", async () => {
  const profiles = { [botId]: savedProfile };
  const cases = [
    { options: { profiles }, request: { ...input(), cwd: "C:/foreign" }, reason: /workspace/ },
    { options: { profiles }, request: { ...input(), projectId: ProjectId.make("foreign") }, reason: /different project/ },
    { options: { profiles, projects: [{ ...project, archivedAt: at }] }, request: input(), reason: /unavailable/ },
    { options: { profiles, projects: [] }, request: input(), reason: /unavailable/ },
  ];
  for (const { options, request, reason } of cases) {
    const { runStart, commands } = fixture(null, options);
    await NodeAssert.rejects(runStart(request), reason);
    assert.deepEqual(commands, []);
  }
});

it("selects an unbound profile only when its workspace identifies a unique saved project", async () => {
  const profiles = { [botId]: { ...savedProfile, projectId: null } };
  const exact = fixture(null, { profiles });
  await exact.runStart();
  assert.equal(exact.commands[0]?.type, "thread.bot.create");
  const ambiguous = fixture(null, { profiles, projects: [project, { ...project, id: ProjectId.make("other-project") }] });
  await NodeAssert.rejects(ambiguous.runStart(), /ambiguous/);
  assert.deepEqual(ambiguous.commands, []);
});

it("refuses a disabled, unauthenticated or wrong account and an unavailable model before mutation", async () => {
  const profiles = { [botId]: savedProfile };
  const snapshots: ServerProvider[] = [
    { ...provider, enabled: false },
    { ...provider, instanceId: ProviderInstanceId.make("foreign-account") },
    { ...provider, auth: { status: "unauthenticated" } },
    { ...provider, models: [] },
  ];
  for (const snapshot of snapshots) {
    const { runStart, commands } = fixture(null, { profiles, provider: snapshot });
    await NodeAssert.rejects(runStart(), /provider account or model/);
    assert.deepEqual(commands, []);
  }
  const disabled = fixture(null, { profiles, settings: {
    projectSettingsOverrides: { [projectId]: { providerInstances: { [selected.instanceId]: { enabled: false } } } },
  } });
  await NodeAssert.rejects(disabled.runStart(), /account is unavailable for this project/);
  assert.deepEqual(disabled.commands, []);

  const approval = fixture(null, { profiles, provider: { ...provider, supportedRuntimeModes: ["approval-required"] } });
  await NodeAssert.rejects(approval.runStart({ ...input(), approvalMode: "full" }), /does not support this approval mode/);
  assert.deepEqual(approval.commands, []);
});

it("refuses a managed approval ceiling before private creation", async () => {
  const { runStart, commands } = fixture(null, {
    profiles: { [botId]: savedProfile },
    managedPolicy: { organization: "Managed", lockedSettings: [], limits: { maxRuntimeMode: "approval-required" } },
  });
  await NodeAssert.rejects(runStart({ ...input(), approvalMode: "full" }), /managed J1 runtime limit/);
  assert.deepEqual(commands, []);
});

it("reconciles a duplicate with the exact winner and refuses foreign or absent winner projections", async () => {
  const profiles = { [botId]: savedProfile };
  const exact = fixture(null, { profiles, race: created => created });
  await exact.runStart();
  assert.deepEqual(exact.commands.map(command => command.type), ["thread.bot.create", "message.dispatch"]);
  for (const race of [
    () => null,
    (created: OrchestrationV2ThreadShell) => ({ ...created, projectId: ProjectId.make("foreign") }),
    (created: OrchestrationV2ThreadShell) => ({ ...created, runtimeMode: "full-access" as const }),
  ]) {
    const conflict = fixture(null, { profiles, race });
    await NodeAssert.rejects(conflict.runStart(), /saved J1 thread/);
    assert.deepEqual(conflict.commands.map(command => command.type), ["thread.bot.create"]);
  }
});

it.live.each(["partial write", "collision", "cleanup failure"] as const)(
  "rolls back a staged image batch after a later %s",
  (fault) => Effect.gen(function* () {
    const path = yield* Path.Path;
    const files = yield* FileSystem.FileSystem;
    const root = yield* files.makeTempDirectoryScoped({ prefix: "j1-v2-image-rollback-" });
    yield* Effect.promise(async () => {
      // Native file handles are required here to inject failures into the production Node call.
      const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const mocked = await vi.importMock<typeof import("node:fs/promises")>("node:fs/promises");
      const open = vi.mocked(mocked.open);
      const remove = vi.mocked(mocked.rm);
      const warnings: unknown[] = [];
      try {
        const attachmentsDir = path.join(root, "managed");
        await fs.mkdir(attachmentsDir);
        const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
        const sources = [path.join(root, "first.png"), path.join(root, "second.png")];
        for (const source of sources) await fs.writeFile(source, png);
        await fs.writeFile(path.join(attachmentsDir, "existing.png"), "preexisting");

        const primary = new Error("injected partial image write");
        let firstDestination: string | undefined;
        let secondDestination: string | undefined;
        open.mockImplementationOnce(async (path, flags, mode) => {
          firstDestination = String(path);
          return fs.open(path, flags, mode);
        }).mockImplementationOnce(async (path, flags, mode) => {
          secondDestination = String(path);
          if (!firstDestination) throw new Error("First image was never staged");
          assert.deepEqual(await fs.readFile(firstDestination), png);
          assert.equal(flags, "wx");
          if (fault === "collision") {
            await fs.writeFile(path, "collided", { flag: "wx" });
            return fs.open(path, flags, mode);
          }
          const handle = await fs.open(path, flags, mode);
          const write = handle.writeFile.bind(handle);
          vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
            await write(png.subarray(0, 3));
            assert.equal((await fs.stat(path)).size, 3);
            throw primary;
          });
          return handle;
        });
        if (fault === "cleanup failure") {
          remove.mockImplementation(async (path, options) => {
            if (String(path) === secondDestination) throw new Error(`Cannot remove ${path}`);
            return fs.rm(path, options);
          });
        }

        const { runStart, commands, host } = fixture(shellFor(), {
          profiles: { [botId]: savedProfile }, attachmentsDir, warnings,
        });
        await NodeAssert.rejects(
          runStart({
            ...input(),
            images: sources.map((path) => ({ path, mime: "image/png" as const, bytes: png.length })),
          }),
          fault === "collision" ? { code: "EEXIST" } : (error: unknown) => error === primary,
        );
        if (!firstDestination || !secondDestination) return assert.fail("Expected both exclusive opens");
        await NodeAssert.rejects(fs.stat(firstDestination), { code: "ENOENT" });
        if (fault === "collision") {
          assert.equal(await fs.readFile(secondDestination, "utf8"), "collided");
        } else if (fault === "cleanup failure") {
          assert.deepEqual(await fs.readFile(secondDestination), png.subarray(0, 3));
        } else {
          await NodeAssert.rejects(fs.stat(secondDestination), { code: "ENOENT" });
        }
        assert.deepEqual(warnings, fault === "cleanup failure"
          ? [["Could not remove one or more uncommitted bot image attachments."]]
          : []);
        for (const source of sources) assert.deepEqual(await fs.readFile(source), png);
        assert.equal(await fs.readFile(path.join(attachmentsDir, "existing.png"), "utf8"), "preexisting");
        assert.deepEqual(commands, []);
        assert.lengthOf(host.turns.owners(), 0);
      } finally {
        open.mockReset();
        remove.mockReset();
      }
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("copies a validated image into the owned turn and refuses changed or mislabeled bytes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "j1-execution-v2-image-" });
    const source = path.join(root, "source.png");
    const attachmentsDir = path.join(root, "managed");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lK0AAAAASUVORK5CYII=",
      "base64",
    );
    const { runStart, commands, host } = fixture(shellFor(), {
      profiles: { [botId]: savedProfile }, attachmentsDir,
    });
    yield* fs.writeFile(source, png);
    const image = { path: source, mime: "image/png" as const, bytes: png.length };
    yield* Effect.promise(() => NodeAssert.rejects(
      runStart({ ...input(), images: [{ ...image, bytes: image.bytes - 1 }] }),
      /attachment changed/,
    ));
    yield* fs.writeFile(source, Buffer.alloc(png.length));
    yield* Effect.promise(() => NodeAssert.rejects(runStart({ ...input(), images: [image] }), /Invalid bot image content/));
    assert.deepEqual(commands, []);
    assert.deepEqual(yield* fs.readDirectory(attachmentsDir), []);
    assert.lengthOf(host.turns.owners(), 0);

    const newThread = fixture(null, { profiles: { [botId]: savedProfile }, attachmentsDir });
    yield* Effect.promise(() => NodeAssert.rejects(newThread.runStart({ ...input(), images: [image] }), /Invalid bot image content/));
    assert.deepEqual(newThread.commands, []);

    const modeChange = fixture({ ...shellFor(), runtimeMode: "full-access" }, {
      profiles: { [botId]: savedProfile }, attachmentsDir,
    });
    yield* Effect.promise(() => NodeAssert.rejects(modeChange.runStart({ ...input(), images: [image] }), /Invalid bot image content/));
    assert.deepEqual(modeChange.commands, []);

    const second = path.join(root, "corrupt.png");
    yield* fs.writeFile(second, Buffer.alloc(png.length));
    yield* fs.writeFile(source, png);
    yield* Effect.promise(() => NodeAssert.rejects(
      runStart({ ...input(), images: [image, { ...image, path: second }] }),
      /Invalid bot image content/,
    ));
    assert.deepEqual(commands, []);
    assert.deepEqual(yield* fs.readDirectory(attachmentsDir), []);

    const blockedDestination = path.join(root, "not-a-directory");
    yield* fs.writeFileString(blockedDestination, "existing content");
    const blocked = fixture(shellFor(), {
      profiles: { [botId]: savedProfile }, attachmentsDir: blockedDestination,
    });
    yield* Effect.promise(() => NodeAssert.rejects(blocked.runStart({ ...input(), images: [image] }), { code: "EEXIST" }));
    assert.equal(yield* fs.readFileString(blockedDestination), "existing content");
    assert.deepEqual(blocked.commands, []);

    const existingPath = path.join(attachmentsDir, "existing.png");
    yield* fs.writeFile(existingPath, png);
    const refused = fixture(shellFor(), {
      profiles: { [botId]: savedProfile }, attachmentsDir, attachmentDispatchFailure: "refused",
    });
    yield* Effect.promise(() => NodeAssert.rejects(refused.runStart({ ...input(), images: [image] }), /Fixture refused/));
    assert.deepEqual(yield* fs.readDirectory(attachmentsDir), ["existing.png"]);

    const ambiguousDir = path.join(root, "ambiguous");
    const ambiguous = fixture(shellFor(), {
      profiles: { [botId]: savedProfile }, attachmentsDir: ambiguousDir, attachmentDispatchFailure: "ambiguous",
    });
    yield* Effect.promise(() => NodeAssert.rejects(ambiguous.runStart({ ...input(), images: [image] })));
    const possibleCommit = yield* fs.readDirectory(ambiguousDir);
    assert.lengthOf(possibleCommit, 1);
    assert.deepEqual(Buffer.from(yield* fs.readFile(path.join(ambiguousDir, possibleCommit[0]!))), png);

    assert.deepEqual(Buffer.from(yield* fs.readFile(source)), png);
    yield* Effect.promise(() => runStart({ ...input(), images: [image] }));
    assert.lengthOf(commands, 1);
    const command = commands[0];
    if (command?.type !== "message.dispatch") return assert.fail("Expected the owned turn dispatch");
    assert.equal(command.threadId, shellFor().id);
    assert.lengthOf(command.attachments, 1);
    const attachment = command.attachments[0]!;
    assert.include(attachment, { type: "image", name: "source.png", mimeType: image.mime, sizeBytes: png.length });
    const managed = resolveAttachmentPath({ attachmentsDir, attachment });
    if (!managed) return assert.fail("Expected a managed attachment path");
    assert.deepEqual(Buffer.from(yield* fs.readFile(managed)), png);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("imports the ordered private history before dispatching only the new message", async () => {
  const transcript = [
    { role: "user", text: "Historical question" },
    { role: "assistant", text: "Historical answer" },
  ] as const;
  const history = {
    turnId: input().turnId,
    anchorMessageId: "current-message",
    promptText: input().text,
    promptAttachments: [],
    messages: [
      { ...transcript[0], nativeMessageId: "prior-one", createdAt: at, completedAt: null, attachments: [] },
      { ...transcript[1], nativeMessageId: "prior-two", createdAt: at, completedAt: at, attachments: [] },
    ] as const,
  };
  const fixtureOptions = {
    profiles: { [botId]: savedProfile },
    readEnrollment: (async (_bot, _thread, source) => {
      if (source && "turnId" in source) assert.deepEqual(source.workspace, { projectId, root: input().cwd });
      return { ...nativeEnrollment, coldHistory: history };
    }) satisfies ReadSavedNativeBotEnrollment,
  };
  const { runStart, commands, contexts } = fixture(null, fixtureOptions);
  await runStart({ ...input(), text: "Historical question plus prompt", transcript, recoveryText: "Historical question" });
  assert.deepEqual(commands.map(command => command.type), [
    "thread.bot.create", "thread.bot.history.import", "message.dispatch",
  ]);
  // A failed renewal must not dispatch the new message on a partially started thread.
  const proofReadFailure = new Error("Injected native history refresh failure");
  let scopedHistoryReads = 0;
  const rejected = fixture(null, {
    profiles: { [botId]: savedProfile },
    readEnrollment: async (_bot, _thread, source) => {
      if (source && "turnId" in source && ++scopedHistoryReads === 2) throw proofReadFailure;
      return { ...nativeEnrollment, coldHistory: history };
    },
  });
  await NodeAssert.rejects(
    rejected.runStart({ ...input(), transcript }),
    (error: unknown) => isNativeProofError(error) && error.cause === proofReadFailure,
  );
  assert.deepEqual(rejected.commands.map(({ type }) => type), ["thread.bot.create", "thread.bot.history.import"]);
  assert.lengthOf(rejected.host.turns.owners(), 0);
  const imported = commands[1];
  if (imported?.type !== "thread.bot.history.import") throw new Error("Missing history command");
  assert.deepEqual(imported.messages, history.messages);
  const dispatched = commands[2];
  if (dispatched?.type !== "message.dispatch") throw new Error("Missing new message");
  assert.equal(dispatched.text, input().text);
  assert.equal(imported.botId, botId);
  assert.equal(imported.threadId, botExecutionThreadIdV2(input().botId, input().threadId));
  assert.notInclude(contexts[0]?.prompt ?? "", "Historical question");

  const compacted = fixture(null, fixtureOptions);
  await compacted.runStart({ ...input(), transcript: [] });
  assert.equal(compacted.commands[1]?.type, "thread.bot.history.import");

  let reads = 0;
  const moved = fixture(null, {
    ...fixtureOptions,
    readEnrollment: async (_bot, _thread, source) => ({
      ...nativeEnrollment, coldHistory: {
        ...history, anchorMessageId: !source || ++reads === 1 ? history.anchorMessageId : "different-anchor",
      },
    }),
  });
  await NodeAssert.rejects(moved.runStart({ ...input(), transcript }), /saved native history owner/);
  assert.isFalse(moved.commands.some(command => command.type === "message.dispatch"));

  const warm = fixture({ ...shellFor(), itemCount: 2 }, fixtureOptions);
  await warm.runStart({ ...input(), transcript, recoveryText: "Historical question", sharedContinuation: true });
  assert.deepEqual(warm.commands.map(command => command.type), ["message.dispatch"]);
  assert.notInclude(warm.contexts[0]?.prompt ?? "", "Historical question");

  const busy = fixture({ ...shellFor(), activeRunId: RunId.make("active") }, fixtureOptions);
  await NodeAssert.rejects(busy.runStart({ ...input(), transcript }), /active V2 run/);
  assert.deepEqual(busy.commands, []);

  const foreignAttachment = fixture(null, {
    readEnrollment: async () => ({
      ...nativeEnrollment,
      coldHistory: {
        ...history,
        promptAttachments: [{
          type: "image" as const,
          id: "foreign-00000000-0000-0000-0000-000000000000",
          name: "photo.png", mimeType: "image/png", sizeBytes: 12,
        }],
      },
    }),
  });
  await NodeAssert.rejects(foreignAttachment.runStart({ ...input(), transcript }), /does not belong/);
  assert.deepEqual(foreignAttachment.inserted, []);
  assert.deepEqual(foreignAttachment.settings().bots, {});
  assert.deepEqual(foreignAttachment.commands, []);
});

it("requires a private saved transcript and keeps promptless resume separate", async () => {
  const { runStart, commands } = fixture(null, { profiles: { [botId]: savedProfile } });
  await NodeAssert.rejects(runStart({ ...input(), transcript: [{ role: "user", text: "previous" }] }), /Cold bot history/);
  await NodeAssert.rejects(runStart({ ...input(), recoveryText: "unstructured history" }), /Cold bot history/);
  await NodeAssert.rejects(runStart({ ...input(), text: "", sharedContinuation: true }), /exact native continuation/);
  const legacy = fixture(null, {
    profiles: { [botId]: savedProfile }, readEnrollment: async () => {
      const { coldHistory: _coldHistory, ...saved } = nativeEnrollment;
      return saved;
    },
  });
  await NodeAssert.rejects(legacy.runStart({
    ...input(), transcript: [{ role: "user", text: "Only a prompt replay window" }],
  }), /Cold bot history/);
  assert.deepEqual(legacy.commands, []);
  assert.deepEqual(commands, []);
});

it("disconnect stops only the owner's exact threads and preserves the neighbor", async () => {
  const { host, commands } = fixture();
  const first = host.turns.claim(input(), owners.a, () => true, () => {});
  const neighbor = host.turns.claim(input("neighbor"), owners.b, () => true, () => {});
  await host.disconnect(owners.a);
  assert.deepEqual(commands.map(command => [command.type, "threadId" in command ? command.threadId : null]), [["thread.stop", first.threadId]]);
  assert.strictEqual(host.turns.get(neighbor.threadId), neighbor.turn);
  assert.isUndefined(host.turns.get(first.threadId));
});
it.each([{ stopFails: false, outcome: "successful" }, { stopFails: true, outcome: "failed" }])(
  "retires exactly one runtime generation after a $outcome Stop", async ({ stopFails }) => {
    const request = input();
    const { deps, commands } = fixture(shellFor(), { profiles: { [botId]: savedProfile } });
    const retired = { id: "retired" };
    const neighbor = { id: "neighbor" };
    const fresh = { id: "fresh" };
    let stopAttempts = 0;
    const host = createMausbotExecutionV2({
      ...deps,
      instances: { ...deps.instances, listInstances: Effect.succeed([]), listUnavailable: Effect.succeed([provider]) },
      orchestrator: { ...deps.orchestrator, dispatch: command => Effect.gen(function* () {
        if (command.type === "thread.stop" && command.threadId === first.threadId) {
          stopAttempts++;
          if (stopFails)
            return yield* new OrchestratorThreadAlreadyExistsError({ commandId: command.commandId, threadId: first.threadId });
        }
        return yield* deps.orchestrator.dispatch(command);
      }) },
    }, Effect.runPromise);
    const first = host.turns.claim(request, retired, () => true, () => {});
    const other = host.turns.claim(input("neighbor"), neighbor, () => true, () => {});
    const oldCatalog: unknown[] = [];
    await host.call({ action: "watch-catalog" }, () => true, event => oldCatalog.push(event), retired);
    const freshCatalog: unknown[] = [];
    await host.call({ action: "watch-catalog" }, () => true, event => freshCatalog.push(event), fresh);
    await host.catalogChanged();
    assert.lengthOf(oldCatalog, 1);
    assert.lengthOf(freshCatalog, 1);

    const tool = host.turns.tool(first.threadId, first.turn, "bot_call", {}, new AbortController().signal);
    const toolEnded = NodeAssert.rejects(tool, /turn ended/);
    const requestId = [...first.turn.pending.keys()][0]!;
    const stop = host.disconnect(retired);
    assert.strictEqual(host.disconnect(retired), stop);
    const outcome = stopFails ? NodeAssert.rejects(stop, /could not be stopped/) : stop;

    const staleCalls = [
      request,
      { action: "watch-catalog" },
      { action: "stop", botId: request.botId, threadId: request.threadId },
      { action: "tool-result", botId: request.botId, threadId: request.threadId, requestId, value: "stale" },
    ];
    for (const stale of staleCalls) {
      await NodeAssert.rejects(host.call(stale, () => true, () => {}, retired), /disconnected/);
    }
    await outcome;
    await toolEnded;
    assert.strictEqual(host.disconnect(retired), stop);
    for (const stale of staleCalls) {
      await NodeAssert.rejects(host.call(stale, () => true, () => {}, retired), /disconnected/);
    }

    await host.catalogChanged();
    assert.lengthOf(oldCatalog, 1);
    assert.lengthOf(freshCatalog, 2);
    assert.equal(stopAttempts, 1);
    assert.isUndefined(host.turns.get(first.threadId));
    assert.strictEqual(host.turns.owned(other.threadId, neighbor), other.turn);
    const replacement = host.turns.claim(request, fresh, () => true, () => {});
    assert.equal(replacement.threadId, first.threadId);
    assert.strictEqual(host.disconnect(retired), stop);
    assert.strictEqual(host.turns.owned(first.threadId, fresh), replacement.turn);
    host.turns.release(replacement.threadId, replacement.turn);

    // A fresh generation can use the ordinary catalog and control paths.
    await host.call({ action: "stop", botId: request.botId, threadId: "neighbor" },
      () => true, () => {}, neighbor);
    const close = host.close();
    assert.strictEqual(host.close(), close);
    await close;
    assert.isTrue(commands.some(command => command.type === "thread.stop" && command.threadId === other.threadId));
  },
);

it("closes all owners and clears pending tools even when an owned Stop fails", async () => {
  const { deps, commands } = fixture();
  const blocked = botExecutionThreadIdV2(input().botId, input().threadId);
  const host = createMausbotExecutionV2({
    ...deps,
    orchestrator: { ...deps.orchestrator, dispatch: command => Effect.gen(function* () {
      if (command.type === "thread.stop" && command.threadId === blocked)
        return yield* new OrchestratorThreadAlreadyExistsError({ commandId: command.commandId, threadId: blocked });
      return yield* deps.orchestrator.dispatch(command);
    }) },
  }, Effect.runPromise);
  const first = host.turns.claim(input(), owners.a, () => true, () => {});
  const neighbor = host.turns.claim(input("neighbor"), owners.b, () => true, () => {});
  const pending = host.turns.tool(first.threadId, first.turn, "bot_call", {}, new AbortController().signal);
  const ended = NodeAssert.rejects(pending, /turn ended/);
  const close = host.close();
  assert.strictEqual(host.close(), close);
  await NodeAssert.rejects(close, /could not be stopped/);
  await ended;
  assert.deepEqual(host.turns.owners(), []);
  assert.deepEqual(commands.map(entry => entry.type === "thread.stop" && entry.threadId), [neighbor.threadId]);
  await NodeAssert.rejects(host.call({ action: "watch-catalog" }, () => true, () => {}, owners.fresh), /disconnected/);
});

it.effect("the opt-in host reads stored events once and releases subscriptions and owned work", () =>
  Effect.gen(function* () {
    const { deps, commands } = fixture(shellFor(), { profiles: { [botId]: savedProfile } });
    const stored = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const changes = yield* PubSub.unbounded<void>();
    const readerEnded = yield* Deferred.make<void>();
    const started = yield* Deferred.make<unknown>();
    const catalog = yield* Deferred.make<unknown>();
    const cursors: Array<number | undefined> = [];
    const received: unknown[] = [];
    let emittedRun: OrchestrationV2DomainEvent | undefined;
    let nativeStart: OrchestrationV2DomainEvent | undefined;
    const scopedLayer = ExecutionV2Live.layer.pipe(Layer.provide(Layer.mergeAll(
      Layer.mock(EventSinkV2)({
        latestSequence: () => Effect.succeed(8),
        stream: (options) => {
          cursors.push(options?.afterSequence);
          return Stream.fromQueue(stored).pipe(Stream.ensuring(Deferred.succeed(readerEnded, undefined)));
        },
      }),
      Layer.mock(OrchestratorV2)({ ...deps.orchestrator, dispatch: command => Effect.gen(function* () {
        const result = yield* deps.orchestrator.dispatch(command);
        if (command.type !== "message.dispatch") return result;
        const runId = RunId.make("fixture-run");
        const at = DateTime.makeUnsafe(0);
        const providerThreadId = ProviderThreadId.make("fixture-provider-thread");
        const attemptId = RunAttemptId.make("fixture-attempt");
        const nodeId = NodeId.make("fixture-root");
        emittedRun = {
          id: EventId.make("run-created"), type: "run.created", threadId: command.threadId, runId, occurredAt: at,
          payload: { id: runId, threadId: command.threadId, ordinal: 1, status: "running",
            providerInstanceId: selected.instanceId, modelSelection: selected, providerThreadId,
            userMessageId: command.messageId, rootNodeId: nodeId, activeAttemptId: attemptId,
            requestedAt: at, startedAt: at, completedAt: null, checkpointId: null, contextHandoffId: null },
        };
        nativeStart = {
          id: EventId.make("provider-running"), type: "provider-turn.updated", threadId: command.threadId, runId, occurredAt: at,
          payload: { id: ProviderTurnId.make("fixture-native-turn"), runAttemptId: attemptId, nodeId, providerThreadId,
            ordinal: 1, nativeTurnRef: { driver: provider.driver, nativeId: "fixture-native-id", strength: "strong" },
            status: "running", startedAt: at, completedAt: null },
        };
        return { ...result, storedEvents: [
          { sequence: 9, commandId: command.commandId, event: emittedRun },
          { sequence: 10, commandId: command.commandId, event: nativeStart },
        ] };
      }) }),
      Layer.mock(ProjectStoreV2)(deps.projects),
      Layer.mock(ProviderTurnControlServiceV2)(deps.control),
      Layer.mock(ServerSettingsService)(deps.settings),
      configLayerTest(process.cwd(), { prefix: "j1-v2-execution-lifecycle-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
      Layer.mock(ProviderInstanceRegistry)({
        ...deps.instances,
        listInstances: Effect.succeed([]), listUnavailable: Effect.succeed([provider]),
        subscribeChanges: PubSub.subscribe(changes),
      }),
    )));
    const acquired = yield* Effect.gen(function* () {
      const host = yield* MausbotExecutionHost;
      const watch = () => Effect.promise(() => host.call({ action: "watch-catalog" }, () => true,
        value => { received.push(value); Deferred.doneUnsafe(catalog, Effect.succeed(value)); }, owners.owner));
      yield* watch();
      yield* watch();
      yield* PubSub.publish(changes, undefined);
      yield* Deferred.await(catalog);
      assert.lengthOf(received, 1);
      yield* Effect.promise(() => host.call(input(), () => true,
        value => { received.push(value); Deferred.doneUnsafe(started, Effect.succeed(value)); }, owners.owner));
      assert.lengthOf(received, 1);
      if (!emittedRun || !nativeStart) return yield* Effect.die("Expected committed fixture events");
      yield* Queue.offer(stored, { sequence: 8, commandId: null, event: emittedRun });
      yield* Queue.offer(stored, { sequence: 9, commandId: null, event: emittedRun });
      yield* Queue.offer(stored, { sequence: 10, commandId: null, event: nativeStart });
      yield* Deferred.await(started);
      assert.lengthOf(received, 2);
      return host;
    }).pipe(Effect.provide(scopedLayer), Effect.scoped);
    yield* Deferred.await(readerEnded);
    assert.deepEqual(cursors, [8]);
    assert.deepEqual(commands.map(entry => entry.type), ["message.dispatch", "thread.stop"]);
    yield* Effect.promise(() => NodeAssert.rejects(acquired.call({ action: "watch-catalog" },
      () => true, () => {}, owners.stale), /disconnected/));
  }),
);

it("correlates tool results to the owning connection and rejects duplicate results", async () => {
  const { host } = fixture();
  const request = input();
  const events: unknown[] = [];
  const claim = host.turns.claim(request, owners.owner, () => true, event => events.push(event));
  const args = { name: "selected-tool" };
  const result = host.turns.tool(claim.threadId, claim.turn, "bot_call", args, new AbortController().signal);
  const requestId = [...claim.turn.pending.keys()][0]!;
  assert.deepEqual(events, [{
    kind: "tool-call", botId: request.botId, threadId: request.threadId, turnId: request.turnId, requestId,
    name: "bot_call", arguments: args,
  }]);
  const reply = { action: "tool-result", botId: request.botId, threadId: request.threadId, requestId, value: { ok: true } };
  const send = (payload: unknown, owner: MausbotExecutionOwner = owners.owner) =>
    host.call(payload, () => true, () => {}, owner);
  await NodeAssert.rejects(send(reply, owners.other), /another runtime/);
  await NodeAssert.rejects(send({ ...reply, botId: "wrong-bot" }), /not active/);
  await NodeAssert.rejects(send({ ...reply, threadId: "wrong-thread" }), /not active/);
  await send(reply);
  assert.deepEqual(await result, { ok: true });
  await NodeAssert.rejects(send(reply), /no longer active/);
  await NodeAssert.rejects(host.turns.tool(claim.threadId, claim.turn, "unoffered", {}, new AbortController().signal), /not offered/);
});
it("abort and terminal cleanup settle pending tools once without borrowing a replacement turn", async () => {
  const turns = new ExecutionV2Turns(); const events: unknown[] = [];
  const request = input();
  const first = turns.claim(request, owners.owner, () => true, event => events.push(event));
  const abort = new AbortController();
  const cancelled = turns.tool(first.threadId, first.turn, "bot_call", {}, abort.signal);
  const requestId = [...first.turn.pending.keys()][0]!;
  const cancelledCheck = NodeAssert.rejects(cancelled, /cancelled/); abort.abort(); await cancelledCheck;
  assert.deepEqual(events, [
    { kind: "tool-call", botId: request.botId, threadId: request.threadId, turnId: request.turnId,
      requestId, name: "bot_call", arguments: {} },
    { kind: "tool-cancel", botId: request.botId, threadId: request.threadId, turnId: request.turnId, requestId },
  ]);
  const pending = turns.tool(first.threadId, first.turn, "bot_call", {}, new AbortController().signal);
  const endedCheck = NodeAssert.rejects(pending, /ended/); turns.release(first.threadId, first.turn); await endedCheck;
  const next = turns.claim({ ...request, turnId: "replacement-turn" }, owners.next, () => true, () => {});
  turns.release(first.threadId, first.turn);
  assert.strictEqual(turns.get(next.threadId), next.turn); assert.equal(first.turn.pending.size, 0);
});
it.each([
  { outcome: "accepted", status: "completed" },
  { outcome: "rejected before provider acceptance", status: "failed" },
] as const)("reports an owned run $outcome exactly once", async ({ status }) => {
  const { host, commands } = fixture(); const events: unknown[] = [];
  const request = { ...input(), text: "private rejected prompt", system: "private bot instructions" };
  const one = host.turns.claim(request, owners.owner, () => true, event => events.push(event));
  const at = DateTime.makeUnsafe(0); const runId = RunId.make("run-one");
  const makeRun = (messageId: MessageId, status: "running" | "completed" | "failed"): OrchestrationV2DomainEvent => ({
    id: EventId.make("event-" + status), type: "run.updated", threadId: one.threadId, runId, occurredAt: at,
    payload: { id: runId, threadId: one.threadId, ordinal: 1, providerInstanceId: input().instanceId,
      modelSelection: { instanceId: input().instanceId, model: input().model }, providerThreadId: ProviderThreadId.make("native-thread"),
      userMessageId: messageId, rootNodeId: NodeId.make("root-node"), activeAttemptId: RunAttemptId.make("attempt-one"), status,
      requestedAt: at, startedAt: at, completedAt: status === "running" ? null : at,
      checkpointId: null, contextHandoffId: null } });
  host.acceptEvent(makeRun(MessageId.make("different-message"), "running")); assert.equal(events.length, 0);
  host.acceptEvent(makeRun(one.turn.messageId, "running")); assert.equal(events.length, 0);
  const native: Extract<OrchestrationV2DomainEvent, { type: "provider-turn.updated" }> = {
    type: "provider-turn.updated", id: EventId.make("native-start"), threadId: one.threadId,
    runId, occurredAt: at, payload: { id: ProviderTurnId.make("native-turn"), providerThreadId: ProviderThreadId.make("native-thread"),
      nodeId: NodeId.make("root-node"), runAttemptId: RunAttemptId.make("attempt-one"),
      nativeTurnRef: { driver: provider.driver, nativeId: "accepted-native-turn", strength: "strong" },
      ordinal: 1, status: "running", startedAt: at, completedAt: null },
  };
  for (const payload of [
    { ...native.payload, nativeTurnRef: null },
    { ...native.payload, startedAt: null },
    { ...native.payload, runAttemptId: RunAttemptId.make("old-attempt") },
    { ...native.payload, nodeId: NodeId.make("child-node") },
    { ...native.payload, providerThreadId: ProviderThreadId.make("foreign-thread") },
    { ...native.payload, nativeTurnRef: { ...native.payload.nativeTurnRef!, strength: "none" as const } },
  ]) host.acceptEvent({ ...native, payload });
  assert.equal(events.length, 0);
  if (status === "completed") {
    host.acceptEvent(native);
    host.acceptEvent(native);
    assert.lengthOf(events, 1);
    assert.nestedPropertyVal(events[0], "event.type", "turn.started");
  }
  const terminal = makeRun(one.turn.messageId, status);
  const tool = host.turns.tool(one.threadId, one.turn, "bot_call", {}, new AbortController().signal);
  const toolEnded = NodeAssert.rejects(tool, /turn ended/);
  const beforeTerminal = events.length;
  host.acceptEvent({ ...terminal, threadId: ThreadId.make("unrelated") });
  assert.lengthOf(events, beforeTerminal);
  host.acceptEvent(terminal);
  host.acceptEvent(terminal);
  host.acceptEvent(native);
  assert.lengthOf(events, beforeTerminal + 1);
  assert.deepEqual(events.at(-1), {
    kind: "runtime",
    botId: request.botId,
    threadId: request.threadId,
    turnId: request.turnId,
    event: { type: "turn.completed", payload: { state: status } },
  });
  assert.isUndefined(host.turns.get(one.threadId));
  await toolEnded;
  assert.deepEqual(commands, []);
});

it("refuses unknown or wrong-kind approval answers without dispatching a response", async () => {
  const { host, commands } = fixture();
  host.turns.claim(input(), owners.owner, () => true, () => {});
  await NodeAssert.rejects(host.call({ action: "respond", botId: "bot-one", threadId: "thread-one", requestId: "missing", decision: "accept" }, () => true, () => {}, owners.owner), /does not belong/);
  await NodeAssert.rejects(host.call({ action: "answer", botId: "bot-one", threadId: "thread-one", requestId: "missing", answers: {} }, () => true, () => {}, owners.owner), /does not belong/);
  assert.equal(commands.length, 0);
});

it("a durable Stop is sent once and does not pretend the provider has already completed", async () => {
  const { host, commands } = fixture(); const one = host.turns.claim(input(), owners.owner, () => true, () => {});
  const stop = { action: "stop", botId: "bot-one", threadId: "thread-one" };
  await host.call(stop, () => true, () => {}, owners.owner);
  await host.call(stop, () => true, () => {}, owners.owner);
  assert.equal(commands.length, 1); assert.strictEqual(host.turns.get(one.threadId), one.turn);
  assert.isTrue(one.turn.stopping);
});
