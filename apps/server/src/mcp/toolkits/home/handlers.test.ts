import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { HomeToolkit } from "./tools.ts";
import { HomeToolkitHandlersLive } from "./handlers.ts";

const PROJECT_ID = ProjectId.make("destination");
const THREAD_ID = ThreadId.make("source");
function makeProject(
  repositoryIdentity: OrchestrationProjectShell["repositoryIdentity"] = {
    canonicalKey: "github.com/t3tools/t3code",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:T3Tools/T3Code.git",
    },
    provider: "github",
    displayName: "T3Tools/T3Code",
    owner: "T3Tools",
    name: "T3Code",
  },
): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    repositoryIdentity,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function makeThread(): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function harness(options: { capability?: boolean; missingProject?: boolean } = {}) {
  const commands: OrchestrationCommand[] = [];
  let destination: OrchestrationThread | null = null;
  const receipts = new Set<string>();
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (id) =>
        Effect.succeed(
          id === THREAD_ID
            ? Option.some(makeThread())
            : destination
              ? Option.some({ ...makeThread(), ...destination })
              : Option.none(),
        ),
      getThreadDetailById: () => Effect.succeed(Option.fromNullishOr(destination)),
      getProjectShells: () => Effect.succeed([makeProject()]),
      getProjectShellById: () =>
        Effect.succeed(options.missingProject ? Option.none() : Option.some(makeProject())),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Effect.sync(() => {
          if (receipts.has(command.commandId)) return { sequence: commands.length };
          receipts.add(command.commandId);
          commands.push(command);
          if (command.type === "thread.create")
            destination = {
              ...makeThread(),
              id: command.threadId,
              projectId: command.projectId,
              title: command.title,
              deletedAt: null,
              messages: [],
              activities: [],
              checkpoints: [],
              proposedPlans: [],
            };
          if (
            command.type === "thread.activity.append" &&
            destination &&
            command.threadId === destination.id
          )
            destination = {
              ...destination,
              activities: [...destination.activities, command.activity],
            };
          if (command.type === "thread.turn.start" && destination)
            destination = {
              ...destination,
              messages: [
                ...destination.messages,
                {
                  id: command.message.messageId,
                  role: "user",
                  text: command.message.text,
                  turnId: null,
                  streaming: false,
                  createdAt: command.createdAt,
                  updatedAt: command.createdAt,
                },
              ],
            };
          return { sequence: commands.length };
        }),
    }),
  );
  const call = (projectId = PROJECT_ID, request = "Fix video uploads, preserving existing data.") =>
    Effect.gen(function* () {
      const toolkit = yield* HomeToolkit;
      return yield* toolkit
        .handle("handoff_to_project", {
          requestId: "request-1",
          projectId,
          title: "Fix uploads",
          request,
        })
        .pipe(Stream.unwrap, Stream.runCollect);
    }).pipe(
      Effect.provide(HomeToolkitHandlersLive.pipe(Layer.provide(dependencies))),
      Effect.provideService(McpInvocationContext, {
        environmentId: EnvironmentId.make("remote:one"),
        threadId: THREAD_ID,
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(options.capability === false ? [] : ["agents" as const]),
        issuedAt: 1,
      }),
      Effect.provide(dependencies),
    );
  return {
    call,
    commands,
    rename: () => {
      if (destination) destination = { ...destination, title: "Automatically generated title" };
    },
    useLegacyText: () => {
      if (destination)
        destination = {
          ...destination,
          messages: destination.messages.map((message) => ({
            ...message,
            text: "Request handed off from [the source conversation](/remote%3Aone/source). Work in this project's workspace and follow its instructions.\n\nFix video uploads, preserving existing data.",
          })),
        };
    },
    useHomeText: () => {
      if (destination)
        destination = {
          ...destination,
          messages: destination.messages.map((message) => ({
            ...message,
            text: "## Fix uploads\n\nFix video uploads, preserving existing data.\n\n[View the conversation in Home](/remote%3Aone/source)",
          })),
        };
    },
  };
}
describe("project handoff", () => {
  it.effect(
    "creates an independent destination chat with inherited permissions and a relative link",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const result = yield* h.call();
        expect(h.commands).toHaveLength(4);
        expect(h.commands[0]).toMatchObject({
          type: "thread.create",
          projectId: PROJECT_ID,
          branch: null,
          worktreePath: null,
          runtimeMode: "full-access",
        });
        expect(h.commands[2]).toMatchObject({
          type: "thread.turn.start",
          message: {
            role: "user",
            text: "## Fix uploads\n\nFix video uploads, preserving existing data.\n\n[View source conversation](/remote%3Aone/source)",
          },
        });
        expect(result.at(-1)?.result).toMatchObject({
          url: expect.stringMatching(/^\/remote%3Aone\/j1-handoff-/),
        });
      }),
  );
  it.effect("uses stable command and thread IDs on a retry", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.call();
      yield* h.call();
      expect(h.commands).toHaveLength(4);
    }),
  );
  it.effect(
    "rejects reuse of a request ID for different content without starting another turn",
    () =>
      Effect.gen(function* () {
        const h = harness();
        yield* h.call();
        yield* h.call(PROJECT_ID, "A different request").pipe(Effect.flip);
        expect(h.commands).toHaveLength(4);
      }),
  );
  it.effect("allows an identical retry after the destination title changes", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.call();
      h.rename();
      yield* h.call();
      expect(h.commands).toHaveLength(4);
    }),
  );
  it.effect("accepts an identical retry of a handoff written in the previous format", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.call();
      h.useLegacyText();
      yield* h.call();
      expect(h.commands).toHaveLength(4);
    }),
  );
  it.effect("accepts an identical retry of a handoff with the earlier Home link", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.call();
      h.useHomeText();
      yield* h.call();
      expect(h.commands).toHaveLength(4);
    }),
  );
  it.effect("rejects missing capability before writing", () =>
    Effect.gen(function* () {
      const h = harness({ capability: false });
      yield* h.call().pipe(Effect.flip);
      expect(h.commands).toEqual([]);
    }),
  );
  it.effect("rejects a missing destination before creating a chat", () =>
    Effect.gen(function* () {
      const h = harness({ missingProject: true });
      yield* h.call().pipe(Effect.flip);
      expect(h.commands).toEqual([]);
    }),
  );
});
