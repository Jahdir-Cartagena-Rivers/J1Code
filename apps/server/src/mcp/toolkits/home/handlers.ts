import { hashTelemetryId as hashUtf8Sha256 } from "@j1code/shared/telemetryId";
import { CommandId, MessageId, ThreadId, isRuntimeModeAbove, type OrchestratorMcpFailure, type ProjectId } from "@j1code/contracts";
import { modelSelectionsEqual } from "@j1code/shared/model";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { DispatchModeLimit } from "../../../orchestration-v2/DispatchModeLimit.ts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import { ProjectStoreV2 } from "../../../orchestration-v2/ProjectStore.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import type { RouteEndpoint } from "../../../routing/routeState.ts";
import { requireMcpCapability, requireThreadScope, type McpThreadInvocationScope } from "../../McpInvocationContext.ts";
import { isLiveCallerShell } from "../../threadAccess.ts";
import { RoutingBoundaryPorts } from "../routing/boundary.ts";
import { HomeToolkit } from "./tools.ts";

const unavailable = "The source chat or destination project is unavailable.";
const conflict = "That requestId belongs to a different handoff.";
const homeProject = "j1-home";
const sameEndpoint = (left: RouteEndpoint | null, right: RouteEndpoint) =>
  left?.environmentId === right.environmentId && left.projectId === right.projectId &&
  left.threadId === right.threadId;
const conversationUrl = (environmentId: string, threadId: string) =>
  "/" + encodeURIComponent(environmentId) + "/" + encodeURIComponent(threadId);

function handoffIdentity(source: RouteEndpoint, requestId: string, projectId: string, title: string, request: string) {
  const digest = hashUtf8Sha256(source.threadId + ":" + requestId).slice(0, 32);
  const fingerprint = hashUtf8Sha256(JSON.stringify([
    source.environmentId, source.projectId, source.threadId, requestId, projectId, title, request,
  ]));
  const sourceUrl = conversationUrl(source.environmentId, source.threadId);
  return {
    threadId: ThreadId.make("j1-handoff-" + digest),
    commandId: CommandId.make("handoff-create:" + digest + ":" + fingerprint),
    requestId: "home-handoff:" + digest,
    legacyMessageId: MessageId.make("handoff-request:" + digest),
    text: "## " + title + "\n\n" + request + "\n\n[View source conversation](" + sourceUrl + ")",
    previousHomeText: "## " + title + "\n\n" + request + "\n\n[View the conversation in Home](" + sourceUrl + ")",
    previousText: "Request handed off from [the source conversation](" + sourceUrl +
      "). Work in this project's workspace and follow its instructions.\n\n" + request,
    sourceUrl,
    fingerprint,
  };
}

const liveSource = Effect.fn("Home.liveSource")(function* () {
  const invocation = yield* requireMcpCapability("agents").pipe(Effect.mapError(() => unavailable));
  if (invocation.client !== undefined) return yield* Effect.fail(unavailable);
  const threadScope: Effect.Effect<McpThreadInvocationScope, OrchestratorMcpFailure> =
    requireThreadScope(invocation, "Project routing");
  const scope = yield* threadScope.pipe(Effect.mapError(() => unavailable));
  const orchestration = yield* OrchestratorV2;
  const parent = yield* orchestration.getThreadShell(scope.thread.threadId).pipe(Effect.mapError(() => unavailable));
  if (!parent || parent.id !== scope.thread.threadId || parent.deletedAt !== null ||
      !isLiveCallerShell(parent, scope.thread.providerInstanceId)) return yield* Effect.fail(unavailable);
  return { scope, parent };
});

const activeProject = Effect.fn("Home.activeProject")(function* (id: ProjectId) {
  const projects = yield* ProjectStoreV2;
  const match = yield* projects.getShell(id).pipe(
    Effect.mapError(() => unavailable),
  );
  if (Option.isNone(match) || match.value.id !== id || match.value.archivedAt != null)
    return yield* Effect.fail(unavailable);
  return match.value;
});

export const HomeToolkitHandlersLive = HomeToolkit.toLayer(Effect.succeed(HomeToolkit.of({
  list_chat_projects: Effect.fn("list_chat_projects")(function* () {
      const { parent } = yield* liveSource();
      yield* activeProject(parent.projectId);
      const projects = yield* (yield* ProjectStoreV2).listShells().pipe(Effect.mapError(() => unavailable));
      return projects.filter((row) => row.archivedAt == null && row.id !== homeProject)
        .map(({ id, title, workspaceRoot }) => ({ id, title, workspaceRoot }));
    }),
  handoff_to_project: Effect.fn("handoff_to_project")(function* (input) {
      const { parent, scope } = yield* liveSource();
      if (input.projectId === homeProject) return yield* Effect.fail(unavailable);
      yield* activeProject(parent.projectId);
      yield* activeProject(input.projectId);
      const routes = yield* RoutingBoundaryPorts;
      const orchestration = yield* OrchestratorV2;
      const source = { environmentId: scope.environmentId, projectId: parent.projectId, threadId: parent.id };
      if (!sameEndpoint(yield* routes.current(source.environmentId, source.threadId), source))
        return yield* Effect.fail(unavailable);
      const identity = handoffIdentity(source, input.requestId, input.projectId, input.title, input.request);
      const destination = { environmentId: scope.environmentId, projectId: input.projectId, threadId: identity.threadId };
      const url = conversationUrl(destination.environmentId, destination.threadId);
      const replay = Effect.gen(function* () {
        const prior = yield* routes.get(identity.requestId);
        if (prior === null) return null;
        if (prior.originalRequest.requestId !== identity.requestId ||
            !sameEndpoint(prior.originalRequest.source, source) ||
            !sameEndpoint(prior.originalRequest.destination, destination) ||
            prior.originalRequest.content !== identity.text)
          return yield* Effect.fail(conflict);
        return { threadId: identity.threadId, url, requestId: identity.requestId, status: prior.status };
      });
      const prior = yield* replay;
      if (prior !== null) return prior;

      const saved = yield* orchestration.getThreadShell(destination.threadId).pipe(Effect.mapError(() => unavailable));
      if (saved !== null) {
        if (saved.id !== destination.threadId || saved.projectId !== destination.projectId ||
            saved.archivedAt !== null || saved.deletedAt !== null) return yield* Effect.fail(conflict);
        const records = yield* orchestration.getThreadRecords(saved.id, ["messages"], { messageIds: [identity.legacyMessageId] }).pipe(
          Effect.mapError(() => unavailable),
        );
        const legacy = records.messages.find((row) => row.id === identity.legacyMessageId);
        if (legacy !== undefined) {
          if (legacy.role !== "user" || (legacy.senderThreadId !== undefined && legacy.senderThreadId !== source.threadId) ||
              (legacy.text !== identity.text && legacy.text !== identity.previousHomeText &&
                !(legacy.text === identity.previousText && saved.title === input.title)))
            return yield* Effect.fail(conflict);
          return { threadId: identity.threadId, url, status: "existing" as const };
        }
      }

      // A model request supplies a project choice, not a trusted UI approval to create a new target.
      const policy = yield* routes.policy(source, input.requestId);
      if (policy.mode === "off") return yield* Effect.fail("Automatic routing is off for this conversation.");
      if (policy.mode === "suggest")
        return yield* Effect.fail("A new project chat needs confirmation in J1 before this request can be handed off.");
      const settings = yield* ServerSettingsService;
      if (isRuntimeModeAbove(parent.runtimeMode, settings.managedPolicy?.limits?.maxRuntimeMode))
        return yield* Effect.fail("The current route cannot preserve the source approval mode within the managed limit.");
      if (!Number.isSafeInteger(policy.maxHops) || policy.maxHops < 1 ||
          policy.visited.length >= policy.maxHops ||
          policy.visited.some((endpoint) => sameEndpoint(endpoint, source) || sameEndpoint(endpoint, destination)))
        return yield* Effect.fail("The route would revisit a conversation or exceed its hop limit.");

      // Receipt replay is safe only for the exact payload-specific creation command and immutable target id.
      // An existing unrelated target cannot be adopted. A retry can recover a shell created before route persistence.
      const limit = { runtimeMode: parent.runtimeMode, interactionMode: parent.interactionMode };
      const creation = yield* orchestration.dispatch({
        type: "thread.create",
        commandId: identity.commandId,
        threadId: destination.threadId,
        projectId: destination.projectId,
        title: input.title,
        modelSelection: parent.modelSelection,
        ...limit,
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "server",
      }).pipe(
        Effect.provideService(DispatchModeLimit, limit),
        Effect.mapError(() => saved === null ? "The destination chat could not be created." : conflict),
      );
      if (!creation.storedEvents.some(({ event }) =>
        event.type === "thread.created" && event.threadId === destination.threadId &&
        event.payload.projectId === destination.projectId && event.payload.title === input.title &&
        event.payload.runtimeMode === limit.runtimeMode &&
        event.payload.interactionMode === limit.interactionMode &&
        modelSelectionsEqual(event.payload.modelSelection, parent.modelSelection)))
        return yield* Effect.fail(conflict);

      const concurrentRoute = yield* replay;
      if (concurrentRoute !== null) return concurrentRoute;
      const currentTarget = yield* orchestration.getThreadShell(destination.threadId).pipe(Effect.mapError(() => unavailable));
      if (!currentTarget || currentTarget.id !== destination.threadId ||
          currentTarget.projectId !== destination.projectId || currentTarget.archivedAt !== null ||
          currentTarget.deletedAt !== null || currentTarget.runtimeMode !== limit.runtimeMode ||
          currentTarget.interactionMode !== limit.interactionMode || currentTarget.activeRunId !== null ||
          currentTarget.pendingRuntimeRequest !== null ||
          !modelSelectionsEqual(currentTarget.modelSelection, parent.modelSelection) ||
          !sameEndpoint(yield* routes.current(destination.environmentId, destination.threadId), destination))
        return yield* Effect.fail(unavailable);
      const { parent: currentSource } = yield* liveSource();
      const currentPolicy = yield* routes.policy(source, input.requestId);
      if (currentSource.projectId !== source.projectId || currentSource.runtimeMode !== limit.runtimeMode ||
          currentSource.interactionMode !== limit.interactionMode ||
          !modelSelectionsEqual(currentSource.modelSelection, parent.modelSelection) ||
          currentPolicy.mode !== "auto")
        return yield* Effect.fail("The source authority changed before the handoff was queued.");

      // No task owner is inherited by a request to create a fresh destination. The durable route
      // owns its message id, admission and monitored outcomes, so there is no direct start here.
      const state = yield* routes.submit({
        route: {
          requestId: identity.requestId, source, destination, content: identity.text,
          mode: currentPolicy.mode, initiation: "automatic", visited: currentPolicy.visited,
          maxHops: currentPolicy.maxHops, ambiguous: false,
        },
        fingerprint: identity.fingerprint,
        originalRequest: input.request,
        sourceUrl: identity.sourceUrl,
      });
      return { threadId: destination.threadId, url, requestId: identity.requestId, status: state.status };
    }),
})));
