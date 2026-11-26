import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as ProviderAdapter from "@j1code/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@j1code/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@j1code/provider-core/server/ProviderContinuationRequests";
import { expect, it } from "@effect/vitest";
import {
  CommandId, MessageId, ProjectId, ProviderDriverKind, ProviderInstanceId, ThreadId,
  type ServerProvider,
  OrchestrationV2Command,
  OrchestrationV2ThreadLaunchInput,
} from "@j1code/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";

import * as Sqlite from "../persistence/Sqlite.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as AutoModelRouting from "./AutoModelRouting.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import * as CommandPolicy from "./CommandPolicy.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { layerFromAdapters } from "./ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { ProviderSwitchServiceV2 } from "./ProviderSwitchService.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";
import * as ThreadForkService from "./ThreadForkService.ts";

const selection = { instanceId: "codex", model: "auto" };
const message = { text: "Build it", attachments: [] };
const dispatch = {
  ...message,
  type: "message.dispatch",
  commandId: "send",
  threadId: "thread",
  messageId: "message",
  dispatchMode: { type: "start_immediately" },
  modelSelection: selection,
  createdBy: "user",
  creationSource: "web",
};
const launch = {
  commandId: "launch",
  projectId: "project",
  title: "New chat",
  modelSelection: selection,
  runtimeMode: "full-access",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
  initialMessage: message,
};

it("accepts a provider-native Auto model through both V2 entry points", () => {
  expect(Schema.decodeUnknownSync(OrchestrationV2Command)(dispatch)).toMatchObject({
    modelSelection: selection,
  });
  expect(Schema.decodeUnknownSync(OrchestrationV2ThreadLaunchInput)(launch)).toMatchObject({
    modelSelection: selection,
  });
});

it("decodes explicit Auto for dispatch and launch and validates its task identity", () => {
  const modelSelection = { ...selection, model: "gpt-5" };
  for (const requestEscalation of [false, true]) {
    const autoRouting = { taskId: "stable-task", requestEscalation };
    expect(Schema.decodeUnknownSync(OrchestrationV2Command)({
      ...dispatch, modelSelection, autoRouting,
    })).toMatchObject({ autoRouting });
    expect(() => Schema.decodeUnknownSync(OrchestrationV2Command)({
      ...dispatch, autoRouting: { ...autoRouting, taskId: "invalid task id" },
    })).toThrow(/autoRouting/);
    expect(Schema.decodeUnknownSync(OrchestrationV2ThreadLaunchInput)({
      ...launch, modelSelection, autoRouting,
    })).toMatchObject({ autoRouting });
    expect(Schema.decodeUnknownSync(OrchestrationV2ThreadLaunchInput)({
      ...launch, modelSelection, initialMessage: { ...message, autoRouting },
    }).initialMessage).toMatchObject({ autoRouting });
    expect(() => Schema.decodeUnknownSync(OrchestrationV2ThreadLaunchInput)({
      ...launch, autoRouting: { ...autoRouting, taskId: "" },
    })).toThrow(/autoRouting/);
  }
});

const instanceId = ProviderInstanceId.make("codex");
const fast = { instanceId, model: "fast" };
const deep = { instanceId, model: "deep" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  openSession: () => Effect.die("The Auto routing fixture does not run provider work."),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const provider: ServerProvider = {
  instanceId, driver: ProviderDriverKind.make("codex"), enabled: true, installed: true,
  version: null, status: "ready", auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00Z",
  models: ["fast", "deep", "auto"].map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  slashCommands: [], skills: [],
};

it.effect("commits explicit Auto with a stable pin, preserves the thread's approval mode, and replays only the exact command", () =>
  Effect.gen(function* () {
    const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([provider]);
    const layer = Orchestrator.layer.pipe(
      Layer.provide(AutoModelRouting.layer),
      Layer.provideMerge(Layer.mergeAll(
        Layer.mock(ProviderRegistry)({ getProviders: Ref.get(providers) }),
        ServerSettings.layerTest({
          autoModelPolicy: {
            mode: "auto", fast, deep, capabilities: {
              fast: { tools: true, contextWindow: 200_000 },
              deep: { tools: true, images: true, contextWindow: 200_000 },
            },
          },
        }),
        Layer.mock(CheckpointServiceV2)({}), layerFromAdapters([adapter]),
        Layer.mock(ProviderSessionManagerV2)({}), Layer.mock(ProviderSwitchServiceV2)({}),
        IdAllocator.layer, CommandPolicy.layer, ProviderContinuationRequests.layer, ThreadForkService.layer,
        ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer)),
        Layer.mock(RuntimePolicyV2)({}),
      )),
      Layer.provideMerge(EventSink.layer),
      Layer.provideMerge(Layer.mergeAll(
        ProjectionStore.layer, EventStore.layer, EffectOutbox.layer, CommandReceiptStore.layer, ProjectStore.layer,
      )),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provide(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const projectId = ProjectId.make("auto-project");
      const threadId = ThreadId.make("auto-thread");
      yield* orchestrator.dispatch({
        type: "thread.create", commandId: CommandId.make("create-auto-thread"), threadId, projectId,
        title: "Auto", modelSelection: { instanceId, model: "manual" },
        runtimeMode: "approval-required", interactionMode: "default", branch: null, worktreePath: null,
        createdBy: "user", creationSource: "web",
      });
      const send = (id: string) => ({
        type: "message.dispatch" as const, commandId: CommandId.make(id), threadId,
        messageId: MessageId.make(id), text: "Explain this", attachments: [],
        dispatchMode: { type: "defer_start" as const, workspaceStrategy: { type: "root" as const } },
        createdBy: "user" as const, creationSource: "web" as const,
        autoRouting: { taskId: "stable", requestEscalation: false, complexity: "simple" as const, highRisk: false, crossComponent: false },
      });

      yield* Ref.set(providers, [{ ...provider, auth: { status: "unauthenticated" } }]);
      const unavailable = send("auto-unavailable");
      const refused = yield* orchestrator.dispatch(unavailable).pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "OrchestratorCommandRejectedError", commandId: unavailable.commandId,
      });
      expect(yield* outbox.listByCommandId(unavailable.commandId)).toEqual([]);
      expect(yield* sql`SELECT * FROM auto_model_admissions`).toHaveLength(0);
      yield* Ref.set(providers, [provider]);

      const first = send("first-auto");
      const accepted = yield* orchestrator.dispatch(first);
      const run = accepted.storedEvents.find(({ event }) => event.type === "run.created")?.event;
      expect(run?.payload).toMatchObject({
        modelSelection: fast, autoSelection: { taskId: "stable", reason: expect.stringContaining("simple") },
      });
      expect((yield* projection.getThreadShell(threadId))?.runtimeMode).toBe("approval-required");
      expect(yield* sql`SELECT * FROM auto_model_admissions`).toHaveLength(1);
      yield* Ref.set(providers, []);
      const replay = yield* orchestrator.dispatch(first);
      expect(replay.replayed).toBe(true);
      expect(replay.sequence).toBe(accepted.sequence);
      expect(replay.storedEvents).toEqual(accepted.storedEvents);
      const changed = yield* orchestrator.dispatch({
        ...first, autoRouting: { ...first.autoRouting, taskId: "different" },
      }).pipe(Effect.flip);
      expect(changed).toMatchObject({
        _tag: "OrchestratorDispatchError",
        cause: "This command ID already belongs to a different Auto model request.",
      });
      yield* Ref.set(providers, [provider]);

      const followup = yield* orchestrator.dispatch({
        ...send("pinned-auto"), deliveryIntent: "auto",
        autoRouting: { ...first.autoRouting, requestEscalation: true },
      });
      expect(followup.storedEvents.find(({ event }) => event.type === "run.created")?.event.payload)
        .toMatchObject({ modelSelection: fast, status: "queued", autoSelection: {
          reason: "escalation-deferred",
        } });
      expect(yield* sql`SELECT * FROM auto_model_admissions`).toHaveLength(2);

      const rollback = send("auto-event-rollback");
      yield* sql`CREATE TRIGGER fail_auto_event BEFORE INSERT ON orchestration_events
        WHEN NEW.command_id = 'auto-event-rollback'
        BEGIN SELECT RAISE(ABORT, 'auto fixture event failure'); END`;
      const failedCommit = yield* orchestrator.dispatch(rollback).pipe(Effect.flip);
      expect(failedCommit).toMatchObject({
        _tag: "OrchestratorDispatchError", commandId: rollback.commandId,
      });
      expect(yield* sql`SELECT * FROM auto_model_admissions`).toHaveLength(2);
      expect(yield* sql`SELECT 1 FROM orchestration_events WHERE command_id = ${rollback.commandId}`)
        .toEqual([]);
      expect(yield* sql`SELECT 1 FROM orchestration_command_receipts WHERE command_id = ${rollback.commandId}`)
        .toEqual([]);
      expect(yield* outbox.listByCommandId(rollback.commandId)).toEqual([]);
      yield* sql`DROP TRIGGER fail_auto_event`;
      const retried = yield* orchestrator.dispatch(rollback);
      expect(retried.replayed).not.toBe(true);
      expect(retried.storedEvents.find(({ event }) => event.type === "run.created")?.event.payload)
        .toMatchObject({ modelSelection: fast, autoSelection: { taskId: "stable" } });
      expect(yield* sql`SELECT * FROM auto_model_admissions`).toHaveLength(3);

      const { autoRouting: _intent, ...manual } = send("manual-native-auto");
      const native = yield* orchestrator.dispatch({
        ...manual, modelSelection: { instanceId, model: "auto" },
      });
      expect(native.storedEvents.find(({ event }) => event.type === "run.created")?.event.payload)
        .toMatchObject({ modelSelection: { instanceId, model: "auto" } });
      expect(yield* sql`SELECT * FROM auto_model_admissions`).toHaveLength(3);
    }).pipe(Effect.provide(layer));
  }),
);
