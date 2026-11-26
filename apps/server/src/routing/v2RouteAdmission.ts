import {
  isRuntimeModeAbove,
  ProjectId,
  resolveProjectProviderInstanceEnabled,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2IdleRouteCommand,
  type ServerProvider,
  type ServerSettings,
} from "@j1code/contracts";
import { modelSelectionsEqual } from "@j1code/shared/model";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { exceededDispatchModeLimit, type DispatchModes } from "../orchestration-v2/DispatchModeLimit.ts";
import { EffectOutboxV2 } from "../orchestration-v2/EffectOutbox.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import {
  StrictRouteNativeAuthorization,
  type StrictRouteNativeAuthorizationInput,
  strictSteerFingerprint,
  STRICT_STEER_EFFECT_PREFIX,
} from "../orchestration-v2/ProviderTurnControlService.ts";
import { RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeDurableRoutingStore, RoutingStoreError, type StoredRoute } from "./durableRoutingStore.ts";
import { ExternalRouteEndpoints } from "./ExternalRouteEndpoints.ts";
import { PROJECT_BUILD_OWNER_TASK } from "./integrationOwner.ts";
import {
  assertIdleRouteSubmission, claimIdleRouteSubmission, claimStrictRouteSubmission,
  strictRouteDescriptorFingerprint, type RouteEndpoint, type RouteState,
} from "./routeState.ts";
import type { PreparedStrictRouteDelivery } from "./v2StrictDelivery.ts";
import { idleStartEffect } from "./v2IdleDelivery.ts";

type NativeAuthorization = (input: StrictRouteNativeAuthorizationInput) => Effect.Effect<string | null>;

interface V2RouteAdmissionShape {
  readonly validate: (
    row: StoredRoute,
    delivery: PreparedStrictRouteDelivery,
  ) => Effect.Effect<DispatchModes | null>;
  readonly authorizeNative: NativeAuthorization;
  readonly prepareIdle: (
    row: StoredRoute, command: OrchestrationV2IdleRouteCommand,
  ) => Effect.Effect<{ readonly policyFingerprint: string; readonly authorityFingerprint: string } | null>;
  readonly authorizeIdle: (
    command: OrchestrationV2IdleRouteCommand,
    phase: "intake" | "starting" | "running",
    leaseOwner?: string,
  ) => Effect.Effect<string | null>;
  readonly readIdleClaim: (
    runId: string, messageId: string,
  ) => Effect.Effect<OrchestrationV2IdleRouteCommand | null>;
}

export class V2RouteAdmission extends Context.Service<V2RouteAdmission, V2RouteAdmissionShape>()(
  "@j1code/server/routing/v2RouteAdmission",
) {}

const validateProof = <A>(operation: string, validate: () => A) =>
  Effect.try({ try: validate, catch: (cause) => new RoutingStoreError({ operation, cause }) });

function sameEndpoint(a: RouteEndpoint, b: RouteEndpoint): boolean {
  return a.environmentId === b.environmentId && a.projectId === b.projectId && a.threadId === b.threadId;
}

function routePolicyAllows(state: RouteState, current: ServerSettings["chatRoutingMode"]): boolean {
  const { request, resolution } = state;
  if (
    request.destination === null || request.ambiguous ||
    !Number.isSafeInteger(request.maxHops) || request.maxHops < 1 ||
    request.visited.length >= request.maxHops
  ) return false;
  // resolveRoute already authenticated the user action and persisted its exact scope.
  // That authorization survives delivery delays; live endpoint/provider checks still apply.
  if (resolution !== null) {
    if (!resolution.userId.trim() ||
        !sameEndpoint(resolution.source, request.source) ||
        !sameEndpoint(resolution.source, state.originalRequest.source) ||
        !sameEndpoint(resolution.destination, request.destination) ||
        strictSteerFingerprint(resolution.destinationPermissions) !==
          strictSteerFingerprint(request.destinationPermissions)) return false;
  } else if (request.initiation !== "manual" &&
             (current !== "auto" || request.mode !== "auto")) return false;
  const visited = [...request.visited, request.source, request.destination];
  const keys = visited.map(({ environmentId, projectId, threadId }) =>
    JSON.stringify([environmentId, projectId, threadId]));
  return new Set(keys).size === keys.length;
}

function eligibleProvider(
  providers: ReadonlyArray<ServerProvider>,
  settings: ServerSettings,
  shell: OrchestrationV2ThreadShell,
): ServerProvider | null {
  const matches = providers.filter(({ instanceId }) => instanceId === shell.providerInstanceId);
  const [provider] = matches;
  return matches.length === 1 && provider !== undefined &&
    shell.modelSelection.instanceId === shell.providerInstanceId &&
    resolveProjectProviderInstanceEnabled(settings, shell.projectId, shell.providerInstanceId) &&
    provider.enabled && provider.installed && provider.status === "ready" &&
    provider.availability !== "unavailable" && provider.auth.status === "authenticated" &&
    provider.models.some(({ slug }) => slug === shell.modelSelection.model)
      ? provider : null;
}

function localProviderIdentity(
  provider: ServerProvider,
  modelSelection: OrchestrationV2ThreadShell["modelSelection"],
) {
  const { auth } = provider;
  return ["local", provider.instanceId, provider.driver, modelSelection,
    auth.profileId, auth.workspaceId, auth.email, auth.endpoint] as const;
}

const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment;
  const settings = yield* ServerSettingsService;
  const projection = yield* ProjectionStoreV2;
  const projects = yield* Effect.serviceOption(ProjectStoreV2);
  const registry = yield* ProviderRegistry;
  const outbox = yield* EffectOutboxV2;
  const runtimePolicy = yield* RuntimePolicyV2;
  const external = yield* Effect.serviceOption(ExternalRouteEndpoints);
  const sql = yield* SqlClient.SqlClient;
  const store = yield* makeDurableRoutingStore;

  const shellFor = Effect.fn("V2RouteAdmission.shellFor")(function* (endpoint: RouteEndpoint) {
    const shell = yield* projection.getThreadShell(ThreadId.make(endpoint.threadId));
    return shell?.id === endpoint.threadId && shell.projectId === endpoint.projectId &&
      shell.archivedAt === null && shell.deletedAt === null && shell.pendingRuntimeRequest === null
      ? shell : null;
  });

  const idleCurrent = Effect.fn("V2RouteAdmission.idleCurrent")(function* (
    state: RouteState, command: OrchestrationV2IdleRouteCommand, phase: "intake" | "starting" | "running",
  ) {
    const { request } = state;
    const destination = request.destination;
    const env = yield* environment.getEnvironmentId;
    const current = yield* settings.getSettings;
    if (!destination || command.environmentId !== env || request.source.environmentId !== env ||
        destination.environmentId !== env || !routePolicyAllows(state, current.chatRoutingMode) ||
        Option.isNone(projects)) return null;
    for (const projectId of new Set([request.source.projectId, destination.projectId])) {
      if (projectId === request.source.projectId && projectId !== destination.projectId &&
          request.source.threadId.startsWith("mausbot:")) continue;
      const project = yield* projects.value.get(ProjectId.make(projectId));
      if (Option.isNone(project) || project.value.archivedAt !== null) return null;
    }
    if (request.taskId !== undefined && state.resolution === null && request.initiation !== "manual") {
      const owners = yield* sql<{ thread_id: string; project_id: string }>`
        SELECT DISTINCT thread_id, project_id FROM task_owner_bindings
        WHERE task_id = ${request.taskId} AND environment_id = ${env} AND revocation_json IS NULL
          AND (${request.taskId} <> ${PROJECT_BUILD_OWNER_TASK} OR project_id = ${request.source.projectId})
        LIMIT 2
      `;
      if (owners.length !== 1 || owners[0]?.thread_id !== destination.threadId ||
          owners[0]?.project_id !== destination.projectId) return null;
    }
    const shell = yield* shellFor(destination);
    const providers = yield* registry.getProviders;
    if (!shell) return null;
    const destinationProvider = eligibleProvider(providers, current, shell);
    if (!destinationProvider ||
        shell.runtimeMode !== command.runtimeMode || shell.interactionMode !== command.interactionMode ||
        !modelSelectionsEqual(shell.modelSelection, command.modelSelection) ||
        (phase === "intake" && (shell.activeRunId !== null ||
          shell.activeProviderThreadId !== command.activeProviderThreadId))) return null;
    const records = yield* projection.getThreadRecords(shell.id, ["runs", "runtimeRequests", "providerThreads",
      "providerTurns", "contextTransfers"], { runtimeRequestStatuses: ["pending"] });
    const outstanding = records.runs.filter(({ status }) =>
      status === "queued" || status === "preparing" || status === "starting" ||
      status === "running" || status === "waiting");
    const providerThread = records.providerThreads.find(({ id }) => id === shell.activeProviderThreadId);
    if (records.runtimeRequests.length !== 0 ||
        records.contextTransfers.some(({ status }) => status === "pending") ||
        records.providerTurns.some(({ status, runAttemptId }) =>
          (status === "running" || status === "pending") &&
          (phase !== "running" || runAttemptId !== outstanding[0]?.activeAttemptId)) ||
        (providerThread !== undefined && providerThread.providerInstanceId !== shell.providerInstanceId)) return null;
    if (phase === "intake") {
      if (outstanding.length !== 0) return null;
    } else if (outstanding.length !== 1 || outstanding[0]?.status !== phase ||
        outstanding[0].id !== command.runId || outstanding[0].userMessageId !== command.messageId ||
        !modelSelectionsEqual(outstanding[0].modelSelection, command.modelSelection) ||
        shell.activeRunId !== command.runId ||
        (command.activeProviderThreadId !== null &&
          outstanding[0].providerThreadId !== command.activeProviderThreadId) ||
        (yield* projection.hasRunInterruptRequest(shell.id, command.runId))) return null;
    const policy = yield* runtimePolicy.resolve({ thread: records.thread, modelSelection: command.modelSelection });
    if (exceededDispatchModeLimit(command, policy) !== undefined) return null;

    let sourceMode: DispatchModes;
    let sourceIdentity: readonly unknown[];
    if (request.source.threadId.startsWith("mausbot:")) {
      if (Option.isNone(external) || (yield* projection.getThreadShell(ThreadId.make(request.source.threadId))) !== null)
        return null;
      const source = yield* external.value.source(request.source.threadId);
      if (!source || !sameEndpoint(source.endpoint, request.source) || source.archived || source.blocked ||
          !source.permissionsKnown || source.runtimeMode !== "full-access" || !source.providerKey.trim()) return null;
      sourceMode = { runtimeMode: source.runtimeMode, interactionMode: command.interactionMode };
      sourceIdentity = ["external", source.providerKey];
    } else {
      const source = yield* shellFor(request.source);
      if (!source) return null;
      const sourceProvider = eligibleProvider(providers, current, source);
      if (!sourceProvider) return null;
      if (source.activeRunId !== null) {
        const owner = yield* projection.getThreadRecords(source.id, ["runs"], { runIds: [source.activeRunId] });
        if (owner.runs.length !== 1 || owner.runs[0]?.providerInstanceId !== source.providerInstanceId)
          return null;
      }
      sourceMode = source;
      sourceIdentity = localProviderIdentity(sourceProvider, source.modelSelection);
    }
    const permission = `runtime:${shell.runtimeMode}`;
    if (sourceMode.runtimeMode !== shell.runtimeMode ||
        exceededDispatchModeLimit(sourceMode, command) !== undefined ||
        !request.permissionCeiling.includes(permission) || !request.destinationPermissions.includes(permission) ||
        request.destinationPermissions.some((item) => !request.permissionCeiling.includes(item))) return null;
    return {
      policyFingerprint: strictSteerFingerprint(policy),
      authorityFingerprint: strictSteerFingerprint([
        sourceIdentity, sourceMode.runtimeMode, sourceMode.interactionMode,
        localProviderIdentity(destinationProvider, shell.modelSelection),
        request.permissionCeiling, request.destinationPermissions,
      ]),
    };
  });

  const prepareIdle: V2RouteAdmissionShape["prepareIdle"] =
    Effect.fn("V2RouteAdmission.prepareIdle")(function* (row, command) {
      const draft = { ...row.state, status: "sending" as const, attemptId: command.attemptId };
      yield* validateProof("validate-idle-proof", () => claimIdleRouteSubmission(draft, row.state.fingerprint, command));
      return yield* idleCurrent(row.state, command, "intake");
    }, (effect) => effect.pipe(Effect.orElseSucceed(() => null)));

  const authorizeIdle: V2RouteAdmissionShape["authorizeIdle"] =
    Effect.fn("V2RouteAdmission.authorizeIdle")(function* (command, phase, leaseOwner) {
      const row = yield* store.get(command.requestId);
      const claim = row?.state.idleSubmission;
      if (!row || !claim || !["sending", "admitted", "uncertain"].includes(row.state.status) ||
          claim.commandFingerprint !== strictRouteDescriptorFingerprint(command)) return null;
      const firstLease = Effect.fn("V2RouteAdmission.idleLease")(function* () {
        const effect = idleStartEffect(command, yield* outbox.listByCommandId(command.commandId));
        return effect !== null && effect.status === "running" && effect.attemptCount === 1 &&
          effect.leaseOwner !== null && (leaseOwner === undefined || effect.leaseOwner === leaseOwner)
          ? effect.leaseOwner : null;
      });
      const owner = phase === "intake" ? "intake" : yield* firstLease();
      if (owner === null) return null;
      const current = yield* idleCurrent(row.state, command, phase);
      if (current?.policyFingerprint !== command.policyFingerprint ||
          current.authorityFingerprint !== command.authorityFingerprint) return null;
      const latest = yield* store.get(command.requestId);
      return latest?.state.idleSubmission?.commandFingerprint === claim.commandFingerprint &&
        ["sending", "admitted", "uncertain"].includes(latest.state.status) &&
        (phase === "intake" || (yield* firstLease()) === owner) ? owner : null;
    }, (effect) => effect.pipe(Effect.orElseSucceed(() => null)));

  const readIdleClaim: V2RouteAdmissionShape["readIdleClaim"] =
    Effect.fn("V2RouteAdmission.readIdleClaim")(function* (runId, messageId) {
      const rows = yield* sql<{ request_id: string }>`
        SELECT request_id FROM durable_routes
        WHERE json_extract(state_json, '$.idleSubmission.command.runId') = ${runId}
          OR json_extract(state_json, '$.idleSubmission.command.messageId') = ${messageId}
        LIMIT 2
      `;
      const [match] = rows;
      if (rows.length !== 1 || match === undefined) return null;
      const row = yield* store.get(match.request_id);
      if (!row) return null;
      yield* validateProof("read-idle-proof", () => assertIdleRouteSubmission(row.state));
      const command = row.state.idleSubmission?.command;
      return command?.runId === runId && command.messageId === messageId ? command : null;
    }, (effect) => effect.pipe(Effect.orElseSucceed(() => null)));

  const validateCurrent = Effect.fn("V2RouteAdmission.validateCurrent")(function* (
    state: RouteState,
    delivery: PreparedStrictRouteDelivery,
  ) {
    const { request } = state;
    const { target } = delivery.command;
    const destination = request.destination;
    const env = yield* environment.getEnvironmentId;
    const current = yield* settings.getSettings;
    if (
      destination === null || request.source.environmentId !== env ||
      destination.environmentId !== env || !routePolicyAllows(state, current.chatRoutingMode)
    ) return null;

    if (request.taskId !== undefined && state.resolution === null && request.initiation !== "manual") {
      const owners = yield* sql<{ thread_id: string; project_id: string }>`
        SELECT DISTINCT thread_id, project_id FROM task_owner_bindings
        WHERE task_id = ${request.taskId} AND environment_id = ${env} AND revocation_json IS NULL
          AND (${request.taskId} <> ${PROJECT_BUILD_OWNER_TASK} OR project_id = ${request.source.projectId})
        LIMIT 2
      `;
      if (owners.length !== 1 || owners[0]?.thread_id !== destination.threadId ||
          owners[0]?.project_id !== destination.projectId) return null;
    }

    const destinationShell = yield* shellFor(destination);
    if (destinationShell === null || destinationShell.activeRunId !== target.runId ||
      destinationShell.activeProviderThreadId !== target.providerThreadId ||
      destinationShell.providerInstanceId !== target.providerInstanceId ||
      destinationShell.runtimeMode !== target.runtimeMode ||
      destinationShell.interactionMode !== target.interactionMode ||
      (yield* projection.hasRunInterruptRequest(destinationShell.id, target.runId))) return null;

    const records = yield* projection.getThreadRecords(destinationShell.id,
      ["runs", "runtimeRequests", "providerThreads"], {
        runIds: [target.runId], runtimeRequestStatuses: ["pending"],
        providerThreadIds: [target.providerThreadId],
      });
    const [run] = records.runs;
    const [providerThread] = records.providerThreads;
    if (records.runtimeRequests.length !== 0 || records.runs.length !== 1 || run === undefined ||
      run.status !== "running" || run.activeAttemptId !== target.attemptId ||
      run.providerInstanceId !== target.providerInstanceId ||
      run.providerThreadId !== target.providerThreadId ||
      records.thread.projectId !== destination.projectId ||
      records.thread.archivedAt !== null || records.thread.deletedAt !== null ||
      records.thread.runtimeMode !== target.runtimeMode ||
      records.thread.interactionMode !== target.interactionMode) return null;
    const providers = yield* registry.getProviders;
    const destinationProvider = eligibleProvider(providers, current, destinationShell);
    if (!destinationProvider || records.providerThreads.length !== 1 ||
      providerThread?.id !== target.providerThreadId ||
      providerThread.appThreadId !== destinationShell.id || providerThread.ownerNodeId !== null ||
      providerThread.providerInstanceId !== target.providerInstanceId ||
      providerThread.providerSessionId !== target.providerSessionId ||
      providerThread.driver !== destinationProvider.driver ||
      providerThread.nativeThreadRef?.nativeId !== target.nativeThreadId ||
      providerThread.nativeThreadRef.driver !== providerThread.driver ||
      !modelSelectionsEqual(run.modelSelection, destinationShell.modelSelection)) return null;
    const policy = yield* runtimePolicy.resolve({ thread: records.thread, modelSelection: run.modelSelection });
    if (strictSteerFingerprint(policy) !== target.policyFingerprint) return null;

    let sourceMode: DispatchModes;
    let sourceIdentity: readonly unknown[];
    if (request.source.threadId.startsWith("mausbot:")) {
      if (Option.isNone(external) || (yield* projection.getThreadShell(ThreadId.make(request.source.threadId))) !== null)
        return null;
      const source = yield* external.value.source(request.source.threadId);
      // Preserve the existing verified cross-engine Full Access mapping.
      if (!source || !sameEndpoint(source.endpoint, request.source) || source.archived ||
          source.blocked || !source.permissionsKnown || source.runtimeMode !== "full-access" ||
          !source.providerKey.trim()) return null;
      sourceMode = { runtimeMode: source.runtimeMode, interactionMode: delivery.attempt.ceiling.interactionMode };
      sourceIdentity = ["external", source.providerKey];
    } else {
      const source = yield* shellFor(request.source);
      if (!source) return null;
      const sourceProvider = eligibleProvider(providers, current, source);
      if (!sourceProvider) return null;
      if (source.activeRunId !== null) {
        const owner = yield* projection.getThreadRecords(source.id, ["runs"], { runIds: [source.activeRunId] });
        if (owner.runs.length !== 1 || owner.runs[0]?.providerInstanceId !== source.providerInstanceId)
          return null;
      }
      sourceMode = source;
      sourceIdentity = localProviderIdentity(sourceProvider, source.modelSelection);
    }

    const permission = `runtime:${destinationShell.runtimeMode}`;
    if (sourceMode.runtimeMode !== destinationShell.runtimeMode ||
      !request.permissionCeiling.includes(permission) ||
      !request.destinationPermissions.includes(permission) ||
      request.destinationPermissions.some((item) => !request.permissionCeiling.includes(item)))
      return null;

    const original = delivery.attempt.ceiling;
    const ceiling: DispatchModes = {
      runtimeMode: isRuntimeModeAbove(original.runtimeMode, sourceMode.runtimeMode)
        ? sourceMode.runtimeMode : original.runtimeMode,
      interactionMode: sourceMode.interactionMode === "plan" ? "plan" : original.interactionMode,
    };
    if (exceededDispatchModeLimit(ceiling, destinationShell) !== undefined ||
        exceededDispatchModeLimit(ceiling, policy) !== undefined) return null;
    return {
      ceiling,
      identity: strictSteerFingerprint([
        sourceIdentity, sourceMode.runtimeMode, sourceMode.interactionMode,
        ceiling, localProviderIdentity(destinationProvider, run.modelSelection),
      ]),
    };
  });

  const validate = Effect.fn("V2RouteAdmission.validate")(function* (row: StoredRoute, delivery: PreparedStrictRouteDelivery) {
    const fresh = yield* store.get(row.state.request.requestId);
    if (!fresh || fresh.revision !== row.revision || fresh.state.fingerprint !== row.state.fingerprint ||
      fresh.state.attemptId !== row.state.attemptId) return null;
    yield* validateProof("validate-strict-proof", () => claimStrictRouteSubmission(fresh.state, fresh.state.fingerprint, delivery));
    return (yield* validateCurrent(fresh.state, delivery))?.ceiling ?? null;
  }, (effect) => effect.pipe(Effect.orElseSucceed(() => null)));

  const authorizeNative: NativeAuthorization = Effect.fn("V2RouteAdmission.authorizeNative")(
    function* (input) {
      const candidates = yield* sql<{ request_id: string }>`SELECT request_id FROM durable_routes
        WHERE json_extract(state_json, '$.strictSubmission.delivery.command.messageId') = ${input.messageId}
        LIMIT 2`;
      const [candidate] = candidates;
      if (candidates.length !== 1 || candidate === undefined) return null;
      const row = yield* store.get(candidate.request_id);
      const claim = row?.state.strictSubmission;
      if (row === null || claim === undefined || !["sending", "admitted", "uncertain"].includes(row.state.status))
        return null;
      const { command } = claim.delivery;
      if (command.threadId !== input.threadId || command.messageId !== input.messageId ||
        strictSteerFingerprint(command) !== input.commandFingerprint ||
        strictSteerFingerprint(command.target) !== strictSteerFingerprint(input.target)) return null;

      const effects = yield* outbox.listByCommandId(command.commandId);
      const [effect] = effects;
      if (effects.length !== 1 || effect === undefined || effect.status !== "running" ||
        effect.attemptCount !== 1 || effect.leaseOwner === null || effect.id !== `${STRICT_STEER_EFFECT_PREFIX}${input.commandFingerprint}` ||
        effect.commandId !== command.commandId || effect.threadId !== command.threadId ||
        effect.request.type !== "provider-turn.steer" ||
        effect.request.providerTurnId !== command.target.providerTurnId ||
        effect.request.providerThreadId !== command.target.providerThreadId ||
        effect.request.providerSessionId !== command.target.providerSessionId ||
        effect.request.messageId !== command.messageId || effect.request.modelSelection !== undefined ||
        effect.request.steerFollowUpAfterRunOrdinal !== undefined) return null;
      const currentAuthority = yield* validateCurrent(row.state, claim.delivery);
      if (currentAuthority === null) return null;
      const latest = yield* store.get(candidate.request_id);
      const claimedEffect = yield* outbox.get(effect.id);
      return latest?.revision === row.revision &&
        latest.state.strictSubmission?.descriptorFingerprint === claim.descriptorFingerprint &&
        Option.exists(claimedEffect, (current) => current.status === "running" &&
          current.attemptCount === effect.attemptCount && current.leaseOwner === effect.leaseOwner)
        ? currentAuthority.identity : null;
    },
    (effect) => effect.pipe(Effect.orElseSucceed(() => null)),
  );
  return V2RouteAdmission.of({ validate, authorizeNative, prepareIdle, authorizeIdle, readIdleClaim });
});

export const layerV2RouteAdmission = Layer.effect(V2RouteAdmission, make);

export const layerStrictRouteNativeAuthorization = Layer.effect(
  StrictRouteNativeAuthorization,
  Effect.map(V2RouteAdmission, ({ authorizeNative }) => ({ authorize: authorizeNative })),
);
