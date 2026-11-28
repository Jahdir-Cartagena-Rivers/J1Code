import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@j1code/contracts";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ServerConfig, layerTest } from "../../../config.ts";
import { ServerEnvironment } from "../../../environment/ServerEnvironment.ts";
import { registerBotExecutionContext } from "../../../mausbot/ExecutionContext.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import { HiveMindToolkitHandlersLive } from "./handlers.ts";
import { HiveMindToolkit } from "./tools.ts";

const backend = vi.hoisted(() => ({
  bindHiveTask: vi.fn(),
  forgetSelectedHive: vi.fn(),
  materializeHiveImage: vi.fn(),
  operateHiveContinuity: vi.fn(),
  recallSelectedHive: vi.fn(),
  rememberSelectedHive: vi.fn(),
  requestHive: vi.fn(),
  retainHiveAttachment: vi.fn(),
  selectedHiveConnection: vi.fn(),
  selectedHiveStatus: vi.fn(),
  syncSelectedHive: vi.fn(),
}));
vi.mock("../../../hiveMind/backend.ts", () => backend);

const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("hive-authenticated-source");
const scope: McpInvocationScope = {
  environmentId,
  thread: {
    threadId,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "provider-credential",
  },
  client: undefined,
  requestNamespace: "hive-handler-test",
  capabilities: new Set(["agents"]),
  issuedAt: 0,
};
const config = Layer.effect(
  ServerConfig,
  Effect.map(ServerConfig, (base) => ({
    ...base,
    stateDir: "fixture",
    attachmentsDir: "fixture/attachments",
  })),
).pipe(
  Layer.provide(layerTest("fixture", { prefix: "j1-hive-handler-test-" })),
  Layer.provide(NodeServices.layer),
);
const layer = Layer.mergeAll(
  liveThreadsLayer,
  config,
  HiveMindToolkitHandlersLive.pipe(Layer.provide(config)),
);
const invoke = <A, E, R>(effect: Effect.Effect<A, E, R>, invocation = scope) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext, invocation),
    Effect.provideService(ServerEnvironment, {
      getEnvironmentId: Effect.succeed(environmentId),
    } as never),
    Effect.provide(layer),
  );
const remember = Effect.gen(function* () {
  return yield* (yield* HiveMindToolkit)
    .handle("hive_mind_remember", {
      scope: "general",
      subject: "Fixture",
      fact: "A fact with an owner.",
    })
    .pipe(Stream.unwrap, Stream.runCollect);
});
const task = Effect.gen(function* () {
  return yield* (yield* HiveMindToolkit)
    .handle("hive_mind_continue_task", { taskId: "existing-task" })
    .pipe(Stream.unwrap, Stream.runCollect);
});
const status = Effect.gen(function* () {
  return yield* (yield* HiveMindToolkit)
    .handle("hive_mind_status", {})
    .pipe(Stream.unwrap, Stream.runCollect);
});
const readReference = Effect.gen(function* () {
  return yield* (yield* HiveMindToolkit)
    .handle("hive_mind_read_reference", { id: "owned-image" })
    .pipe(Stream.unwrap, Stream.runCollect);
});

it.effect("attributes memory, task and materialized images to the same authenticated thread", () =>
  Effect.gen(function* () {
    backend.rememberSelectedHive.mockResolvedValueOnce({
      id: "memory",
      scope: "general",
      project: null,
      subject: "Fixture",
      fact: "A fact with an owner.",
      sourceThreadId: threadId,
      createdAt: "2026-11-19",
      updatedAt: "2026-11-19",
    });
    backend.bindHiveTask.mockResolvedValueOnce({ taskId: "existing-task", sequence: 1 });
    const connection = { origin: "https://fixture.invalid", token: "test-only" };
    backend.selectedHiveConnection.mockResolvedValueOnce(connection);
    backend.materializeHiveImage.mockResolvedValueOnce({
      path: "fixture/attachments/image.png",
      attachment: { mimeType: "image/png" },
    });
    backend.operateHiveContinuity.mockResolvedValueOnce({});
    const claim = Effect.gen(function* () {
      return yield* (yield* HiveMindToolkit)
        .handle("hive_mind_continuity", {
          operation: "claim",
          input: { id: "existing-task", owner: "foreign", source: { threadId: "foreign" } },
        })
        .pipe(Stream.unwrap, Stream.runCollect);
    });
    yield* invoke(remember);
    yield* invoke(task);
    yield* invoke(readReference);
    yield* invoke(claim);
    expect(backend.operateHiveContinuity).toHaveBeenLastCalledWith(
      expect.any(String),
      "claim",
      { id: "existing-task" },
      threadId,
    );
    expect(backend.rememberSelectedHive).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ sourceThreadId: threadId }),
    );
    expect(backend.bindHiveTask).toHaveBeenLastCalledWith(
      expect.any(String),
      threadId,
      "existing-task",
    );
    expect(backend.materializeHiveImage).toHaveBeenLastCalledWith(
      connection,
      "owned-image",
      "fixture/attachments",
      threadId,
    );
  }),
);

it.effect(
  "refuses outside, mixed, foreign, restricted and direct bot calls before consulting Hive",
  () =>
    Effect.gen(function* () {
      backend.selectedHiveStatus.mockClear();
      const outside = { sessionId: "outside", label: "Outside", access: "full-access" as const };
      for (const invocation of [
        { ...scope, thread: undefined },
        { ...scope, client: outside },
        { ...scope, environmentId: EnvironmentId.make("foreign") },
        {
          ...scope,
          thread: { ...scope.thread!, providerInstanceId: ProviderInstanceId.make("foreign") },
        },
        { ...scope, capabilities: new Set<never>() },
      ]) {
        yield* invoke(status, invocation).pipe(Effect.flip);
      }
      for (const restrictedTools of [false, true]) {
        const dispose = registerBotExecutionContext(threadId, {
          restrictedTools,
          prompt: "",
          tools: [],
          call: async () => undefined,
        });
        try {
          yield* invoke(status).pipe(Effect.flip);
        } finally {
          dispose();
        }
      }
      expect(backend.selectedHiveStatus).not.toHaveBeenCalled();
    }),
);

it.effect(
  "returns selected-connection failure without materializing or consulting another service",
  () =>
    Effect.gen(function* () {
      backend.materializeHiveImage.mockClear();
      backend.requestHive.mockClear();
      backend.selectedHiveConnection.mockResolvedValueOnce(null);
      yield* invoke(readReference).pipe(Effect.flip);
      expect(backend.materializeHiveImage).not.toHaveBeenCalled();
      expect(backend.requestHive).not.toHaveBeenCalled();
    }),
);
