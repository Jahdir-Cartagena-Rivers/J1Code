import {
  EnvironmentId, EventId, MessageId, ProjectId, ProviderInstanceId, ThreadId,
  type OrchestrationV2ConversationMessage, type OrchestrationProjectShell, type OrchestrationV2ServerCommand, type OrchestrationV2ThreadShell,
} from "@j1code/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { DispatchModeLimit } from "../../../orchestration-v2/DispatchModeLimit.ts";
import { OrchestratorV2, OrchestratorThreadAlreadyExistsError } from "../../../orchestration-v2/Orchestrator.ts";
import { ProjectStoreV2 } from "../../../orchestration-v2/ProjectStore.ts";
import { registerRoute, type RouteState } from "../../../routing/routeState.ts";
import { layerTest as layerTestSettings } from "../../../serverSettings.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { RoutingBoundaryPorts } from "../routing/boundary.ts";
import { HomeToolkitHandlersLive } from "./handlers.ts";
import { HomeToolkit } from "./tools.ts";

const projectId = ProjectId.make("destination");
const homeId = ProjectId.make("j1-home");
const sourceId = ThreadId.make("source");
const env = EnvironmentId.make("remote:one");
const instance = ProviderInstanceId.make("codex");
const request = "Fix video uploads, preserving existing data.";
const title = "Fix uploads";
const at = "2026-08-01T00:00:00.000Z";
const project: OrchestrationProjectShell = {
  id: projectId, title: "Project", workspaceRoot: "/workspace/project",
  defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at,
};
const source = { ...liveThreadShell(sourceId, { interactionMode: "plan" }), projectId: homeId };

type Create = Extract<OrchestrationV2ServerCommand, { type: "thread.create" }>;
type Options = {
  readonly capability?: boolean;
  readonly clientOnly?: boolean;
  readonly stale?: boolean;
  readonly foreignSource?: boolean;
  readonly missingProject?: boolean;
  readonly missingSourceProject?: boolean;
  readonly foreignProjectShell?: boolean;
  readonly deletedSource?: boolean;
  readonly foreignEnvironment?: boolean;
  readonly revokeAfterCreate?: boolean;
  readonly mode?: "off" | "suggest" | "auto";
  readonly managed?: boolean;
};
function harness(options: Options = {}) {
  const commands: Create[] = [];
  const submissions: unknown[] = [];
  let destination: OrchestrationV2ThreadShell | null = null;
  let state: RouteState | null = null;
  let storedCreation: Create | null = null;
  let legacy: OrchestrationV2ConversationMessage | null = null;
  let sourceRevoked = false;
  let holdRoute = false;
  const projects = [
    ...(options.missingSourceProject ? [] : [{ ...project, id: homeId }]),
    ...(options.missingProject ? [] : [project]),
    { ...project, id: ProjectId.make("archived"), archivedAt: at },
  ];
  const dependencies = Layer.mergeAll(
    Layer.mock(OrchestratorV2)({
      getThreadShell: (id) => Effect.sync(() => id === sourceId
        ? {
            ...source,
            activeRunId: options.stale || sourceRevoked ? null : source.activeRunId,
            deletedAt: options.deletedSource ? source.createdAt : null,
          }
        : destination?.id === id ? destination : null),
      getThreadRecords: (id) => Effect.sync(() => {
        if (destination === null || id !== destination.id) throw new Error("Fixture destination unavailable");
        return { ...idleThreadProjection(destination), messages: legacy ? [legacy] : [] };
      }),
      dispatch: (command) => Effect.gen(function* () {
        expect(command.type).toBe("thread.create");
        if (command.type !== "thread.create") return yield* Effect.die("A handoff cannot dispatch a provider turn here.");
        expect(yield* DispatchModeLimit).toEqual({ runtimeMode: "full-access", interactionMode: "plan" });
        if (storedCreation?.commandId !== command.commandId) {
          if (destination !== null) return yield* new OrchestratorThreadAlreadyExistsError({
            commandId: command.commandId, threadId: command.threadId,
          });
          storedCreation = command;
          commands.push(command);
          destination = {
            ...source, id: command.threadId, title: command.title, projectId: command.projectId,
            activeRunId: null, pendingRuntimeRequest: null,
          };
        }
        if (options.revokeAfterCreate) sourceRevoked = true;
        if (destination === null) return yield* Effect.die("Fixture destination not created");
        const payload = idleThreadProjection(destination).thread;
        return {
          sequence: 1,
          storedEvents: [{
            sequence: 1,
            commandId: command.commandId,
            event: {
              id: EventId.make("event:handoff-create"),
              type: "thread.created",
              threadId: command.threadId,
              occurredAt: payload.createdAt,
              payload,
            },
          }],
        };
      }),
    }),
    Layer.mock(ProjectStoreV2)({
      getShell: (id) => Effect.succeed(Option.fromNullishOr(
        options.foreignProjectShell && id === homeId ? project : projects.find((row) => row.id === id),
      )),
      listShells: () => Effect.succeed(projects),
    }),
    Layer.mock(RoutingBoundaryPorts)({
      current: (environmentId, threadId) => Effect.sync(() => {
        if (environmentId !== env) return null;
        if (threadId === sourceId) {
          return {
            environmentId: options.foreignEnvironment ? EnvironmentId.make("remote:other") : env,
            projectId: options.foreignSource ? projectId : homeId,
            threadId,
          };
        }
        return destination?.id === threadId
          ? { environmentId: env, projectId: destination.projectId, threadId }
          : null;
      }),
      policy: () => Effect.succeed({
        mode: options.mode ?? "auto", manual: false, visited: [], maxHops: 8,
      }),
      get: () => Effect.sync(() => state),
      submit: (input) => Effect.gen(function* () {
        if (holdRoute) return yield* Effect.fail("Temporarily unavailable");
        submissions.push(input);
        state = registerRoute({
          ...input.route, monitorSource: true,
          permissionCeiling: ["runtime:full-access"], destinationPermissions: ["runtime:full-access"],
        });
        return state;
      }),
    }),
    layerTestSettings({}, options.managed ? {
      organization: "Managed", lockedSettings: [], limits: { maxRuntimeMode: "approval-required" },
    } : undefined),
  );
  const scope: McpInvocationScope = {
    environmentId: env,
    thread: options.clientOnly ? undefined : { threadId: sourceId, providerSessionId: "credential", providerInstanceId: instance },
    client: options.clientOnly ? { sessionId: "outside", label: "Outside", access: "full-access" } : undefined,
    capabilities: new Set(options.capability === false ? [] : ["agents"]),
    requestNamespace: "credential", issuedAt: 1,
  };
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
    Effect.provideService(McpInvocationContext, scope),
    Effect.provide(Layer.merge(HomeToolkitHandlersLive, dependencies)),
  );
  const call = (body = request, id = projectId, subject = title, requestId = "request-1") => run(Effect.gen(function* () {
    return yield* (yield* HomeToolkit).handle("handoff_to_project", {
      requestId, projectId: id, title: subject, request: body,
    }).pipe(Stream.unwrap, Stream.runCollect);
  }));
  const list = run(Effect.gen(function* () {
    return yield* (yield* HomeToolkit).handle("list_chat_projects", {}).pipe(Stream.unwrap, Stream.runCollect);
  }));
  return {
    call, list, commands, submissions,
    rename() { if (destination) destination = { ...destination, title: "Renamed" }; },
    hold(value: boolean) { holdRoute = value; },
    legacy(text: string, foreignProject = false) {
      // Use the inherited id from the current create call, then represent only saved V1 data.
      if (!destination) throw new Error("No fixture destination");
      legacy = {
        id: MessageId.make(destination.id.replace("j1-handoff-", "handoff-request:")),
        threadId: destination.id,
        runId: null,
        nodeId: null,
        role: "user",
        text,
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "server",
        createdAt: destination.createdAt,
        updatedAt: destination.updatedAt,
      };
      if (foreignProject) destination = { ...destination, projectId: homeId };
      commands.length = 0;
      submissions.length = 0;
      state = null;
    },
  };
}

it.effect("lists only active destinations and preserves the singleton Home workspace", () =>
  Effect.gen(function* () {
    const h = harness();
    const result = yield* h.list;
    expect(result.at(-1)?.result).toEqual([{ id: projectId, title: project.title, workspaceRoot: project.workspaceRoot }]);
    expect(h.commands).toEqual([]);
  }),
);

it.effect("creates a separately owned V2 project chat and returns queued rather than delivered", () =>
  Effect.gen(function* () {
    const h = harness();
    const result = yield* h.call();
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]).toMatchObject({
      type: "thread.create", projectId, runtimeMode: "full-access", interactionMode: "plan",
      branch: null, worktreePath: null,
    });
    expect(h.commands[0]).not.toHaveProperty("initialMessage");
    expect(h.submissions).toEqual([
      expect.objectContaining({ route: expect.objectContaining({
        source: { environmentId: env, projectId: homeId, threadId: sourceId },
        destination: { environmentId: env, projectId, threadId: h.commands[0]?.threadId },
        content: "## Fix uploads\n\nFix video uploads, preserving existing data.\n\n[View source conversation](/remote%3Aone/source)",
        initiation: "automatic",
      }) }),
    ]);
    expect(result.at(-1)?.result).toMatchObject({
      status: "queued", url: expect.stringMatching(/^\/remote%3Aone\/j1-handoff-/),
      requestId: expect.stringMatching(/^home-handoff:/),
    });
  }),
);

it.effect("replays the same request after rename while rejecting changed body or title", () =>
  Effect.gen(function* () {
    const h = harness();
    const result = yield* h.call();
    h.rename();
    expect((yield* h.call()).at(-1)?.result).toEqual(result.at(-1)?.result);
    yield* h.call("Different request").pipe(Effect.flip);
    yield* h.call(request, projectId, "Different title").pipe(Effect.flip);
    expect(h.commands).toHaveLength(1);
    expect(h.submissions).toHaveLength(1);
  }),
);

it.effect("recovers the exact create receipt after a route-write failure", () =>
  Effect.gen(function* () {
    const h = harness();
    h.hold(true);
    yield* h.call().pipe(Effect.flip);
    expect(h.commands).toHaveLength(1);
    h.hold(false);
    yield* h.call("A different request").pipe(Effect.flip);
    const recovered = yield* h.call();
    expect(recovered.at(-1)?.result).toMatchObject({ status: "queued" });
    expect(h.commands).toHaveLength(1);
    expect(h.submissions).toHaveLength(1);
  }),
);

it.effect.each([
  "Request handed off from [the source conversation](/remote%3Aone/source). Work in this project's workspace and follow its instructions.\n\nFix video uploads, preserving existing data.",
  "## Fix uploads\n\nFix video uploads, preserving existing data.\n\n[View the conversation in Home](/remote%3Aone/source)",
])("replays saved legacy handoffs without re-sending work", (legacy) =>
  Effect.gen(function* () {
    const h = harness();
    yield* h.call();
    h.legacy(legacy);
    expect((yield* h.call()).at(-1)?.result).toMatchObject({ status: "existing" });
    yield* h.call("Different request").pipe(Effect.flip);
    expect(h.commands).toEqual([]);
    expect(h.submissions).toEqual([]);
  }),
);

it.effect("rejects foreign saved targets and unauthorized or unavailable requests", () =>
  Effect.gen(function* () {
    const foreign = harness();
    yield* foreign.call();
    foreign.legacy(request, true);
    yield* foreign.call().pipe(Effect.flip);
    expect(foreign.commands).toEqual([]);
    for (const h of [
      harness({ capability: false }), harness({ clientOnly: true }), harness({ stale: true }),
      harness({ foreignSource: true }), harness({ missingProject: true }),
      harness({ missingSourceProject: true }), harness({ foreignProjectShell: true }),
      harness({ deletedSource: true }), harness({ foreignEnvironment: true }),
      harness({ mode: "off" }), harness({ mode: "suggest" }), harness({ managed: true }),
    ]) {
      yield* h.call().pipe(Effect.flip);
      expect(h.commands).toEqual([]);
      expect(h.submissions).toEqual([]);
    }
  }),
);

it.effect("retains Unicode handoff IDs and rejects conflicting replay", () =>
  Effect.gen(function* () {
    const h = harness();
    const first = yield* h.call("Keep \u00e9 and \u{1f680}", projectId, "Fix \u96ea", "request-\u96ea");
    expect(first.at(-1)?.result).toMatchObject({
      threadId: "j1-handoff-8a3ad1149374fa3b575775827397de22",
      requestId: "home-handoff:8a3ad1149374fa3b575775827397de22",
    });
    expect(h.commands[0]?.commandId).toBe(
      "handoff-create:8a3ad1149374fa3b575775827397de22:d02c0e38bfa5bb45fe8ce1c4ea9504ac615cc80d015984e8b20f9ad942f756e0",
    );
    expect(h.submissions[0]).toMatchObject({ fingerprint: "d02c0e38bfa5bb45fe8ce1c4ea9504ac615cc80d015984e8b20f9ad942f756e0" });
    expect(yield* h.call("Keep \u00e9 and \u{1f680}", projectId, "Fix \u96ea", "request-\u96ea")).toEqual(first);
    yield* h.call("Changed", projectId, "Fix \u96ea", "request-\u96ea").pipe(Effect.flip);
    expect(h.commands).toHaveLength(1);
    expect(h.submissions).toHaveLength(1);
  }),
);

it.effect("does not queue a handoff after the source loses authority during creation", () =>
  Effect.gen(function* () {
    const h = harness({ revokeAfterCreate: true });
    yield* h.call().pipe(Effect.flip);
    yield* h.call().pipe(Effect.flip);
    expect(h.commands).toHaveLength(1);
    expect(h.submissions).toEqual([]);
  }),
);
