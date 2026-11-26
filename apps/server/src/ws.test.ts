import * as SecretResolver from "@j1code/secret-provider-core/server/SecretResolver";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { WebSocket } from "@effect/platform-node/NodeWS";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Bind an isolated WebSocket negotiation fixture.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Windows fixture junctions need the link type.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthAccessReadScope,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthStandardClientScopes,
  AuthTokenExchangeGrantType,
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthSessionId,
  AuthSourceControlWriteScope,
  BotId,
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  EnvironmentId,
  EnvironmentHttpApi,
  EventId,
  GitManagerError,
  VcsProcessSpawnError,
  MessageId,
  ProjectId,
  ProjectListEntriesError,
  ProjectReadFileError,
  ProjectSearchContentsError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  ThreadId,
  TurnItemId,
  UsageLimitSourceId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderSessionId,
  ProviderUploadFeedbackError,
  RunId,
  SourceControlRepositoryError,
  WS_METHODS,
  WsRpcGroup,
  WsServerRefreshProvidersRpc,
  WsSubscribeServerConfigRpc,
  type AuthAccessStreamEvent,
  type ResourceTelemetrySnapshot,
  type ServerLifecycleStreamEvent,
  type EnvironmentTheme as PublishedEnvironmentTheme,
  type UsageLimitSourceSnapshot,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  type OrchestrationProjectShell,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerProvider,
  type ProviderInstallState,
} from "@j1code/contracts";
import { SOCKET_FRAME_PARTS_QUERY_PARAM } from "@j1code/shared/socketFrameParts";
import * as Deferred from "effect/Deferred";
import type { ProviderInstance } from "@j1code/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HostProcess from "@j1code/shared/HostProcess";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { Headers, HttpRouter, HttpServer, HttpServerRequest } from "effect/http";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Context from "effect/Context";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as ProviderInstallationGate from "./provider/ProviderInstallationGate.ts";
import * as Ws from "./ws.ts";
import { RpcClient, RpcGroup, RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import * as Schedule from "effect/Schedule";
import * as RpcTest from "effect/rpc/RpcTest";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { vi } from "vite-plus/test";

import * as AssetSigner from "./assets/AssetSigner.ts";
import * as NativeAppIconResolver from "./assets/NativeAppIconResolver.ts";
import * as ServerHttp from "./http.ts";
import * as BuiltInSourceControlDrivers from "./sourceControl/builtInDrivers.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as AcpRegistryRuntimeCoordinator from "@j1code/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@j1code/provider-acp-registry/server/AcpRegistrySupport";
import * as AgentSessionImporter from "./project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import * as ProviderSessionRuntime from "./persistence/ProviderSessionRuntime.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as AntigravityInstallation from "./provider/AntigravityInstallation.ts";
import * as ProviderInstallation from "./provider/providerInstallation.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import * as NativeChildWorkQuery from "./orchestration-v2/NativeChildWorkQuery.ts";
import * as CommandOutputHub from "./orchestration-v2/CommandOutputHub.ts";
import * as CodexInstallation from "./provider/CodexInstallation.ts";
import * as DeviceService from "./device/DeviceService.ts";
import * as DocumentText from "./provider/DocumentText.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as AuthHttp from "./auth/http.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as ScratchThreadPromotion from "./project/ScratchThreadPromotion.ts";
import * as McpAppRequests from "./mcpApps/McpAppRequests.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as OtlpEndpointCheck from "./observability/OtlpEndpointCheck.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import * as PeerLinkRequests from "./peer/PeerLinkRequests.ts";
import * as PeerLinks from "./peer/PeerLinks.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as ProviderAuthService from "./provider/ProviderAuthService.ts";
import * as ProviderAuthFlow from "@j1code/provider-core/server/providerAuthFlow";
import { CodexUpdateRecovery } from "./provider/CodexUpdateRecovery.ts";
import { BackgroundBrowser } from "./mcp/toolkits/backgroundBrowser/runtime.ts";
import { HiveMindRuntime } from "./hiveMind/runtime.ts";
import { HiveMindService } from "./hiveMind/HiveMindService.ts";
import { readHiveConfig } from "./hiveMind/config.ts";
import { readHiveMind } from "./hiveMind/store.ts";
import { ServerActivation } from "./serverActivation.ts";
import { MausbotService } from "./mausbot/Service.ts";
import { V2RoutingOwner } from "./routing/engineDrain.ts";
import { makeRoutineRuns } from "./bots/routineRuns.ts";
import { RpcInstrumentation, rpcInstrumentationLayer } from "./observability/RpcInstrumentation.ts";
import * as ReplayHarness from "./orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProviderAdapterRegistry from "./orchestration-v2/ProviderAdapterRegistry.ts";
import * as AcpRegistrySessions from "./provider/AcpRegistrySessions.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as ProviderLatestVersions from "@j1code/provider-core/server/ProviderLatestVersions";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as RelayClient from "@j1code/shared/relayClient";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as DesktopTelemetryReceiver from "./resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as NativeTelemetryClient from "./resourceTelemetry/NativeTelemetryClient.ts";
import * as ResourceAttribution from "./resourceTelemetry/ResourceAttribution.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "./secrets/SecretRequests.ts";
import * as GuestShareService from "./guest/GuestShareService.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as NpmRelease from "./cloud/npmRelease.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as SourceControlSignIn from "./sourceControl/SourceControlSignIn.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as DatabaseStorage from "./persistence/DatabaseStorage.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as KnownWorkspaces from "./workspace/KnownWorkspaces.ts";
import { WorkspaceSearchIndexSearchFailed } from "./workspace/WorkspaceSearchIndex.ts";
import { symlinksSupported } from "@j1code/shared/testing/symlinks";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as TriageService from "./triage/TriageService.ts";
import * as TextGenerators from "./textGeneration/TextGenerators.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as SecretCheck from "./secrets/SecretCheck.ts";
import * as ServerConfigModule from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import { USAGE_LIMITS_COMMAND } from "@j1code/shared/usageLimits";
import * as ServerSettings from "./serverSettings.ts";
import * as ManagedPolicy from "./policy/ManagedPolicy.ts";

import * as EventStore from "./orchestration-v2/EventStore.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as EventSink from "./orchestration-v2/EventSink.ts";
import * as LegacyV1ThreadImporter from "./orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import { DispatchModeLimit } from "./orchestration-v2/DispatchModeLimit.ts";
import * as ThreadCommandExecutor from "./orchestration-v2/ThreadCommandExecutor.ts";
import * as IdAllocator from "@j1code/provider-core/server/IdAllocator";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2SessionRuntime,
} from "@j1code/provider-core/server/ProviderAdapter";
import { projectIdentitiesDigest } from "./orchestration-v2/ShellStream.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ProjectEnrichment from "./project/ProjectEnrichmentService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import {
  enqueueWsCommand,
  layerWsRpc,
  resolveOpenDiscoveryForConfig,
  subscribeOrchestrationV2Shell,
  subscribeOrchestrationV2Thread,
  WS_RPC_SERVER_OPTIONS,
  withLateConfigDiscovery,
} from "./ws.ts";

it.effect("keeps the signed WebSocket mode limit inside a pending startup command", () =>
  Effect.gen(function* () {
    const gate = yield* ServerRuntimeStartup.makeCommandGate;
    const readLimit = DispatchModeLimit;
    const restricted = yield* enqueueWsCommand(
      gate,
      { runtimeModeCeiling: "approval-required" },
      readLimit,
    ).pipe(Effect.forkScoped({ startImmediately: true }));
    const unrestricted = yield* enqueueWsCommand(gate, {}, readLimit).pipe(
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* gate.signalCommandReady;
    assert.deepEqual(yield* Fiber.join(restricted), {
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
    assert.isUndefined(yield* Fiber.join(unrestricted));
  }),
);

const snapshotConfig = (fields: Partial<ServerConfig>) =>
  ({ availableEditors: [], settings: {}, ...fields }) as unknown as ServerConfig;

const settingsUpdated = (settings: object): ServerConfigStreamEvent => ({
  version: 1,
  type: "settingsUpdated",
  payload: { settings: settings as ServerConfig["settings"] },
});

it.effect("resends late editors without rolling back updates already sent", () =>
  Effect.gen(function* () {
    const settingsSent = yield* Deferred.make<void>();
    const events = yield* withLateConfigDiscovery(
      snapshotConfig({ settings: { enableProviderUpdateChecks: true } as never }),
      Stream.make(settingsUpdated({ enableProviderUpdateChecks: false })),
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: () =>
          Deferred.await(settingsSent).pipe(Effect.as("file-explorer" as const)),
      },
      { resolveTargets: () => Effect.succeed([]) },
      { resolve: () => Effect.succeed([]) },
    ).pipe(
      Stream.tap((event) =>
        event.type === "settingsUpdated" ? Deferred.succeed(settingsSent, undefined) : Effect.void,
      ),
      Stream.runCollect,
    );

    const [first, second] = Array.from(events);
    assert.equal(events.length, 2);
    assert.equal(first?.type, "settingsUpdated");
    assert.equal(second?.type, "snapshot");
    if (second?.type === "snapshot") {
      assert.deepEqual(second.config.availableEditors, ["file-manager"]);
      assert.equal(second.config.shellRevealInFileManagerKind, "file-explorer");
      assert.deepEqual(second.config.settings, { enableProviderUpdateChecks: false } as never);
    }
  }),
);

it.effect("resends a reveal kind and remote targets that outlast the snapshot timeout", () =>
  Effect.gen(function* () {
    const targets = [{ kind: "mdns" as const, host: "test.local" }];
    const finishDiscovery = yield* Deferred.make<typeof targets>();
    const collecting = yield* withLateConfigDiscovery(
      snapshotConfig({ availableEditors: ["file-manager"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: () => Effect.succeed("file-explorer"),
      },
      { resolveTargets: () => Deferred.await(finishDiscovery) },
      { resolve: () => Effect.succeed([]) },
    ).pipe(Stream.runCollect, Effect.forkScoped({ startImmediately: true }));
    yield* TestClock.adjust("6 seconds");
    yield* Deferred.succeed(finishDiscovery, targets);
    const events = yield* Fiber.join(collecting);

    const [late, remote] = Array.from(events);
    assert.equal(events.length, 2);
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.shellRevealInFileManagerKind, "file-explorer");
    }
    assert.equal(remote?.type, "snapshot");
    if (remote?.type === "snapshot") {
      assert.deepEqual(remote.config.remoteOpenTargets, targets);
      assert.equal(remote.config.shellRevealInFileManagerKind, "file-explorer");
    }
  }),
);

it.effect("runs editor, remote open target and direct endpoint discovery side by side", () =>
  Effect.gen(function* () {
    // Each discovery finishes only once the other two have started, so a
    // config that ran them one after another would never resolve.
    const editorsStarted = yield* Deferred.make<void>();
    const targetsStarted = yield* Deferred.make<void>();
    const endpointsStarted = yield* Deferred.make<void>();
    const startThenAwait = <A>(started: Deferred.Deferred<void>, value: A) =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(
          Effect.forEach([editorsStarted, targetsStarted, endpointsStarted], Deferred.await),
        ),
        Effect.as(value),
      );

    const discovery = yield* resolveOpenDiscoveryForConfig({
      editors: startThenAwait(editorsStarted, ["file-manager" as const]),
      fileManagerRevealKind: Effect.succeed("finder" as const),
      remoteOpenTargets: startThenAwait(targetsStarted, []),
      directEndpoints: startThenAwait(endpointsStarted, []),
    });

    assert.deepEqual(discovery, {
      availableEditors: ["file-manager"],
      shellRevealInFileManager: true,
      shellRevealInFileManagerKind: "finder",
      remoteOpenTargets: [],
      directEndpoints: [],
    });
  }),
);

const ReplayTestLayer = OrchestrationEventStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const resumeSkipsUnknownTypes = (scope: "thread" | "shell") =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore.OrchestrationEventStore;
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-01-05T00:00:00.000Z";
    const threadId = ThreadId.make("thread:replay");
    const projectId = ProjectId.make("project:replay");
    const project = {
      id: projectId,
      title: "Replay",
      workspaceRoot: "/tmp/replay",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    } satisfies OrchestrationProjectShell;
    const insert = (version: number, unknown = false) => sql<{ sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`replay:${version}`}, ${scope === "thread" ? "thread" : "project"},
          ${scope === "thread" ? threadId : projectId}, ${version},
          ${unknown ? "future.event" : scope === "thread" ? "provider-session.detached" : "project.meta-updated"},
          ${now}, 'server', ${JSON.stringify(
            scope === "thread"
              ? { providerSessionId: "session:replay", detachedAt: now }
              : { projectId, updatedAt: now },
          )}, '{}', 2
        ) RETURNING sequence
      `;
    const [before] = yield* insert(0);
    yield* insert(1, true);
    const [after] = yield* insert(2);
    const [highWater] = yield* insert(3, true);
    const updates = yield* PubSub.unbounded();
    let liveSequence = 0;
    const consume = <A extends { readonly kind: string; readonly sequence?: number }, E, R>(
      stream: Stream.Stream<A, E, R>,
    ) =>
      stream.pipe(
        Stream.tap((item) =>
          Effect.gen(function* () {
            if (item.kind !== "synchronized") return;
            const [live] = yield* insert(4);
            liveSequence = live!.sequence;
            const events = yield* store
              .readApplicationEvents({
                afterSequence: highWater!.sequence,
                throughSequence: liveSequence,
              })
              .pipe(Stream.runCollect);
            yield* store.publishCommitted(events);
          }),
        ),
        Stream.takeUntil((item) => item.sequence === liveSequence),
        Stream.map((item) => ({ kind: item.kind as string, sequence: item.sequence })),
        Stream.runCollect,
      );
    const subscription = Effect.gen(function* () {
      return scope === "thread"
        ? yield* subscribeOrchestrationV2Thread({
            threadId,
            afterSequence: before!.sequence,
            requestCompletionMarker: true,
          }).pipe(Effect.flatMap(consume))
        : yield* subscribeOrchestrationV2Shell({
            afterSequence: before!.sequence,
            requestCompletionMarker: true,
          }).pipe(Effect.flatMap(consume));
    });
    const items = yield* subscription.pipe(
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        ensureLegacyTranscript: () => Effect.void,
        getShellSnapshot: () => Effect.die("shell resume must not load a full snapshot"),
        listActiveSubagentThreadIds: () => Effect.succeed([]),
        streamStoredEventsFrom: (
          input: Parameters<
            ThreadManagement.ThreadManagementService["Service"]["streamStoredEventsFrom"]
          >[0],
        ) => {
          assert.equal(input?.afterSequence, highWater!.sequence);
          return store
            .streamApplicationEvents({ afterSequence: input?.afterSequence ?? 0 })
            .pipe(Stream.filter((event): event is OrchestrationV2StoredEvent => "event" in event));
        },
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Effect.provideService(ProjectStore.ProjectStoreV2, {
        listShells: () => Effect.succeed([]),
      } as unknown as ProjectStore.ProjectStoreV2["Service"]),
      Effect.provideService(ProjectService.ProjectService, {
        getShell: () => Effect.succeedSome(project),
      } as unknown as ProjectService.ProjectService["Service"]),
      Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
        subscribeChanges: PubSub.subscribe(updates),
      } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
    );
    assert.deepEqual(
      items.map((item) => item.kind),
      scope === "thread"
        ? ["event", "synchronized", "event"]
        : ["project.updated", "synchronized", "project.updated"],
    );
    assert.deepEqual(
      items.flatMap((item) => (item.sequence === undefined ? [] : [item.sequence])),
      [after!.sequence, liveSequence],
    );
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer));

it.effect("thread resume skips unknown types, synchronizes, and receives the live tail", () =>
  resumeSkipsUnknownTypes("thread"),
);

// Shell updates batch through `Stream.groupedWithin`, whose window needs real time to close.
it.live("shell resume skips unknown types, synchronizes, and receives the live tail", () =>
  resumeSkipsUnknownTypes("shell"),
);

it.effect("rejects a zero replay cursor for a thread with no snapshot", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:missing-replay");
    const missing = new Orchestrator.OrchestratorProjectionError({
      threadId,
      cause: new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }),
    });
    const result = yield* subscribeOrchestrationV2Thread({
      threadId, afterSequence: 0, requestCompletionMarker: true,
    }).pipe(
      Effect.provide(Layer.mock(ThreadManagement.ThreadManagementService)({
        ensureLegacyTranscript: () => Effect.void,
        getThreadSnapshot: () => Effect.fail(missing),
      })),
      Effect.flip,
    );
    assert.equal(result._tag, "OrchestrationV2GetThreadProjectionError");
    assert.equal(result.threadId, threadId);
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("coalesces sparse thread replay before synchronization and the live tail", () =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore.OrchestrationEventStore;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:streaming-replay");
    const now = "2026-10-27T00:00:00.000Z";
    const insert = (version: number, text: string, streaming: boolean) => sql<{
      sequence: number;
    }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`streaming-replay:${version}`}, 'thread', ${threadId}, ${version}, 'message.updated',
        ${now}, 'server', ${JSON.stringify({
          createdBy: "agent",
          creationSource: "web",
          id: "message:streaming-replay",
          threadId,
          runId: null,
          nodeId: null,
          role: "assistant",
          text,
          attachments: [],
          streaming,
          createdAt: now,
          updatedAt: now,
        })}, '{}', 2
      ) RETURNING sequence
    `;
    yield* insert(0, "H", true);
    // Unrelated writes advance the global sequence past the thread replay limit.
    yield* sql`
      WITH RECURSIVE gap(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM gap WHERE n < 129
      )
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      )
      SELECT 'streaming-replay:other:' || n, 'thread', 'other-thread', n, 'message.updated',
        ${now}, 'server', '{}', '{}', 2 FROM gap
    `;
    yield* insert(1, "He", true);
    const [latest] = yield* insert(2, "Hello", true);
    const [completed] = yield* insert(3, "Hello!", false);
    const items = yield* subscribeOrchestrationV2Thread({
      threadId,
      afterSequence: 0,
      requestCompletionMarker: true,
    }).pipe(
      Effect.flatMap(Stream.runCollect),
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        ensureLegacyTranscript: () => Effect.void,
        streamStoredEventsFrom: (
          input: Parameters<
            ThreadManagement.ThreadManagementService["Service"]["streamStoredEventsFrom"]
          >[0],
        ) => {
          assert.equal(input?.afterSequence, completed!.sequence);
          return store.readAgentEvents({ threadId, afterSequence: completed!.sequence });
        },
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Effect.provideService(OrchestrationEventStore.OrchestrationEventStore, {
        ...store,
        readAgentEvents: (input) => {
          assert.equal(input?.throughSequence, completed!.sequence);
          // Commit after the head and replay budget are captured, but before the replay query.
          return Stream.unwrap(
            insert(4, "Next", false).pipe(Effect.map(() => store.readAgentEvents(input))),
          );
        },
      }),
    );
    assert.deepEqual(
      items.map((item) =>
        item.kind === "event"
          ? [item.sequence, item.event.type === "message.updated" ? item.event.payload.text : null]
          : [item.kind],
      ),
      [
        [latest!.sequence, "Hello"],
        [completed!.sequence, "Hello!"],
        ["synchronized"],
        [completed!.sequence + 1, "Next"],
      ],
    );
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("shell groups read distinct threads once and keep each event's own sequence", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-10-27T00:00:00.000Z";
    const insert = (aggregateKind: "thread" | "project", streamId: string, version: number) =>
      sql<{ sequence: number }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`shell-group:${streamId}:${version}`}, ${aggregateKind}, ${streamId}, ${version},
        ${aggregateKind === "thread" ? "provider-session.detached" : "project.meta-updated"},
        ${now}, 'server', ${JSON.stringify(
          aggregateKind === "thread"
            ? { providerSessionId: "session:shell-group", detachedAt: now }
            : { projectId: streamId, updatedAt: now },
        )}, '{}', 2
      ) RETURNING sequence
    `.pipe(Effect.map(([row]) => row!.sequence));
    const shell = (id: string, archivedAt: string | null = null) =>
      ({ id: ThreadId.make(id), archivedAt }) as unknown as OrchestrationV2ThreadShell;
    const project = {
      id: ProjectId.make("project:group"),
    } as unknown as OrchestrationProjectShell;

    const after = yield* insert("project", "project:before", 0);
    yield* Effect.forEach(
      Array.from({ length: 48 }, (_, version) => version),
      (version) => insert("thread", "thread:active", version),
      { discard: true },
    );
    const archived = yield* insert("thread", "thread:archived", 0);
    const projectUpdated = yield* insert("project", project.id, 0);
    const active = yield* insert("thread", "thread:active", 48);
    yield* insert("thread", "thread:missing", 0);
    const missing = yield* insert("thread", "thread:missing", 1);
    const removedProject = ProjectId.make("project:gone");
    yield* insert("project", removedProject, 0);
    const projectRemoved = yield* insert("project", removedProject, 1);

    const shellReads: Array<ReadonlyArray<string> | undefined> = [];
    let batchFails = false;
    let activeReadFailures = 0;
    const collect = (afterSequence: number) =>
      subscribeOrchestrationV2Shell({ afterSequence, requestCompletionMarker: true }).pipe(
        Effect.flatMap((stream) =>
          stream.pipe(
            Stream.takeUntil((item) => item.kind === "synchronized"),
            Stream.runCollect,
          ),
        ),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          listActiveSubagentThreadIds: () => Effect.succeed([]),
          getShellSnapshot: (options?: { readonly threadIds?: ReadonlyArray<string> }) =>
            Effect.suspend(() => {
              shellReads.push(options?.threadIds);
              return batchFails
                ? Effect.fail("batch failed")
                : Effect.succeed({
                    schemaVersion: 1,
                    snapshotSequence: Number.MAX_SAFE_INTEGER,
                    threads: [shell("thread:active")],
                    archivedThreads: [shell("thread:archived", now)],
                  });
            }),
          getThreadShell: (threadId: string) =>
            Effect.suspend(() => {
              shellReads.push([`scalar:${threadId}`]);
              if (threadId === "thread:active" && activeReadFailures > 0) {
                activeReadFailures -= 1;
                return Effect.fail("scalar failed");
              }
              return Effect.succeed(
                threadId === "thread:missing"
                  ? null
                  : shell(threadId, threadId === "thread:archived" ? now : null),
              );
            }),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(ProjectService.ProjectService, {
          getShell: (id: ProjectId) =>
            id === removedProject ? Effect.succeedNone : Effect.succeedSome(project),
        } as unknown as ProjectService.ProjectService["Service"]),
        Effect.provideServiceEffect(
          ProjectEnrichment.ProjectEnrichmentService,
          PubSub.unbounded().pipe(
            Effect.map(
              (changes) =>
                ({
                  subscribeChanges: PubSub.subscribe(changes),
                }) as unknown as ProjectEnrichment.ProjectEnrichmentService["Service"],
            ),
          ),
        ),
      );

    const collectSummary = (afterSequence: number) =>
      collect(afterSequence).pipe(
        Effect.map((items) =>
          items.flatMap((item): ReadonlyArray<ReadonlyArray<string | number>> =>
            item.kind === "thread.updated"
              ? [[item.kind, item.sequence, item.thread.id]]
              : item.kind === "thread.removed"
                ? [[item.kind, item.sequence, item.threadId]]
                : item.kind === "project.updated"
                  ? [[item.kind, item.sequence, item.project.id]]
                  : item.kind === "project.removed"
                    ? [[item.kind, item.sequence, item.projectId]]
                    : item.kind === "synchronized"
                      ? [[item.kind]]
                      : [],
          ),
        ),
      );
    const expectedGroup = [
      ["thread.removed", archived, "thread:archived"],
      ["project.updated", projectUpdated, project.id],
      ["thread.updated", active, "thread:active"],
      ["thread.removed", missing, "thread:missing"],
      ["project.removed", projectRemoved, removedProject],
      ["synchronized"],
    ];

    assert.deepEqual(yield* collectSummary(after), expectedGroup);
    assert.deepEqual(shellReads, [["thread:archived", "thread:active", "thread:missing"]]);

    shellReads.length = 0;
    assert.deepEqual(yield* collectSummary(active), [
      ["thread.removed", missing, "thread:missing"],
      ["project.removed", projectRemoved, removedProject],
      ["synchronized"],
    ]);
    assert.deepEqual(shellReads, [["scalar:thread:missing"]]);

    shellReads.length = 0;
    batchFails = true;
    activeReadFailures = 1;
    assert.deepEqual(yield* collectSummary(after), expectedGroup);
    assert.deepEqual(shellReads[0], ["thread:archived", "thread:active", "thread:missing"]);
    assert.deepEqual(shellReads.slice(1).flat().sort(), [
      "scalar:thread:active",
      "scalar:thread:active",
      "scalar:thread:archived",
      "scalar:thread:missing",
    ]);

    activeReadFailures = 3;
    const failure = yield* collect(after).pipe(Effect.flip);
    assert.equal(failure._tag, "OrchestrationV2GetShellSnapshotError");
    assert.equal(activeReadFailures, 1);
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("shares each live event item across subscribers and dedupes bodies per subscriber", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:shared-live");
    const messageId = MessageId.make("message:shared-live");
    const at = DateTime.makeUnsafe("2026-10-31T00:00:00.000Z");
    const sql = yield* SqlClient.SqlClient;
    const [cursor] = yield* sql<{ sequence: number }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        'event:shared-live:cursor', 'thread', ${threadId}, 0, 'provider-session.detached',
        '2026-10-31T00:00:00.000Z', 'server',
        '{"providerSessionId":"session:shared-live","detachedAt":"2026-10-31T00:00:00.000Z"}',
        '{}', 2
      ) RETURNING sequence
    `;
    const afterSequence = cursor!.sequence;
    const owner = { threadId, runId: null, nodeId: null, createdAt: at, updatedAt: at };
    // DateTime memoizes its formatted parts, so only the plain records are frozen.
    const freeze = <A>(value: A): A => {
      if (typeof value === "object" && value !== null && !DateTime.isDateTime(value)) {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
      return value;
    };
    const live: ReadonlyArray<OrchestrationV2StoredEvent> = freeze([
      {
        sequence: afterSequence + 1,
        commandId: null,
        event: {
          id: EventId.make("event:shared-live:message"),
          type: "message.updated",
          threadId,
          occurredAt: at,
          payload: {
            ...owner,
            id: messageId,
            role: "assistant",
            text: "Done",
            attachments: [],
            streaming: false,
            createdBy: "agent",
            creationSource: "provider",
          },
        },
      },
      {
        sequence: afterSequence + 2,
        commandId: null,
        event: {
          id: EventId.make("event:shared-live:reply"),
          type: "turn-item.updated",
          threadId,
          occurredAt: at,
          payload: {
            ...owner,
            id: TurnItemId.make("item:shared-live:reply"),
            type: "assistant_message",
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            title: null,
            status: "completed",
            messageId,
            text: "Done",
            streaming: false,
            startedAt: at,
            completedAt: at,
          },
        },
      },
    ] as ReadonlyArray<OrchestrationV2StoredEvent>);
    const stringify = yield* Effect.acquireRelease(
      Effect.sync(() => vi.spyOn(JSON, "stringify")),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    // The EventSink hands every subscriber the same projected objects.
    const subscribe = (acceptDedupedBodies: boolean) =>
      subscribeOrchestrationV2Thread({ threadId, afterSequence, acceptDedupedBodies }).pipe(
        Effect.flatMap(Stream.runCollect),
        Effect.map((items) => Array.from(items)),
        Effect.provide(Layer.mock(ThreadManagement.ThreadManagementService)({
          ensureLegacyTranscript: () => Effect.void,
          streamStoredEventsFrom: () => Stream.fromIterable(live),
        })),
      );
    const [deduped, first, second] = yield* Effect.forEach([true, false, false], subscribe);

    assert.lengthOf(first!, live.length);
    first!.forEach((item, index) => {
      assert.strictEqual(item, second![index]);
      assert.strictEqual(item.kind === "event" && item.event, live[index]!.event);
    });
    assert.strictEqual(deduped![0], first![0]);
    const reply = deduped![1];
    assert.deepInclude(reply?.kind === "event" ? reply.event.payload : undefined, {
      text: "",
      textOmitted: true,
    });
    // The live buffer sizes each shared item once, not once per subscriber.
    assert.lengthOf(
      stringify.mock.calls.filter(([value]) => value?.kind === "event"),
      live.length,
    );
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("shell snapshots omit idle children and older settled threads only on request", () =>
  Effect.gen(function* () {
    const shell = (
      id: string,
      parent: string | null,
      activityRunStatus: "running" | null,
      settledDaysAgo: number | null = null,
    ) =>
      ({
        id: ThreadId.make(id),
        projectId: "project",
        archivedAt: null,
        status: activityRunStatus ?? "completed",
        activityRunStatus,
        pendingRuntimeRequest: null,
        pendingBackgroundTasks: [],
        settledOverride: settledDaysAgo === null ? null : "settled",
        settledAt:
          settledDaysAgo === null ? null : DateTime.makeUnsafe(-settledDaysAgo * 86_400_000),
        lineage: {
          parentThreadId: parent === null ? null : ThreadId.make(parent),
          relationshipToParent: parent === null ? null : "subagent",
          rootThreadId: ThreadId.make(parent ?? id),
        },
      }) as unknown as OrchestrationV2ThreadShell;
    const threads = [
      shell("parent", null, null),
      shell("idle", "parent", null),
      shell("live", "parent", "running"),
      ...Array.from({ length: 25 }, (_, index) => shell(`recent-${index}`, null, null, 1)),
      shell("old", null, null, 30),
      shell("remote-parent", null, null, 40),
      shell("remote-child-parent", "parent", null),
    ];
    const firstSnapshot = (
      input: { readonly omitIdleSubagents?: boolean; readonly omitOlderSettled?: boolean },
      projectionError?: string,
    ) =>
      subscribeOrchestrationV2Shell(input).pipe(
        Effect.flatMap((stream) => stream.pipe(Stream.take(1), Stream.runCollect)),
        Effect.map(([item]) => (item?.kind === "snapshot" ? item.snapshot : null)),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          listActiveShellIndex: () =>
            Effect.succeed(
              threads.map((thread) => ({
                ...thread,
                pinnedAt: null,
                snoozedUntil: null,
                mayBeLive: thread.activityRunStatus !== null,
                hasRemoteTasks: thread.id.startsWith("remote-"),
              })),
            ),
          readShellSnapshot: (options?: { readonly threadIds?: ReadonlyArray<string> }) =>
            Effect.succeed(
              projectionError === undefined
                ? Effect.succeed({
                    schemaVersion: 1,
                    snapshotSequence: 0,
                    threads: threads.filter(
                      (thread) => options?.threadIds?.includes(thread.id) ?? true,
                    ),
                    archivedThreads: [],
                  })
                : Effect.fail(projectionError),
            ),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(ProjectService.ProjectService, {
          getShell: () => Effect.succeedNone,
        } as unknown as ProjectService.ProjectService["Service"]),
        Effect.provideServiceEffect(
          ProjectEnrichment.ProjectEnrichmentService,
          PubSub.unbounded().pipe(
            Effect.map(
              (changes) =>
                ({
                  subscribeChanges: PubSub.subscribe(changes),
                }) as unknown as ProjectEnrichment.ProjectEnrichmentService["Service"],
            ),
          ),
        ),
      );

    const snapshotFailure = yield* firstSnapshot({}, "Fixture shell projection read failed").pipe(
      Effect.flip,
    );
    assert.equal(snapshotFailure._tag, "OrchestrationV2GetShellSnapshotError");
    assert.equal(snapshotFailure.message, "Failed to prepare the application shell stream");
    assert.equal(snapshotFailure.cause, "Fixture shell projection read failed");

    const recent = threads.slice(3, 28).map((thread) => thread.id);
    const full = yield* firstSnapshot({});
    assert.deepEqual(
      full?.threads.map((thread) => thread.id),
      threads.map((thread) => thread.id),
    );
    assert.isUndefined(full?.olderSettled);
    const withoutChildren = yield* firstSnapshot({ omitIdleSubagents: true });
    assert.deepEqual(
      withoutChildren?.threads.map((thread) => thread.id),
      ["parent", "live", ...recent, "old", "remote-parent", "remote-child-parent"],
    );
    // A linked environment's clients nest its task under its parent, so that parent stays: an
    // older settled thread or an idle subagent.
    const withoutOld = yield* firstSnapshot({ omitIdleSubagents: true, omitOlderSettled: true });
    assert.deepEqual(
      withoutOld?.threads.map((thread) => thread.id),
      ["parent", "live", ...recent, "remote-parent", "remote-child-parent"],
    );
    assert.deepEqual(withoutOld?.olderSettled?.counts, [
      { projectId: ProjectId.make("project"), count: 2 },
    ]);
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("checkpoint diff lookup distinguishes missing threads from projection read failures", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("checkpoint-diff-error");
    const storageError = new Orchestrator.OrchestratorProjectionError({
      threadId,
      cause: new Error("Fixture projection read failed"),
    });
    const missingThread = new Orchestrator.OrchestratorProjectionError({
      threadId,
      cause: new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }),
    });
    for (const [projectionError, expectedTag] of [
      [storageError, "OrchestratorProjectionError"],
      [missingThread, "CheckpointThreadNotFoundError"],
    ] as const) {
      const run = Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        const turn = yield* query.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 }).pipe(Effect.flip);
        const full = yield* query.getFullThreadDiff({ threadId, toTurnCount: 1 }).pipe(Effect.flip);
        assert.equal(turn._tag, expectedTag);
        assert.equal(full._tag, expectedTag);
        if (expectedTag === "OrchestratorProjectionError") {
          assert.strictEqual(turn, storageError);
          assert.strictEqual(full, storageError);
        }
        assert.deepEqual(yield* query.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 0 }), {
          threadId, fromTurnCount: 0, toTurnCount: 0, diff: "",
        });
      });
      yield* run.pipe(Effect.provide(
        CheckpointDiffQuery.layer.pipe(Layer.provide(Layer.mergeAll(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getCheckpointContext: () => Effect.fail(projectionError),
          }),
          Layer.mock(CheckpointStore.CheckpointStore)({}),
          NodeCrypto.layer,
        ))),
      ));
    }
  }),
);

// Build the production RPC layer; unrelated capabilities fail if this test calls them.
const encodeProjectReadFileError = Schema.encodeEffect(ProjectReadFileError);
const encodeProjectSearchEntriesError = Schema.encodeEffect(ProjectSearchEntriesError);
const decodeProjectListEntriesError = Schema.decodeEffect(ProjectListEntriesError);
const encodeProjectListEntriesError = Schema.encodeEffect(ProjectListEntriesError);
const encodeProjectWriteFileError = Schema.encodeEffect(ProjectWriteFileError);
const encodeProjectSearchContentsError = Schema.encodeEffect(ProjectSearchContentsError);

class WsFixtureFailure extends Schema.TaggedError<WsFixtureFailure>()("WsFixtureFailure", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const layerUnusedHiveMind = Layer.effect(
  HiveMindService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "j1-unused-hive-" });
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => new HiveMindRuntime(path.join(directory, "hive-mind.json"))),
      (value) => Effect.promise(() => value.close()),
    );
    return { runtime, search: () => Effect.die("Unexpected Hive search in this fixture") };
  }).pipe(Effect.orDie),
).pipe(Layer.provide(NodeServices.layer));

const layerUnusedConfigRpcServices = Layer.mergeAll(
  layerUnusedHiveMind,
  Layer.mock(V2RoutingOwner)({}),
  ProjectionStore.layer,
  Layer.mock(BackgroundBrowser)({}),
  Layer.mock(MausbotService)({}),
  Layer.mock(DocumentText.DocumentText)({}),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.mock(SecretCheck.SecretCheck)({}),
  Layer.mock(WorkspacePaths.WorkspacePaths)({}),
  Layer.mock(TraceDiagnostics.TraceDiagnostics)({}),
  Layer.mock(TriageService.TriageService)({}),
  Layer.mock(TextGenerators.TextGenerators)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
  Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
  Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({}),
  Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({}),
  Layer.mock(AcpRegistrySessions.AcpRegistrySessions)({}),
  Layer.mock(AgentSessionImporter.AgentSessionImporter)({}),
  Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
  Layer.mock(AnalyticsService.AnalyticsService)({}),
  Layer.mock(AntigravityInstallation.AntigravityInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
  Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({}),
  Layer.mock(NativeChildWorkQuery.NativeChildWorkQuery)({}),
  Layer.mock(CommandOutputHub.CommandOutputHub)({}),
  Layer.mock(CodexInstallation.CodexInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(CodexUpdateRecovery)({}),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(EnvironmentTheme.EnvironmentThemeService)({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(HostResources.HostResources)({}),
  Layer.mock(McpAppRequests.McpAppRequests)({}),
  Layer.mock(ModelManifest.ModelManifest)({}),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(OtlpEndpointCheck.OtlpEndpointCheck)({}),
  Layer.mock(PairingGrantStore.PairingGrantStore)({}),
  Layer.mock(PeerLinks.PeerLinks)({}),
  Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
  Layer.mock(PortScanner.PortDiscovery)({ trackAgent: () => () => undefined }),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({}),
  Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({}),
  Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(ProviderAuthService.ProviderAuthService)({}),
  Layer.mock(ProviderInstallation.ProviderInstallation)({}),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
  Layer.mock(ProviderLatestVersions.ProviderLatestVersions)({}),
  Layer.mock(ProviderMaintenanceRunner.ProviderMaintenanceRunner)({}),
  Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  Layer.mock(PullRequestService.PullRequestService)({}),
  Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({}),
  Layer.mock(RelayClient.RelayClient)({}),
  Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
  Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
  Layer.mock(ReviewService.ReviewService)({}),
  Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(SecretResolver.SecretResolver)({}),
  Layer.mock(GuestShareService.GuestShareService)({}),
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({}),
  Layer.mock(NpmRelease.NpmRelease)({}),
  Layer.mock(SessionStore.SessionStore)({ cookieName: "config-test", legacyCookieName: undefined }),
  Layer.mock(SourceControlDiscovery.SourceControlDiscovery)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(SourceControlSignIn.SourceControlSignIn)({}),
  Layer.mock(StorageCleanup.StorageCleanup)({}),
  Layer.mock(DatabaseStorage.DatabaseStorage)({}),
  Layer.mock(TerminalManager.TerminalManager)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadManagement.ThreadManagementService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
  Layer.mock(UsageService.UsageService)({}),
  Layer.mock(VcsProvisioningService.VcsProvisioningService)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(WorkspaceEntries.WorkspaceEntries)({}),
  Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({}),
  Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
);

const layerConfigSources = Layer.mergeAll(
  Keybindings.layer,
  AssetSigner.layer.pipe(Layer.provide(ServerSecretStore.layer)),
  ServerSettings.layer.pipe(
    Layer.provide(Layer.merge(ServerSecretStore.layer, ManagedPolicy.layerTest())),
  ),
).pipe(
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(
      ServerConfigModule.layerTest(process.cwd(), { prefix: "t3-config-subscription-test-" }),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.live.each([
  { subject: "desktop-bootstrap", extensions: "", framed: false },
  { subject: "desktop-bootstrap", extensions: "", framed: true },
  { subject: "one-time-token", extensions: "permessage-deflate", framed: false },
  { subject: "cloud-connect", extensions: "permessage-deflate", framed: false },
])(
  "negotiates compression for $subject sessions (framed=$framed)",
  ({ subject, extensions, framed }) =>
    Effect.gen(function* () {
      const connections: Array<Readonly<Record<string, unknown>> | undefined> = [];
      const services = Layer.mergeAll(
        layerUnusedConfigRpcServices,
        Layer.mock(ServerBrowser.ServerBrowser)({
          profileReporter: Effect.succeed(() => Effect.void),
        }),
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          authenticateWebSocketUpgrade: () =>
            Effect.succeed({
              sessionId: AuthSessionId.make("compression-test"),
              subject,
              method: "bearer-access-token",
              scopes: [],
            }),
        }),
        Layer.mock(SessionStore.SessionStore)({
          cookieName: "compression-test",
          legacyCookieName: undefined,
          markConnected: () => Effect.void,
          markDisconnected: () => Effect.void,
          awaitInvalidation: () => Effect.never,
        }),
        Layer.mock(AnalyticsService.AnalyticsService)({
          recordOwners: () => Effect.void,
          record: (event, properties) =>
            Effect.sync(() => {
              if (event === "client.connected") connections.push(properties);
            }),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: process.cwd(),
        }),
        Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(UsageLimitSources.UsageLimitSources)({}),
        Layer.mock(ExternalLauncher.ExternalLauncher)({}),
        Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
        Layer.mock(DirectEndpoints.DirectEndpoints)({}),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("compression-test")),
        }),
        ProjectionStore.layer,
        Layer.mock(V2RoutingOwner)({}),
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.fail(
              new VcsProcessSpawnError({
                operation: input.operation,
                command: input.command,
                cwd: input.cwd,
                cause: "No VCS commands in the compression fixture",
              }),
            ),
        }),
        ProviderInstallationGate.layer,
        FetchHttpClient.layer,
      );
      const context = yield* Layer.build(
        HttpRouter.serve(Ws.layer, { disableListenLog: true }).pipe(
          Layer.provideMerge(
            NodeHttpServer.layer(NodeHttp.createServer, {
              host: "127.0.0.1",
              port: 0,
              websocket: { perMessageDeflate: true },
            }),
          ),
          Layer.provide(services),
          Layer.provide(layerConfigSources),
        ),
      );
      const server = Context.get(context, HttpServer.HttpServer);
      const origin = HttpServer.formatAddress(server.address).replace(/^http/, "ws");
      const socket = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new WebSocket(
              `${origin}/ws?${ORCHESTRATION_PROTOCOL_QUERY_PARAM}=${ORCHESTRATION_PROTOCOL_VERSION}${framed ? `&${SOCKET_FRAME_PARTS_QUERY_PARAM}=1` : ""}&clientSurface=watch&clientOs=Plan9&connectionMethod=teleport`,
              {
                origin: "t3code://app",
              },
            ),
        ),
        (socket) => Effect.sync(() => socket.terminate()),
      );
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            socket.once("open", resolve);
            socket.once("error", reject);
          }),
      );
      assert.equal(socket.extensions, extensions);
      assert.deepEqual(connections, [{}]);
    }).pipe(Effect.scoped),
);

it.live("enforces provider auth scope and private flow ownership over WebSocket", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("socket-auth-personal");
    const foreignId = ProviderInstanceId.make("socket-auth-work");
    const unknownId = ProviderInstanceId.make("socket-auth-unknown");
    const driverKind = ProviderDriverKind.make("antigravity");
    const ownerId = AuthSessionId.make("socket-auth-owner");
    const neighborId = AuthSessionId.make("socket-auth-neighbor");
    const authorizationUrl = "https://example.invalid/login?state=fixture-private";
    const workAuthorizationUrl = "https://example.invalid/login?state=fixture-work";
    const callbackUrl = "http://127.0.0.1:48123/?state=fixture-private&code=fixture-code";
    const method = { id: "browser", name: "Browser", description: null, type: "agent" as const };
    const callbacks: string[] = [];
    const loggedOut: ProviderInstanceId[] = [];
    const responded = yield* Deferred.make<void>();
    const ownerSubscribed = yield* Deferred.make<void>();
    const ownerSubscriptionClosed = yield* Deferred.make<void>();
    const ownerDisconnected = yield* Deferred.make<void>();
    let watchOwner = true;
    let instanceLookups = 0;
    let installStarts = 0;

    const makeInstance = Effect.fnUntraced(function* (id: ProviderInstanceId) {
      const controller = yield* ProviderAuthFlow.make({
        instanceId: id,
        credentialBinding: { owner: "provider", key: id },
        methods: Effect.succeed([method]),
        defaultMethodId: method.id,
        authenticate: (_, context) =>
          context.setInteraction(
            {
              id: "browser-consent",
              type: "browser",
              url: id === instanceId ? authorizationUrl : workAuthorizationUrl,
              requiresConsent: true,
              acceptsCallback: true,
            },
            () => Deferred.succeed(responded, undefined).pipe(Effect.asVoid),
            (url) =>
              Effect.sync(() => { callbacks.push(url); }).pipe(Effect.andThen(context.verifying)),
          ).pipe(Effect.andThen(Effect.never)),
        logout: Effect.sync(() => { loggedOut.push(id); }),
      });
      return {
        instanceId: id,
        driverKind,
        enabled: true,
        displayName: undefined,
        continuationIdentity: { driverKind, continuationKey: id },
        auth: {
          ...controller,
          subscribe: (sessionId) => {
            const stream = controller.subscribe(sessionId);
            if (!watchOwner || id !== instanceId || sessionId !== ownerId) return stream;
            return stream.pipe(
              Stream.tap((state) => state.phase === "waiting"
                ? Deferred.succeed(ownerSubscribed, undefined)
                : Effect.void),
              Stream.ensuring(Deferred.succeed(ownerSubscriptionClosed, undefined)),
            );
          },
        },
        get snapshot(): never { throw new Error("No provider probe in the auth fixture"); },
        get orchestrationAdapter(): never { throw new Error("No provider calls in the auth fixture"); },
        get textGeneration(): never { throw new Error("No text generation in the auth fixture"); },
      } satisfies ProviderInstance;
    });
    const personal = yield* makeInstance(instanceId);
    const work = yield* makeInstance(foreignId);
    const changes = yield* PubSub.unbounded<void>();
    const instanceLayer = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: (id) => Effect.sync(() => {
        instanceLookups++;
        return id === instanceId ? personal : id === foreignId ? work : undefined;
      }),
      listInstances: Effect.succeed([personal, work]),
      subscribeChanges: PubSub.subscribe(changes),
    });
    const database = Layer.fresh(SqlitePersistence.layerMemory);
    const graph = ReplayHarness.layerWithRegistry(
      { name: "provider-auth-websocket" },
      ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(Layer.provide(instanceLayer)),
      { databaseLayer: database, runEffectWorker: false },
    );
    const config = Layer.mergeAll(
      Keybindings.layer,
      AssetSigner.layer.pipe(Layer.provide(ServerSecretStore.layer)),
      OrchestrationEventStore.layer,
    );
    const installState: ProviderInstallState = {
      driver: driverKind, phase: "idle", operationId: null, downloadedBytes: 0,
      totalBytes: null, version: null, installedVersion: null, canRemove: false, message: null,
    };
    const sessionsByToken = new Map<string, EnvironmentAuth.AuthenticatedSession>([
      ["Bearer owner", { sessionId: ownerId, subject: "fixture-owner", method: "bearer-access-token",
        scopes: [AuthOrchestrationReadScope, AuthProvidersManageScope] }],
      ["Bearer neighbor", { sessionId: neighborId, subject: "fixture-neighbor", method: "bearer-access-token",
        scopes: [AuthOrchestrationReadScope, AuthProvidersManageScope] }],
      ["Bearer reader", { sessionId: AuthSessionId.make("socket-auth-reader"), subject: "fixture-reader",
        method: "bearer-access-token", scopes: [AuthOrchestrationReadScope] }],
      ["Bearer operator", { sessionId: AuthSessionId.make("socket-auth-operator"), subject: "fixture-operator",
        method: "bearer-access-token", scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope] }],
    ]);
    const dependencies = Layer.mergeAll(graph, instanceLayer, database, NodeCrypto.layer, NodeServices.layer);
    const services = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(ServerBrowser.ServerBrowser)({ profileReporter: Effect.succeed(() => Effect.void) }),
      Layer.mock(BackgroundBrowser)({}),
      Layer.mock(MausbotService)({}),
      Layer.mock(V2RoutingOwner)({}),
      Layer.mock(CodexUpdateRecovery)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: process.cwd() }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(UsageLimitSources.UsageLimitSources)({}),
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
      Layer.mock(DirectEndpoints.DirectEndpoints)({}),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({ removeRpcClient: () => Effect.void }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("provider-auth-websocket")),
      }),
      Layer.mock(ProviderInstallation.ProviderInstallation)({
        start: () => Effect.sync(() => { installStarts++; return installState; }),
        subscribe: () => Stream.succeed(installState),
      }),
      Layer.mock(AnalyticsService.AnalyticsService)({
        recordOwners: () => Effect.void, record: () => Effect.void,
      }),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        authenticateWebSocketUpgrade: (request) => Effect.suspend(() => {
          const session = sessionsByToken.get(request.headers.authorization ?? "");
          return session
            ? Effect.succeed(session)
            : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}));
        }),
      }),
      Layer.mock(SessionStore.SessionStore)({
        cookieName: "fixture", legacyCookieName: undefined,
        markConnected: () => Effect.void,
        markDisconnected: (id) => id === ownerId
          ? Deferred.succeed(ownerDisconnected, undefined).pipe(Effect.asVoid)
          : Effect.void,
        awaitInvalidation: () => Effect.never,
      }),
      Layer.mock(VcsProcess.VcsProcess)({
        run: (input) => Effect.fail(new VcsProcessSpawnError({
          operation: input.operation,
          command: input.command,
          cwd: input.cwd,
          cause: "Git is unavailable in the provider auth fixture",
        })),
      }),
      ProviderInstallationGate.layer,
      FetchHttpClient.layer,
      config,
      ProviderAuthService.layer,
    ).pipe(Layer.provide(dependencies), Layer.merge(dependencies));
    const context = yield* Layer.build(
      HttpRouter.serve(Ws.layer, { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 })),
        Layer.provide(services),
      ),
    );
    const origin = HttpServer.formatAddress(Context.get(context, HttpServer.HttpServer).address)
      .replace(/^http/, "ws");
    const url = new URL("/ws", origin);
    url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
    const makeClient = Effect.fn("wsFixture.makeClient")(function* (
      token: string,
      onSocket?: (socket: WebSocket) => void,
    ) {
      // The protocol owns the live socket until the surrounding client scope closes.
      const protocol = yield* Layer.build(RpcClient.layerProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }).pipe(
        Layer.provide(Socket.layerWebSocket(url.href, {
          headers: { authorization: `Bearer ${token}` },
        }).pipe(
          Layer.provide(Layer.succeed(Socket.WebSocketConstructor, (address, options) => {
            const socket = typeof options === "string" || Array.isArray(options) || options === undefined
              ? new WebSocket(address, options)
              : new WebSocket(address, options.protocols, { headers: options.headers });
            onSocket?.(socket);
            return socket;
          })),
        )),
        Layer.provide(RpcSerialization.layerJson),
      ));
      return yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(protocol));
    });
    const head = <A, E>(stream: Stream.Stream<A, E>) =>
      stream.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
    const rejectedUpgrade = yield* Effect.tryPromise({
      try: () => new Promise<number | undefined>((resolve, reject) => {
        const socket = new WebSocket(url.href, { handshakeTimeout: 2_000 });
        socket.once("unexpected-response", (_request, response) => {
          response.resume();
          resolve(response.statusCode);
          socket.terminate();
        });
        socket.once("error", reject);
        socket.once("open", () => {
          socket.close();
          reject(new Error("Unauthenticated WebSocket unexpectedly upgraded"));
        });
      }),
      catch: (cause) => new WsFixtureFailure({ message: "Could not verify the unauthenticated upgrade", cause }),
    });
    assert.equal(rejectedUpgrade, 401);
    const target = { instanceId };
    const startupLookups = instanceLookups;
    yield* Effect.scoped(Effect.gen(function* () {
      const reader = yield* makeClient("reader");
      const operator = yield* makeClient("operator");
      assert.deepEqual(yield* head(reader[WS_METHODS.providerInstallSubscribe](target)), installState);
      const denied = yield* reader[WS_METHODS.providerInstallStart](target).pipe(Effect.flip);
      assert.equal(denied._tag, "EnvironmentAuthorizationError");
      if (denied._tag === "EnvironmentAuthorizationError") {
        assert.equal(denied.requiredPermission, AuthProvidersManageScope);
      }
      const errors = yield* Effect.all([
        reader[WS_METHODS.providerAuthStart](target).pipe(Effect.flip),
        reader[WS_METHODS.providerAuthSubscribe](target).pipe(Stream.runHead, Effect.flip),
        operator[WS_METHODS.providerAuthStart](target).pipe(Effect.flip),
      ]);
      for (const error of errors) {
        assert.equal(error._tag, "EnvironmentAuthorizationError");
        if (error._tag === "EnvironmentAuthorizationError") {
          assert.equal(error.requiredPermission, AuthProvidersManageScope);
        }
      }
      assert.equal(installStarts, 0);
      assert.equal(instanceLookups, startupLookups);
    }));

    const flowId = yield* Effect.scoped(Effect.gen(function* () {
      let socket: WebSocket | undefined;
      const owner = yield* makeClient("owner", (connected) => { socket = connected; });
      const neighbor = yield* makeClient("neighbor");
      const forgedStart = { ...target, ownerSessionId: neighborId };
      const started = yield* owner[WS_METHODS.providerAuthStart](forgedStart);
      assert.isNotNull(started.flowId);
      const flowId = started.flowId!;
      const ownerStates = yield* Queue.unbounded<string | null>();
      yield* owner[WS_METHODS.providerAuthSubscribe](target).pipe(
        Stream.filter((state) => state.phase === "waiting"),
        Stream.runForEach((state) => Queue.offer(ownerStates, state.authorizationUrl)),
        Effect.ignore,
        Effect.forkScoped,
      );
      assert.equal(yield* Queue.take(ownerStates), authorizationUrl);
      yield* Deferred.await(ownerSubscribed);

      const claimedOwner = { ...target, flowId, ownerSessionId: ownerId };
      const otherState = yield* head(neighbor[WS_METHODS.providerAuthSubscribe](claimedOwner));
      assert.equal(otherState.phase, "waiting");
      assert.isNull(otherState.flowId);
      assert.isNull(otherState.authorizationUrl);
      assert.isNull(otherState.interaction);
      assert.isNull(otherState.expiresAt);
      const forgedCallback = { ...claimedOwner, callbackUrl };
      const forgedResponse = {
        ...claimedOwner,
        interactionId: "browser-consent",
        response: { type: "browser" as const, action: "accept" as const },
      };
      const errors = yield* Effect.all([
        neighbor[WS_METHODS.providerAuthComplete](forgedCallback).pipe(Effect.flip),
        neighbor[WS_METHODS.providerAuthRespond](forgedResponse).pipe(Effect.flip),
        neighbor[WS_METHODS.providerAuthCancel](claimedOwner).pipe(Effect.flip),
        owner[WS_METHODS.providerAuthComplete]({ instanceId: foreignId, flowId, callbackUrl }).pipe(Effect.flip),
        owner[WS_METHODS.providerAuthStart]({ instanceId: unknownId }).pipe(Effect.flip),
        owner[WS_METHODS.providerAuthSubscribe]({ instanceId: unknownId }).pipe(Stream.runHead, Effect.flip),
      ]);
      for (const error of errors) {
        assert.equal(error._tag, "ProviderSetupError");
        assert.notInclude(JSON.stringify(error), "fixture-code");
      }
      assert.deepEqual(callbacks, []);
      assert.isFalse(yield* Deferred.isDone(responded));

      const independent = yield* neighbor[WS_METHODS.providerAuthStart]({ instanceId: foreignId });
      assert.notEqual(independent.flowId, flowId);
      const workState = yield* head(
        neighbor[WS_METHODS.providerAuthSubscribe]({ instanceId: foreignId }).pipe(
          Stream.filter((state) => state.phase === "waiting"),
        ),
      );
      assert.equal(workState.authorizationUrl, workAuthorizationUrl);
      assert.equal((yield* neighbor[WS_METHODS.providerAuthCancel]({
        instanceId: foreignId, flowId: independent.flowId!,
      })).phase, "cancelled");

      yield* Effect.sync(() => socket!.terminate());
      yield* Deferred.await(ownerSubscriptionClosed);
    yield* Deferred.await(ownerDisconnected);
      watchOwner = false;
      return flowId;
    }));

    yield* Effect.scoped(Effect.gen(function* () {
      const owner = yield* makeClient("owner");
      assert.equal((yield* head(owner[WS_METHODS.providerAuthSubscribe](target))).flowId, flowId);
      yield* owner[WS_METHODS.providerAuthRespond]({
        ...target, flowId, interactionId: "browser-consent", response: { type: "browser", action: "accept" },
      });
      yield* Deferred.await(responded);
      assert.equal((yield* owner[WS_METHODS.providerAuthComplete]({
        ...target, flowId, callbackUrl,
      })).phase, "verifying");
      assert.equal((yield* owner[WS_METHODS.providerAuthCancel]({ ...target, flowId })).phase, "cancelled");
      assert.equal((yield* owner[WS_METHODS.providerAuthLogout](target)).phase, "idle");
    }));
    assert.deepEqual(callbacks, [callbackUrl]);
    assert.deepEqual(loggedOut, [instanceId]);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("records only fresh successful thread creation against the originating socket", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const effects: Array<unknown> = [];
    const services = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(ServerBrowser.ServerBrowser)({}),
      Layer.mock(BackgroundBrowser)({}),
      Layer.mock(MausbotService)({}),
      Layer.mock(V2RoutingOwner)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: process.cwd() }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(UsageLimitSources.UsageLimitSources)({}),
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
      Layer.mock(DirectEndpoints.DirectEndpoints)({}),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("analytics-fixture")),
      }),
      Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
      Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({ enqueueCommand: (effect) => effect }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: (command) => Effect.gen(function* () {
          effects.push(command.commandId);
          if (command.commandId === "failed") {
            return yield* new Orchestrator.OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: new Error("Fixture refusal"),
            });
          }
          return {
            sequence: 1,
            storedEvents: [],
            ...(command.commandId === "replayed" ? { replayed: true as const } : {}),
          };
        }),
      }),
      Layer.mock(AnalyticsService.AnalyticsService)({
        record: (event, props) => Effect.sync(() => { effects.push({ event, props }); }),
      }),
      Layer.succeed(SqlClient.SqlClient, sql),
    );
    const browser = yield* ServerBrowser.ServerBrowser;
    const makeClient = (surface: "web" | "mobile", scopes: EnvironmentAuth.AuthenticatedSession["scopes"]) =>
      RpcTest.makeClient(WsRpcGroup.middleware(RpcInstrumentation)).pipe(
        Effect.provide(layerWsRpc(
          { sessionId: AuthSessionId.make(surface), subject: surface, method: "browser-session-cookie", scopes },
          { surface },
          browser,
          () => Effect.void,
          { secretReferences: true },
        ).pipe(
          Layer.provide(services),
          Layer.merge(RpcAuthorization.layer(scopes)),
          Layer.merge(rpcInstrumentationLayer),
        )),
      );
    const command = (id: string) => ({
      type: "thread.create" as const,
      commandId: CommandId.make(id),
      projectId: ProjectId.make("fixture-project"),
      threadId: ThreadId.make(id),
      title: "Private fixture title",
      createdBy: "user" as const,
      creationSource: "web" as const,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture-model" },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
    });
    const method = ORCHESTRATION_V2_WS_METHODS.dispatchCommand;
    const reader = yield* makeClient("web", [AuthOrchestrationReadScope]);
    const denied = yield* reader[method](command("denied")).pipe(Effect.flip);
    assert.equal(denied._tag, "EnvironmentAuthorizationError");
    assert.deepEqual(effects, []);

    const mobile = yield* makeClient("mobile", [AuthOrchestrationOperateScope]);
    const web = yield* makeClient("web", [AuthOrchestrationOperateScope]);
    yield* mobile[method](command("failed")).pipe(Effect.flip);
    yield* web[method](command("replayed"));
    yield* mobile[method](command("fresh-mobile"));
    yield* web[method](command("fresh-web"));
    assert.deepEqual(effects, [
      "failed",
      "replayed",
      "fresh-mobile",
      { event: "client.thread.started", props: { surface: "mobile" } },
      "fresh-web",
      { event: "client.thread.started", props: { surface: "web" } },
    ]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      layerConfigSources.pipe(Layer.provideMerge(Layer.mock(ServerBrowser.ServerBrowser)({}))),
    ),
  ),
);

it.effect("authorizes editor launches before dispatch and preserves typed launcher errors", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const browser = yield* ServerBrowser.ServerBrowser;
    const opened: ExternalLauncher.LaunchEditorInput[] = [];
    const target = { cwd: "/fixture/project", editor: "cursor" } as const;
    const missing = new ExternalLauncher.ExternalLauncherCommandNotFoundError({
      editor: "cursor",
      command: "cursor",
    });
    const services = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(ServerBrowser.ServerBrowser)({}),
      Layer.mock(BackgroundBrowser)({}),
      Layer.mock(MausbotService)({}),
      Layer.mock(V2RoutingOwner)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: process.cwd() }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(UsageLimitSources.UsageLimitSources)({}),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
      Layer.mock(DirectEndpoints.DirectEndpoints)({}),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("editor-rpc-fixture")),
      }),
      Layer.mock(ExternalLauncher.ExternalLauncher)({
        launchEditor: (input) =>
          Effect.gen(function* () {
            opened.push(input);
            if (input.cwd === "/fixture/missing-editor") return yield* missing;
          }),
      }),
      Layer.succeed(SqlClient.SqlClient, sql),
      ProjectionStore.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql))),
    );
    const makeClient = (id: string, scopes: EnvironmentAuth.AuthenticatedSession["scopes"]) =>
      RpcTest.makeClient(WsRpcGroup.middleware(RpcInstrumentation)).pipe(
        Effect.provide(layerWsRpc(
          { sessionId: AuthSessionId.make(id), subject: id, method: "browser-session-cookie", scopes },
          {},
          browser,
          () => Effect.void,
          { secretReferences: true },
        ).pipe(
          Layer.provide(services),
          Layer.merge(RpcAuthorization.layer(scopes)),
          Layer.merge(rpcInstrumentationLayer),
        )),
      );

    const reader = yield* makeClient("editor-reader", [AuthOrchestrationReadScope]);
    const denied = yield* reader[WS_METHODS.shellOpenInEditor](target).pipe(Effect.flip);
    if (denied._tag !== "EnvironmentAuthorizationError") return yield* Effect.die(denied);
    assert.equal(denied.requiredScope, AuthOrchestrationOperateScope);
    assert.deepEqual(opened, []);

    const operator = yield* makeClient("editor-operator", [AuthOrchestrationOperateScope]);
    yield* operator[WS_METHODS.shellOpenInEditor](target);
    const positioned = { ...target, cwd: "/fixture/project/file.ts", projectRoot: target.cwd, position: { line: 5, column: 2 } };
    yield* operator[WS_METHODS.shellOpenInEditor](positioned);
    const missingTarget = { ...target, cwd: "/fixture/missing-editor" };
    const failed = yield* operator[WS_METHODS.shellOpenInEditor](missingTarget).pipe(Effect.flip);
    if (failed._tag !== "ExternalLauncherCommandNotFoundError") return yield* Effect.die(failed);
    assert.equal(failed.editor, missing.editor);
    assert.equal(failed.command, missing.command);
    assert.equal(failed.message, missing.message);
    assert.deepEqual(opened, [target, positioned, missingTarget]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      layerConfigSources.pipe(Layer.provideMerge(Layer.mock(ServerBrowser.ServerBrowser)({}))),
    ),
  ),
);

const botRpcTags = [
  ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
  WS_METHODS.botRoutineHistory,
  WS_METHODS.botCallTurn,
  WS_METHODS.botBrowserPage,
  WS_METHODS.botBrowserAction,
] as const;
const botRpcs = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES, (typeof botRpcTags)[number]> =>
      !(botRpcTags as ReadonlyArray<string>).includes(tag),
  ),
).middleware(RpcInstrumentation);

it.effect("bot RPCs isolate projections and require authorization before touching the browser", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const settings = yield* ServerSettings.ServerSettingsService;
    const projectId = ProjectId.make("bot-rpc-project");
    const foreignProjectId = ProjectId.make("bot-rpc-other-project");
    const botId = BotId.make("bot-rpc-owner");
    const unknownBotId = BotId.make("bot-rpc-unknown");
    const archivedBotId = BotId.make("bot-rpc-archived");
    const good = ThreadId.make("bot-rpc-thread");
    const foreign = ThreadId.make("bot-rpc-foreign");
    const ordinary = ThreadId.make("bot-rpc-ordinary");
    const missing = ThreadId.make("bot-rpc-missing");
    const deleted = ThreadId.make("bot-rpc-deleted");
    const archived = ThreadId.make("bot-rpc-archived");
    const messageId = MessageId.make("bot-rpc-message");
    const runId = RunId.make("bot-rpc-run");
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "default" };
    const now = DateTime.makeUnsafe("2026-10-15T00:00:00Z");
    const at = DateTime.formatIso(now);
    const profile = {
      id: botId, name: "Fixture bot", description: "", instructions: "", projectId,
      modelSelection, pinned: false, archived: false, createdAt: at, updatedAt: at,
    };
    yield* settings.insertBotProfileIfAbsent(profile);
    yield* settings.insertBotProfileIfAbsent({ ...profile, id: archivedBotId, archived: true });

    const seedThread = (id: ThreadId, options: {
      readonly projectId?: ProjectId;
      readonly botId?: BotId;
      readonly deleted?: boolean;
    } = {}) =>
      projections.apply({
        id: EventId.make(`seed:${id}`), type: "thread.created", threadId: id, occurredAt: now,
        payload: {
          id, projectId: options.projectId ?? projectId, title: "Fixture thread", createdBy: "user",
          creationSource: "web", providerInstanceId: modelSelection.instanceId, modelSelection,
          runtimeMode: "approval-required", interactionMode: "default", branch: null,
          worktreePath: null, activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
          forkedFrom: null, createdAt: now, updatedAt: now, archivedAt: null, settledAt: null,
          settledOverride: null, lastVisitedAt: null, deletedAt: options.deleted ? now : null,
          ...(options.botId ? { bot: { id: options.botId, name: "Fixture bot", instructions: "" } } : {}),
        },
      });
    yield* seedThread(good, { botId });
    yield* seedThread(foreign, { botId, projectId: foreignProjectId });
    yield* seedThread(ordinary);
    yield* seedThread(deleted, { botId, deleted: true });
    yield* seedThread(archived, { botId: archivedBotId });

    yield* projections.apply({
      id: EventId.make("seed:bot-rpc-run"), type: "run.created", threadId: good, runId,
      occurredAt: now,
      payload: {
        id: runId, threadId: good, ordinal: 1, providerInstanceId: modelSelection.instanceId,
        modelSelection, providerThreadId: null, userMessageId: messageId, rootNodeId: null,
        activeAttemptId: null, status: "running", requestedAt: now, startedAt: now,
        completedAt: null, checkpointId: null, contextHandoffId: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("seed:bot-rpc-message"), type: "message.updated", threadId: good, runId,
      occurredAt: now,
      payload: {
        id: messageId, threadId: good, nodeId: null, runId, role: "user", text: "Fixture prompt",
        attachments: [], streaming: false, createdAt: now, updatedAt: now,
        createdBy: "user", creationSource: "web",
      },
    });

    const routineRuns = yield* makeRoutineRuns;
    assert.isTrue(yield* routineRuns.claim(botId, "our-routine", 1, at));
    assert.isTrue(yield* routineRuns.settle(botId, "our-routine", 1, "admitted", at, null));
    const later = "2026-10-15T00:00:01.000Z";
    assert.isTrue(yield* routineRuns.claim(botId, "our-routine", 4, at));
    assert.isTrue(yield* routineRuns.settle(
      botId, "our-routine", 4, "uncertain", later, "Admission outcome unknown.",
    ));
    assert.isTrue(yield* routineRuns.claim(archivedBotId, "our-routine", 4, at));
    const readStoredHistory = sql`SELECT * FROM bot_routine_runs ORDER BY bot_id, routine_id, occurrence_ms`;
    const beforeHistoryReads = yield* readStoredHistory;

    const shellReads: ThreadId[] = [];
    const callRecordReads: ThreadId[] = [];
    let changeBotIdentityInShell = false;
    const pageUrl = "https://example.invalid/bot-view";
    let revision = "fixture-first";
    let requests = 0;
    let actions = 0;
    const browser = Layer.mock(BackgroundBrowser)({
      requestForThread: (threadId, method, params) => Effect.sync(() => {
        assert.equal(threadId, good);
        assert.equal(method, "tools/call");
        requests++;
        const call = params as { name: string; arguments: { script: string } };
        assert.equal(call.name, "evaluate");
        if (call.arguments.script.includes("const action = ")) {
          if (!call.arguments.script.includes(`"revision":"${revision}"`)) {
            return { isError: true, content: [{ type: "text", text: "Fixture stale control" }] };
          }
          actions++;
          revision = "fixture-updated";
          return { content: [{ type: "text", text: "true" }] };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({
            revision, url: pageUrl, title: "Fixture", html: "<p>Bot view</p>",
          }) }],
        };
      }),
    });
    const services = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(ServerBrowser.ServerBrowser)({}),
      Layer.mock(MausbotService)({}),
      Layer.mock(V2RoutingOwner)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: process.cwd() }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(UsageLimitSources.UsageLimitSources)({}),
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
      Layer.mock(DirectEndpoints.DirectEndpoints)({}),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("bot-rpc-fixture")),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadSnapshotWindow: (id, options) =>
          projections.getThreadSnapshotWindow(id, options).pipe(
            Effect.mapError((cause) => new Orchestrator.OrchestratorProjectionError({ threadId: id, cause })),
          ),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadShell: (id) =>
          Effect.suspend(() => {
            shellReads.push(id);
            return projections.getThreadShell(id);
          }).pipe(
            Effect.map((thread) =>
              thread?.bot && id === good && changeBotIdentityInShell
                ? { ...thread, bot: { ...thread.bot, id: archivedBotId } }
                : thread,
            ),
            Effect.mapError((cause) => new Orchestrator.OrchestratorProjectionError({ threadId: id, cause })),
          ),
      }),
      Layer.succeed(ProjectionStore.ProjectionStoreV2, {
        ...projections,
        getThreadRecords: (id, fields, filter) => Effect.suspend(() => {
          callRecordReads.push(id);
          return projections.getThreadRecords(id, fields, filter);
        }),
      }),
      Layer.succeed(SqlClient.SqlClient, sql),
      browser,
    );
    const serverBrowser = yield* ServerBrowser.ServerBrowser;
    const makeClient = (sessionId: string, scopes: EnvironmentAuth.AuthenticatedSession["scopes"]) =>
      RpcTest.makeClient(botRpcs).pipe(
        Effect.provide(
          layerWsRpc(
            { sessionId: AuthSessionId.make(sessionId), subject: "fixture",
              method: "browser-session-cookie", scopes },
            {},
            serverBrowser,
            () => Effect.void,
            { secretReferences: true },
          ).pipe(
            Layer.provide(services),
            Layer.merge(RpcAuthorization.layer(scopes)),
            Layer.merge(rpcInstrumentationLayer),
          ),
        ),
      );

    const denied = yield* makeClient("none", []);
    const reader = yield* makeClient("reader", [AuthOrchestrationReadScope]);
    const operator = yield* makeClient("operator", [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
    const click = { type: "click" as const, node: 0, revision };
    const unauthorized = yield* Effect.all([
      denied[WS_METHODS.botRoutineHistory]({ botId }).pipe(Effect.flip),
      denied[WS_METHODS.botCallTurn]({ threadId: good, messageId }).pipe(Effect.flip),
      denied[WS_METHODS.botBrowserPage]({ threadId: good }).pipe(Effect.flip),
      reader[WS_METHODS.botBrowserAction]({ threadId: good, action: click }).pipe(Effect.flip),
    ]);
    assert.deepEqual(unauthorized.map((error) =>
      error._tag === "EnvironmentAuthorizationError" ? error.requiredScope : error._tag
    ), [AuthOrchestrationReadScope, AuthOrchestrationReadScope, AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);

    const open = reader[ORCHESTRATION_V2_WS_METHODS.getThreadProjection];
    const visible = yield* open({ threadId: good });
    assert.equal(visible.thread.id, good);
    const refusal = yield* open({ threadId: deleted }).pipe(Effect.flip);
    assert.equal(refusal._tag, "OrchestrationV2GetThreadProjectionError");

    assert.deepEqual(yield* reader[WS_METHODS.botRoutineHistory]({ botId: unknownBotId }), []);
    assert.deepEqual(yield* reader[WS_METHODS.botRoutineHistory]({ botId }), [
      {
        routineId: "our-routine", occurrence: 4, status: "uncertain",
        createdAt: at, updatedAt: later, detail: "Admission outcome unknown.",
      },
      {
        routineId: "our-routine", occurrence: 1, status: "admitted",
        createdAt: at, updatedAt: at, detail: null,
      },
    ]);
    assert.deepEqual(yield* reader[WS_METHODS.botRoutineHistory]({ botId: archivedBotId }), [
      {
        routineId: "our-routine", occurrence: 4, status: "claimed",
        createdAt: at, updatedAt: at, detail: null,
      },
    ]);
    assert.deepEqual(yield* readStoredHistory, beforeHistoryReads);
    assert.deepEqual(shellReads, []);
    assert.deepEqual(callRecordReads, []);
    for (const threadId of [ordinary, missing, deleted]) {
      assert.isNull(yield* reader[WS_METHODS.botCallTurn]({ threadId, messageId }));
    }
    assert.deepEqual(shellReads, [ordinary, missing, deleted]);
    assert.deepEqual(callRecordReads, []);
    assert.isNull(yield* reader[WS_METHODS.botCallTurn]({ threadId: foreign, messageId }));
    assert.deepEqual(callRecordReads, [foreign]);

    changeBotIdentityInShell = true;
    assert.isNull(yield* reader[WS_METHODS.botCallTurn]({ threadId: good, messageId }));
    changeBotIdentityInShell = false;
    assert.isNull(yield* reader[WS_METHODS.botCallTurn]({
      threadId: good, messageId: MessageId.make("other-message"),
    }));
    assert.deepEqual(yield* reader[WS_METHODS.botCallTurn]({ threadId: good, messageId }),
      { turnId: runId, state: "running", assistantMessageId: null, text: null });

    for (const threadId of [ordinary, missing, foreign, deleted, archived]) {
      const read = yield* reader[WS_METHODS.botBrowserPage]({ threadId }).pipe(Effect.flip);
      const action = yield* operator[WS_METHODS.botBrowserAction]({
        threadId, action: { type: "open" },
      }).pipe(Effect.flip);
      assert.equal(read._tag, "BotBrowserError");
      assert.equal(action._tag, "BotBrowserError");
    }
    assert.equal(requests, 0);

    assert.equal((yield* reader[WS_METHODS.botBrowserPage]({ threadId: good }))?.url, pageUrl);
    assert.isNull(yield* reader[WS_METHODS.botBrowserPage]({ threadId: good, revision }));
    const stale = yield* operator[WS_METHODS.botBrowserAction]({
      threadId: good, action: { ...click, revision: "fixture-stale" },
    }).pipe(Effect.flip);
    assert.equal(stale._tag, "BotBrowserError");
    assert.equal(actions, 0);
    assert.equal((yield* operator[WS_METHODS.botBrowserAction]({
      threadId: good, action: click,
    })).revision, "fixture-updated");
    assert.equal(actions, 1);
  }).pipe(
    Effect.provide(ProjectionStore.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(layerConfigSources, Layer.mock(ServerBrowser.ServerBrowser)({}))),
    )),
  ),
);

const hiveMindRpcTags = [
  WS_METHODS.hiveMindSnapshot,
  WS_METHODS.hiveMindConfigure,
  WS_METHODS.hiveMindSearch,
  WS_METHODS.hiveMindMutate,
  WS_METHODS.hiveMindImport,
  WS_METHODS.hiveMindSync,
  WS_METHODS.serverGetSettings,
] as const;
const hiveMindRpcs = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<
      keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
      (typeof hiveMindRpcTags)[number]
    > => !(hiveMindRpcTags as ReadonlyArray<string>).includes(tag),
  ),
).middleware(RpcInstrumentation);

it.effect("Hive Mind RPCs persist edits and reject unauthorized or invalid writes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const hive = yield* HiveMindService;
    const serverBrowser = yield* ServerBrowser.ServerBrowser;
    const services = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(BackgroundBrowser)({}),
      Layer.mock(MausbotService)({}),
      Layer.mock(V2RoutingOwner)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: process.cwd() }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(UsageLimitSources.UsageLimitSources)({}),
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
      Layer.mock(DirectEndpoints.DirectEndpoints)({}),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("hive-mind-rpc-fixture")),
      }),
      Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
      Layer.succeed(SqlClient.SqlClient, sql),
      Layer.succeed(HiveMindService, hive),
    );
    const makeClient = (sessionId: string, scopes: EnvironmentAuth.AuthenticatedSession["scopes"]) =>
      RpcTest.makeClient(hiveMindRpcs).pipe(
        Effect.provide(
          layerWsRpc(
            {
              sessionId: AuthSessionId.make(sessionId),
              subject: "hive-mind-fixture",
              method: "browser-session-cookie",
              scopes,
            },
            {},
            serverBrowser,
            () => Effect.void,
            { secretReferences: true },
          ).pipe(
            Layer.provide(services),
            Layer.merge(RpcAuthorization.layer(scopes)),
            Layer.merge(rpcInstrumentationLayer),
          ),
        ),
      );

    const writer = yield* makeClient("hive-writer", [
      AuthOrchestrationReadScope,
      AuthOrchestrationOperateScope,
      AuthAccessWriteScope,
    ]);
    const reader = yield* makeClient("hive-reader", [AuthOrchestrationReadScope]);
    const noReadScope = yield* makeClient("hive-without-read", []);
    const start = yield* writer[WS_METHODS.hiveMindSnapshot]({});
    assert.equal(start.records, 0);
    const configured = yield* writer[WS_METHODS.hiveMindConfigure]({ version: 1, automatic: false });
    assert.isFalse(configured.config.automatic);
    const initial = "Copper cools the engine.";
    const updated = "Aluminum cools the engine.";
    const saved = yield* writer[WS_METHODS.hiveMindMutate]({
      action: "remember", scope: "project", project: "J1Code", subject: "Engine", fact: initial,
    });
    assert.equal(saved.records, 1);
    const { memories } = yield* writer[WS_METHODS.hiveMindSearch]({ query: "copper" });
    assert.lengthOf(memories, 1);
    const memory = memories[0]!;
    assert.equal(memory.fact, initial);
    assert.isString(memory.revision);
    const edit = { action: "edit" as const, id: memory.id, revision: memory.revision! };
    yield* writer[WS_METHODS.hiveMindMutate]({ ...edit, fact: updated });
    const found = yield* reader[WS_METHODS.hiveMindSearch]({ query: "aluminum", project: "J1Code" });
    assert.lengthOf(found.memories, 1);
    assert.equal(found.memories[0]?.id, memory.id);
    assert.equal(found.memories[0]?.fact, updated);
    assert.notEqual(found.memories[0]?.revision, memory.revision);

    const badInput = yield* Effect.all([
      writer[WS_METHODS.hiveMindMutate]({ ...edit, fact: "An outdated correction." }).pipe(Effect.flip),
      writer[WS_METHODS.hiveMindConfigure]({ version: 1, vault: "relative" }).pipe(Effect.flip),
      writer[WS_METHODS.hiveMindImport]({ url: "file:///invalid-hive-source", bank: "legacy" }).pipe(Effect.flip),
    ]);
    assert.deepEqual(badInput.map((error) => error._tag), ["HiveMindError", "HiveMindError", "HiveMindError"]);

    const unauthorized = yield* Effect.all([
      noReadScope[WS_METHODS.hiveMindSnapshot]({}).pipe(Effect.flip),
      noReadScope[WS_METHODS.hiveMindSearch]({ query: "aluminum" }).pipe(Effect.flip),
      reader[WS_METHODS.hiveMindConfigure]({ version: 1 }).pipe(Effect.flip),
      reader[WS_METHODS.hiveMindImport]({ url: "file:///denied-hive-source", bank: "legacy" }).pipe(Effect.flip),
      reader[WS_METHODS.hiveMindMutate]({
        action: "remember", scope: "general", subject: "Rejected", fact: "Do not write this.",
      }).pipe(Effect.flip),
      reader[WS_METHODS.hiveMindSync]({}).pipe(Effect.flip),
    ]);
    assert.deepEqual(unauthorized.map((error) =>
      error._tag === "EnvironmentAuthorizationError" ? error.requiredScope : error._tag
    ), [
      AuthOrchestrationReadScope, AuthOrchestrationReadScope,
      AuthAccessWriteScope, AuthAccessWriteScope,
      AuthOrchestrationOperateScope, AuthOrchestrationOperateScope,
    ]);
    const after = yield* reader[WS_METHODS.hiveMindSnapshot]({});
    assert.equal(after.records, 1);
    assert.isFalse(after.config.automatic);
    assert.isDefined(yield* reader[WS_METHODS.serverGetSettings]({}));

    const persisted = yield* Effect.promise(() => readHiveMind(hive.runtime.file));
    assert.deepEqual(persisted.memories.map(({ id, fact, project }) => ({ id, fact, project })),
      [{ id: memory.id, fact: updated, project: "J1Code" }]);
    const storedConfig = yield* Effect.promise(() => readHiveConfig(hive.runtime.file));
    assert.deepEqual(storedConfig, { version: 1, automatic: false });
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(
      ProjectionStore.layer,
      HiveMindService.layer.pipe(Layer.provide(Layer.succeed(ServerActivation, Effect.never))),
      Layer.mock(ServerBrowser.ServerBrowser)({}),
    ).pipe(Layer.provideMerge(layerConfigSources))),
  ),
);

const installRpcTags = [
  WS_METHODS.providerInstallStart,
  WS_METHODS.providerInstallCancel,
  WS_METHODS.providerInstallSubscribe,
  WS_METHODS.providerInstallRemove,
] as const;
const installRpcs = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<
      keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
      (typeof installRpcTags)[number]
    > => !(installRpcTags as ReadonlyArray<string>).includes(tag),
  ),
).middleware(RpcInstrumentation);

it.effect("provider installation RPCs isolate driver operations and observe cancellation", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const serverBrowser = yield* ServerBrowser.ServerBrowser;
    const antigravity = ProviderDriverKind.make("antigravity");
    const codex = ProviderDriverKind.make("codex");
    const primaryId = ProviderInstanceId.make("antigravity");
    const neighborId = ProviderInstanceId.make("codex");
    const unknownId = ProviderInstanceId.make("installation-unknown");
    const calls: string[] = [];
    const notCurrent = "This installation is no longer current. Refresh its status before cancelling.";

    const makeInstaller = Effect.fnUntraced(function* (driver: ProviderDriverKind) {
      const idle: ProviderInstallState = {
        driver, phase: "idle", operationId: null, downloadedBytes: 0, totalBytes: null,
        version: null, installedVersion: null, canRemove: false, message: null,
      };
      const state = yield* SubscriptionRef.make(idle);
      return {
        managedDirectory: "/unused",
        state: SubscriptionRef.get(state),
        changes: SubscriptionRef.changes(state),
        start: Effect.gen(function* () {
          calls.push(`start:${driver}`);
          const next: ProviderInstallState = {
            ...idle, phase: "downloading", operationId: `install:${driver}`,
          };
          yield* SubscriptionRef.set(state, next);
          return next;
        }),
        cancel: Effect.fnUntraced(function* (operationId: string) {
          calls.push(`cancel:${driver}:${operationId}`);
          const current = yield* SubscriptionRef.get(state);
          if (current.operationId !== operationId) {
            return yield* new AntigravityInstallation.AntigravityInstallationError({
              operation: "cancel",
              detail: notCurrent,
              cause: new Error("Private download diagnostics."),
            });
          }
          const cancelled: ProviderInstallState = { ...current, phase: "cancelled" };
          yield* SubscriptionRef.set(state, cancelled);
          return cancelled;
        }),
        checkForUpdate: Effect.die("Update checks are disabled in the fixture"),
        remove: () => Effect.die("No removal should reach the installer"),
      };
    });
    const primary = yield* makeInstaller(antigravity);
    const neighbor = yield* makeInstaller(codex);
    const instance = (id: ProviderInstanceId, driverKind: ProviderDriverKind): ProviderInstance => ({
      instanceId: id,
      driverKind,
      enabled: false,
      displayName: undefined,
      continuationIdentity: { driverKind, continuationKey: id },
      get snapshot(): never { throw new Error("Installation must not probe a provider"); },
      get orchestrationAdapter(): never { throw new Error("Installation must not launch a provider"); },
      get textGeneration(): never { throw new Error("Installation must not generate text"); },
    });
    const instances = [instance(primaryId, antigravity), instance(neighborId, codex)];
    const dependencies = Layer.mergeAll(
      Layer.mock(AntigravityInstallation.AntigravityInstallation)(primary),
      Layer.mock(CodexInstallation.CodexInstallation)({
        ...neighbor,
        cancel: (operationId) => neighbor.cancel(operationId).pipe(
          Effect.mapError((error) => new CodexInstallation.CodexInstallationError({
            operation: error.operation, detail: error.detail, cause: error.cause,
          })),
        ),
      }),
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: (id) => Effect.succeed(instances.find((entry) => entry.instanceId === id)),
        listInstances: Effect.succeed(instances),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      ServerSettings.layerTest({
        enableProviderUpdateChecks: false,
        providerInstances: { [neighborId]: { driver: codex, config: { setupMode: "managed" } } },
      }),
    );
    const services = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(BackgroundBrowser)({}),
      Layer.mock(MausbotService)({}),
      Layer.mock(V2RoutingOwner)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: process.cwd() }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(UsageLimitSources.UsageLimitSources)({}),
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
      Layer.mock(DirectEndpoints.DirectEndpoints)({}),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("provider-install-rpc-fixture")),
      }),
      Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
      Layer.succeed(SqlClient.SqlClient, sql),
      ProviderInstallation.layer,
    ).pipe(Layer.provide(dependencies), Layer.merge(dependencies));
    // Share one production installation controller across both client scopes.
    const shared = yield* Layer.build(services);
    const makeClient = (sessionId: string, scopes: EnvironmentAuth.AuthenticatedSession["scopes"]) =>
      RpcTest.makeClient(installRpcs).pipe(
        Effect.provide(layerWsRpc(
          { sessionId: AuthSessionId.make(sessionId), subject: "fixture", method: "browser-session-cookie", scopes },
          {},
          serverBrowser,
          () => Effect.void,
          { secretReferences: true },
        ).pipe(
          Layer.provide(Layer.succeedContext(shared)),
          Layer.merge(RpcAuthorization.layer(scopes)),
          Layer.merge(rpcInstrumentationLayer),
        )),
      );
    const managerScopes = [AuthOrchestrationReadScope, AuthProvidersManageScope] as const;
    const manager = yield* makeClient("install-manager", managerScopes);
    const secondManager = yield* makeClient("install-neighbor", managerScopes);
    const reader = yield* makeClient("install-reader", [AuthOrchestrationReadScope]);
    const primaryTarget = { instanceId: primaryId };
    const neighborTarget = { instanceId: neighborId };
    const head = <A, E>(stream: Stream.Stream<A, E>) =>
      stream.pipe(Stream.runHead, Effect.map(Option.getOrThrow));

    const observed = yield* Queue.unbounded<ProviderInstallState>();
    yield* reader[WS_METHODS.providerInstallSubscribe](primaryTarget).pipe(
      Stream.runForEach((state) => Queue.offer(observed, state)),
      Effect.forkScoped,
    );
    assert.equal((yield* Queue.take(observed)).phase, "idle");
    const unknown = yield* Effect.all([
      manager[WS_METHODS.providerInstallStart]({ instanceId: unknownId }).pipe(Effect.flip),
      manager[WS_METHODS.providerInstallCancel]({ instanceId: unknownId, operationId: "unknown" }).pipe(Effect.flip),
      reader[WS_METHODS.providerInstallSubscribe]({ instanceId: unknownId }).pipe(Stream.runHead, Effect.flip),
    ]);
    assert.deepEqual(unknown.map((error) => error._tag), ["ProviderSetupError", "ProviderSetupError", "ProviderSetupError"]);
    const denied = yield* Effect.all([
      reader[WS_METHODS.providerInstallStart](primaryTarget).pipe(Effect.flip),
      reader[WS_METHODS.providerInstallCancel]({ ...primaryTarget, operationId: "install:antigravity" }).pipe(Effect.flip),
      reader[WS_METHODS.providerInstallRemove](primaryTarget).pipe(Effect.flip),
    ]);
    assert.deepEqual(denied.map((error) =>
      error._tag === "EnvironmentAuthorizationError" ? error.requiredPermission : error._tag
    ), [AuthProvidersManageScope, AuthProvidersManageScope, AuthProvidersManageScope]);
    assert.deepEqual(calls, []);

    const started = yield* manager[WS_METHODS.providerInstallStart](primaryTarget);
    assert.equal(started.phase, "downloading");
    assert.deepEqual(yield* Queue.take(observed), started);
    const neighborStarted = yield* secondManager[WS_METHODS.providerInstallStart](neighborTarget);
    const stale = yield* manager[WS_METHODS.providerInstallCancel]({
      ...primaryTarget, operationId: "old-operation",
    }).pipe(Effect.flip);
    const foreign = yield* manager[WS_METHODS.providerInstallCancel]({
      ...neighborTarget, operationId: started.operationId!,
    }).pipe(Effect.flip);
    for (const [error, id] of [[stale, primaryId], [foreign, neighborId]] as const) {
      assert.equal(error._tag, "ProviderSetupError");
      if (error._tag === "ProviderSetupError") {
        assert.equal(error.instanceId, id);
        assert.equal(error.operation, "cancel");
        assert.equal(error.detail, notCurrent);
        assert.isUndefined(error.cause);
      }
      assert.notInclude(JSON.stringify(error), "Private download diagnostics");
    }
    assert.deepEqual(yield* head(reader[WS_METHODS.providerInstallSubscribe](primaryTarget)), started);
    assert.deepEqual(yield* head(reader[WS_METHODS.providerInstallSubscribe](neighborTarget)), neighborStarted);

    const cancelled = yield* secondManager[WS_METHODS.providerInstallCancel]({
      ...primaryTarget, operationId: started.operationId!,
    });
    assert.equal(cancelled.phase, "cancelled");
    assert.deepEqual(yield* Queue.take(observed), cancelled);
    assert.deepEqual(yield* head(reader[WS_METHODS.providerInstallSubscribe](primaryTarget)), cancelled);
    assert.deepEqual(yield* head(reader[WS_METHODS.providerInstallSubscribe](neighborTarget)), neighborStarted);
    assert.equal((yield* secondManager[WS_METHODS.providerInstallCancel]({
      ...neighborTarget, operationId: neighborStarted.operationId!,
    })).phase, "cancelled");
    assert.deepEqual(calls, [
      "start:antigravity", "start:codex", "cancel:antigravity:old-operation",
      "cancel:codex:install:antigravity", "cancel:antigravity:install:antigravity",
      "cancel:codex:install:codex",
    ]);
  }).pipe(
    Effect.scoped,
    Effect.provide(ProjectionStore.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(layerConfigSources, Layer.mock(ServerBrowser.ServerBrowser)({}))),
    )),
  ),
);

const terminalRpcTags = [
  WS_METHODS.terminalOpen,
  WS_METHODS.terminalAttach,
  WS_METHODS.terminalObserve,
  WS_METHODS.terminalWrite,
  WS_METHODS.terminalResize,
  WS_METHODS.terminalClear,
  WS_METHODS.terminalClose,
] as const;
const terminalRpcs = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<
      keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
      (typeof terminalRpcTags)[number]
    > => !(terminalRpcTags as ReadonlyArray<string>).includes(tag),
  ),
).middleware(RpcInstrumentation);

it.effect("terminal RPCs protect deleted threads and enforce viewer scopes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const browser = yield* ServerBrowser.ServerBrowser;
    const calls: string[] = [];
    const viewers: (string | undefined)[] = [];
    const terminal = { threadId: "terminal-draft", terminalId: "default" };
    const input = { ...terminal, cwd: process.cwd() };
    const snapshot = {
      ...input, worktreePath: null, status: "running" as const, pid: 1234, history: "",
      exitCode: null, exitSignal: null, label: "Fixture", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const seed = { type: "snapshot" as const, snapshot };
    const record = (operation: string) => Effect.sync(() => { calls.push(operation); });
    const services = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(BackgroundBrowser)({}),
      Layer.mock(MausbotService)({}),
      Layer.mock(V2RoutingOwner)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: process.cwd() }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(UsageLimitSources.UsageLimitSources)({}),
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
      Layer.mock(DirectEndpoints.DirectEndpoints)({}),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("terminal-rpc-fixture")),
      }),
      Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
      Layer.succeed(SqlClient.SqlClient, sql),
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadRecords: (threadId) => {
          if (threadId === "terminal-deleted") {
            return Effect.succeed({
              thread: { id: threadId, deletedAt: DateTime.makeUnsafe(0), worktreePath: null },
            } as never);
          }
          return Effect.fail(new Orchestrator.OrchestratorProjectionError({
            threadId,
            cause: threadId === "terminal-unavailable"
              ? new Error("fixture storage outage")
              : new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }),
          }));
        },
      }),
      Layer.mock(TerminalManager.TerminalManager)({
        open: () => record("open").pipe(Effect.as(snapshot)),
        attachOutputStream: (_input, viewer) => Stream.fromEffect(
          record("attach").pipe(Effect.tap(() => Effect.sync(() => { viewers.push(viewer); })), Effect.as(seed)),
        ),
        observeStream: (_input, listener) => record("observe").pipe(
          Effect.andThen(listener(seed)), Effect.as(() => undefined),
        ),
        write: (input, viewer) =>
          input.data === "fixture-error"
            ? Effect.fail(new TerminalManager.TerminalNotRunningError(terminal))
            : record("write").pipe(Effect.tap(() => Effect.sync(() => { viewers.push(viewer); }))),
        resize: () => record("resize"),
        clear: () => record("clear"),
        close: () => record("close"),
      }),
    );
    const makeClient = (id: string, scopes: EnvironmentAuth.AuthenticatedSession["scopes"]) =>
      RpcTest.makeClient(terminalRpcs).pipe(Effect.provide(
        layerWsRpc(
          { sessionId: AuthSessionId.make(id), subject: "fixture", method: "browser-session-cookie", scopes },
          {}, browser, () => Effect.void, { secretReferences: true },
        ).pipe(
          Layer.provide(services),
          Layer.merge(RpcAuthorization.layer(scopes)),
          Layer.merge(rpcInstrumentationLayer),
        ),
      ));
    const reader = yield* makeClient("terminal-reader", [AuthTerminalReadScope]);
    const operator = yield* makeClient("terminal-operator", [AuthTerminalOperateScope]);
    const denied = yield* reader[WS_METHODS.terminalWrite]({ ...terminal, data: "fixture" }).pipe(Effect.flip);
    assert.equal(denied._tag, "EnvironmentAuthorizationError");
    const deniedAttach = yield* reader[WS_METHODS.terminalAttach](input).pipe(Stream.runHead, Effect.flip);
    assert.equal(deniedAttach._tag, "EnvironmentAuthorizationError");
    assert.deepEqual(calls, []);
    assert.deepEqual(yield* reader[WS_METHODS.terminalObserve](terminal).pipe(Stream.runHead), Option.some(seed));
    for (const threadId of ["terminal-deleted", "terminal-unavailable"]) {
      const deniedOpen = yield* operator[WS_METHODS.terminalOpen]({ ...input, threadId }).pipe(Effect.flip);
      assert.equal(deniedOpen._tag, "TerminalSessionLookupError");
      const deniedAttach = yield* operator[WS_METHODS.terminalAttach]({ ...input, threadId }).pipe(Stream.runHead, Effect.flip);
      assert.equal(deniedAttach._tag, "TerminalSessionLookupError");
    }
    assert.deepEqual(calls, ["observe"]);
    assert.equal((yield* operator[WS_METHODS.terminalOpen](input)).terminalId, terminal.terminalId);
    assert.deepEqual(yield* operator[WS_METHODS.terminalAttach](input).pipe(Stream.runHead), Option.some(seed));
    yield* operator[WS_METHODS.terminalWrite]({ ...terminal, data: "fixture" });
    yield* operator[WS_METHODS.terminalResize]({ ...terminal, cols: 120, rows: 40 });
    yield* operator[WS_METHODS.terminalClear](terminal);
    yield* operator[WS_METHODS.terminalClose](terminal);
    const error = yield* operator[WS_METHODS.terminalWrite]({ ...terminal, data: "fixture-error" }).pipe(Effect.flip);
    assert.equal(error._tag, "TerminalNotRunningError");
    assert.deepEqual(calls, ["observe", "open", "attach", "write", "resize", "clear", "close"]);
    assert.isDefined(viewers[0]);
    assert.deepEqual(viewers, [viewers[0], viewers[0]]);
  }).pipe(
    Effect.scoped,
    Effect.provide(ProjectionStore.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(layerConfigSources, Layer.mock(ServerBrowser.ServerBrowser)({}))),
    )),
  ),
);

const workspaceFailureRpcTags = [
  WS_METHODS.projectsSearchEntries,
  WS_METHODS.projectsSearchContents,
  WS_METHODS.projectsListEntries,
  WS_METHODS.projectsReadFile,
  WS_METHODS.projectsWriteFile,
  WS_METHODS.filesystemBrowse,
] as const;
const workspaceFailureRpcs = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<
      keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
      (typeof workspaceFailureRpcTags)[number]
    > => !(workspaceFailureRpcTags as ReadonlyArray<string>).includes(tag),
  ),
).middleware(RpcInstrumentation);

const layerWorkspaceFailureServices = Layer.mergeAll(
  ProjectionStore.layer,
  Layer.mock(ServerBrowser.ServerBrowser)({}),
  WorkspaceFileSystem.layer.pipe(
    Layer.provide(Layer.mock(KnownWorkspaces.KnownWorkspaces)({})),
    Layer.provideMerge(WorkspaceEntries.layer),
    Layer.provide(WorkspacePaths.layer),
  ),
).pipe(Layer.provideMerge(layerConfigSources));

it.effect("workspace RPCs enforce read scope and keep structured, redacted failures", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const entries = yield* WorkspaceEntries.WorkspaceEntries;
    const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
    const serverBrowser = yield* ServerBrowser.ServerBrowser;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "j1-workspace-rpc-errors-" });
    const workspaceDir = path.join(root, "workspace");
    const outsideDir = path.join(root, "outside");
    yield* fs.makeDirectory(workspaceDir);
    yield* fs.makeDirectory(outsideDir);
    yield* fs.writeFileString(path.join(workspaceDir, "inside.txt"), "Inside fixture\n");
    yield* fs.makeDirectory(path.join(workspaceDir, "src"));
    yield* fs.writeFileString(path.join(workspaceDir, "src", "index.ts"), "export const answer = 42;\n");
    const { secretsDir } = yield* ServerConfigModule.ServerConfig;
    yield* fs.makeDirectory(secretsDir, { recursive: true });
    const privateFile = path.join(secretsDir, "workspace-rpc-fixture.txt");
    const privateContents = "private fixture only";
    yield* fs.writeFileString(privateFile, privateContents);
    const outsideFile = path.join(outsideDir, "outside.txt");
    yield* fs.writeFileString(outsideFile, "Outside fixture\n");

    let escapedRelativePath: string | undefined;
    const platform = yield* HostProcess.Platform;
    if (symlinksSupported) {
      escapedRelativePath = "linked-outside.txt";
      yield* fs.symlink(outsideFile, path.join(workspaceDir, escapedRelativePath));
    } else if (platform === "win32") {
      const junction = yield* Effect.tryPromise({
        try: () => NodeFSP.symlink(outsideDir, path.join(workspaceDir, "outside-link"), "junction"),
        catch: (cause) => new WsFixtureFailure({ message: "Could not create the fixture junction", cause }),
      }).pipe(Effect.option);
      if (Option.isSome(junction)) escapedRelativePath = "outside-link/outside.txt";
    }
    const directoryLink = "linked-directory";
    const hasDirectoryLink = platform === "win32" || symlinksSupported;
    if (hasDirectoryLink) {
      yield* Effect.promise(() => NodeFSP.symlink(
        outsideDir,
        path.join(workspaceDir, directoryLink),
        platform === "win32" ? "junction" : "dir",
      ));
    }
    const missingRoot = path.join(workspaceDir, "missing-workspace");
    const blockedRoot = path.join(root, "blocked-workspace");
    const fileRoot = path.join(workspaceDir, "inside.txt");
    const blockedPaths = yield* Effect.service(WorkspacePaths.WorkspacePaths).pipe(
      Effect.provide(Layer.fresh(WorkspacePaths.layer)),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        stat: (target) => target === blockedRoot
          ? Effect.fail(PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "stat",
              pathOrDescriptor: target,
            }))
          : fs.stat(target),
      }),
    );
    const sensitiveQuery = "authorization: Bearer fixture-secret-token";
    let entrySearches = 0;
    let entryLists = 0;
    let fileReads = 0;
    let fileWrites = 0;
    const writeFiles = yield* WorkspaceFileSystem.make.pipe(
      Effect.provideService(KnownWorkspaces.KnownWorkspaces, {
        contains: (cwd) => Effect.succeed(cwd === workspaceDir || cwd === secretsDir),
        assertContains: (cwd) =>
          cwd === workspaceDir || cwd === secretsDir
            ? Effect.void
            : Effect.fail(new KnownWorkspaces.UnknownWorkspaceError({ cwd })),
      }),
      Effect.provide(WorkspacePaths.layer),
    );
    const indexFailure = (input: { cwd: string; query: string; limit: number }) =>
      Effect.fail(new WorkspaceSearchIndexSearchFailed({
        cwd: input.cwd,
        queryLength: input.query.length,
        pageSize: input.limit,
        reason: `Search backend diagnostic: ${input.query}`,
        cause: new Error(`Private diagnostic: ${input.query}`),
      }));
    const services = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(BackgroundBrowser)({}),
      Layer.mock(MausbotService)({}),
      Layer.mock(V2RoutingOwner)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: root }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(UsageLimitSources.UsageLimitSources)({}),
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
      Layer.mock(DirectEndpoints.DirectEndpoints)({}),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("workspace-failure-fixture")),
      }),
      Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
      Layer.succeed(SqlClient.SqlClient, sql),
      Layer.succeed(WorkspaceFileSystem.WorkspaceFileSystem, {
        ...files,
        readFile: (input) => Effect.suspend(() => {
          fileReads++;
          return files.readFile(input);
        }),
        writeFile: (input) => Effect.suspend(() => {
          fileWrites++;
          if (input.relativePath !== "failed-write.txt") return writeFiles.writeFile(input);
          const resolvedPath = path.join(input.cwd, input.relativePath);
          return Effect.fail(new WorkspaceFileSystem.WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath,
            operationPath: resolvedPath,
            operation: "write-file",
            cause: new Error(input.contents),
          }));
        }),
      }),
      Layer.succeed(WorkspaceEntries.WorkspaceEntries, {
        ...entries,
        list: (input) => Effect.suspend(() => {
          entryLists++;
          return input.cwd === blockedRoot
            ? blockedPaths.normalizeWorkspaceRoot(input.cwd).pipe(Effect.andThen(entries.list(input)))
            : entries.list(input);
        }),
        search: (input) => Effect.suspend(() => {
          entrySearches++;
          return input.cwd === workspaceDir && input.query === sensitiveQuery
            ? indexFailure(input)
            : entries.search(input);
        }),
        searchContents: (input) => input.cwd === workspaceDir ? indexFailure(input) : entries.searchContents(input),
      }),
    );
    const makeClient = (sessionId: string, scopes: EnvironmentAuth.AuthenticatedSession["scopes"]) =>
      RpcTest.makeClient(workspaceFailureRpcs).pipe(
        Effect.provide(
          layerWsRpc(
            { sessionId: AuthSessionId.make(sessionId), subject: "fixture", method: "browser-session-cookie", scopes },
            {},
            serverBrowser,
            () => Effect.void,
            { secretReferences: true },
          ).pipe(
            Layer.provide(services),
            Layer.merge(RpcAuthorization.layer(scopes)),
            Layer.merge(rpcInstrumentationLayer),
          ),
        ),
      );

    const reader = yield* makeClient("workspace-reader", [AuthFilesystemReadScope]);
    const ordinaryReader = yield* makeClient("orchestration-only", [AuthOrchestrationReadScope]);
    const inside = { cwd: workspaceDir, relativePath: "src/index.ts" };
    const listingInput = { cwd: workspaceDir };
    const denied = yield* ordinaryReader[WS_METHODS.projectsReadFile](inside).pipe(Effect.flip);
    assert.equal(denied._tag, "EnvironmentAuthorizationError");
    if (denied._tag === "EnvironmentAuthorizationError") {
      assert.equal(denied.requiredPermission, AuthFilesystemReadScope);
    }
    assert.equal(fileReads, 0);
    const listDenied = yield* ordinaryReader[WS_METHODS.projectsListEntries](listingInput).pipe(
      Effect.flip,
    );
    if (listDenied._tag !== "EnvironmentAuthorizationError") return yield* Effect.die(listDenied);
    assert.equal(listDenied.requiredPermission, AuthFilesystemReadScope);
    assert.equal(entryLists, 0);

    const listing = yield* reader[WS_METHODS.projectsListEntries](listingInput);
    assert.deepInclude(listing.entries, { path: "src/index.ts", kind: "file" });
    assert.isFalse(listing.truncated);
    assert.deepEqual(yield* reader[WS_METHODS.projectsReadFile](inside), {
      relativePath: "src/index.ts",
      contents: "export const answer = 42;\n",
      byteLength: 26,
      truncated: false,
    });
    if (hasDirectoryLink) {
      const linkedListing = yield* reader[WS_METHODS.projectsListEntries]({
        cwd: workspaceDir, directoryPath: directoryLink,
      }).pipe(Effect.flip);
      if (linkedListing._tag !== "ProjectListEntriesError") return yield* Effect.die(linkedListing);
      assert.equal(linkedListing.failure, "directory_list_failed");
      assert.isFalse(listing.entries.some((entry) => entry.path === directoryLink));
      const rootListing = yield* reader[WS_METHODS.projectsListEntries]({
        cwd: workspaceDir, directoryPath: "",
      });
      assert.isFalse(rootListing.entries.some((entry) => entry.path === directoryLink));
    }
    const privateRead = yield* reader[WS_METHODS.projectsReadFile]({
      cwd: workspaceDir, relativePath: privateFile,
    }).pipe(Effect.flip);
    if (privateRead._tag !== "ProjectReadFileError") return yield* Effect.die(privateRead);
    assert.equal(privateRead.failure, "workspace_path_outside_root");
    assert.notInclude(JSON.stringify((yield* encodeProjectReadFileError(privateRead))), privateContents);

    const entryInput = { cwd: workspaceDir, query: "inside.txt", limit: 10, kind: "file" } as const;
    const entryDenied = yield* ordinaryReader[WS_METHODS.projectsSearchEntries](entryInput).pipe(
      Effect.flip,
    );
    if (entryDenied._tag !== "EnvironmentAuthorizationError") return yield* Effect.die(entryDenied);
    assert.equal(entryDenied.requiredPermission, AuthFilesystemReadScope);
    assert.equal(entrySearches, 0);
    assert.deepEqual(yield* reader[WS_METHODS.projectsSearchEntries](entryInput), {
      entries: [{ path: "inside.txt", kind: "file" }],
      truncated: false,
    });
    assert.equal(entrySearches, 1);

    const searchInput = { cwd: missingRoot, query: sensitiveQuery, limit: 10 };
    const search = yield* reader[WS_METHODS.projectsSearchEntries](searchInput).pipe(Effect.flip);
    if (search._tag !== "ProjectSearchEntriesError") throw new Error("Expected a typed search failure");
    assert.equal(search.message, `Failed to search workspace entries in '${missingRoot}'.`);
    assert.equal(search.cwd, missingRoot);
    assert.equal(search.queryLength, sensitiveQuery.length);
    assert.equal(search.limit, 10);
    assert.equal(search.failure, "workspace_root_not_found");
    assert.equal(search.normalizedCwd, missingRoot);
    assert.isDefined(search.cause);
    assert.notProperty(search, "query");
    assert.notInclude(search.message, "Bearer");
    assert.notInclude(JSON.stringify((yield* encodeProjectSearchEntriesError(search))), "fixture-secret-token");

    const list = yield* reader[WS_METHODS.projectsListEntries]({ cwd: missingRoot }).pipe(Effect.flip);
    if (list._tag !== "ProjectListEntriesError") throw new Error("Expected a typed list failure");
    assert.equal(list.message, `Failed to list workspace entries in '${missingRoot}'.`);
    assert.equal(list.cwd, missingRoot);
    assert.equal(list.failure, "workspace_root_not_found");
    assert.equal(list.normalizedCwd, missingRoot);
    assert.isDefined(list.cause);

    const blockedList = yield* reader[WS_METHODS.projectsListEntries]({ cwd: blockedRoot }).pipe(
      Effect.flip,
    );
    if (blockedList._tag !== "ProjectListEntriesError") return yield* Effect.die(blockedList);
    const decodedBlocked = yield* decodeProjectListEntriesError(
      (yield* encodeProjectListEntriesError(blockedList)),
    );
    assert.equal(decodedBlocked.failure, "workspace_root_stat_failed");
    assert.equal(decodedBlocked.normalizedCwd, blockedRoot);
    assert.equal(decodedBlocked.detail, "validate-existing");
    assert.isDefined(decodedBlocked.cause);

    const fileRootList = yield* reader[WS_METHODS.projectsListEntries]({ cwd: fileRoot }).pipe(
      Effect.flip,
    );
    if (fileRootList._tag !== "ProjectListEntriesError") return yield* Effect.die(fileRootList);
    assert.equal(fileRootList.failure, "workspace_root_not_directory");
    assert.equal(fileRootList.normalizedCwd, fileRoot);

    const partialPath = "./missing-browse/child";
    const browse = yield* reader[WS_METHODS.filesystemBrowse]({ cwd: workspaceDir, partialPath }).pipe(Effect.flip);
    if (browse._tag !== "FilesystemBrowseError") throw new Error("Expected a typed browse failure");
    assert.equal(browse.message, `Failed to browse filesystem path '${partialPath}' from '${workspaceDir}'.`);
    assert.equal(browse.cwd, workspaceDir);
    assert.equal(browse.partialPath, partialPath);
    assert.equal(browse.failure, "read_directory_failed");
    assert.equal(browse.parentPath, path.join(workspaceDir, "missing-browse"));
    assert.isTrue(browse.pathMissing);
    assert.isDefined(browse.cause);

    const lexicalEscape = yield* reader[WS_METHODS.projectsReadFile]({
      cwd: workspaceDir, relativePath: "../outside/outside.txt",
    }).pipe(Effect.flip);
    if (lexicalEscape._tag !== "ProjectReadFileError") throw new Error("Expected a typed read failure");
    assert.equal(lexicalEscape.failure, "workspace_path_outside_root");
    if (escapedRelativePath !== undefined) {
      const escaped = yield* reader[WS_METHODS.projectsReadFile]({
        cwd: workspaceDir, relativePath: escapedRelativePath,
      }).pipe(Effect.flip);
      if (escaped._tag !== "ProjectReadFileError") throw new Error("Expected a typed link failure");
      assert.equal(escaped.message, `Failed to read workspace file '${escapedRelativePath}' in '${workspaceDir}'.`);
      assert.equal(escaped.cwd, workspaceDir);
      assert.equal(escaped.relativePath, escapedRelativePath);
      assert.equal(escaped.failure, "resolved_path_outside_root");
      assert.equal(escaped.resolvedPath, yield* fs.realPath(outsideFile));
      assert.equal(escaped.resolvedWorkspaceRoot, yield* fs.realPath(workspaceDir));
      assert.isDefined(escaped.cause);
    }

    const writeInput = {
      cwd: workspaceDir,
      relativePath: "nested/created.txt",
      contents: "written-by-rpc",
    };
    const deniedWrite = yield* reader[WS_METHODS.projectsWriteFile](writeInput).pipe(Effect.flip);
    if (deniedWrite._tag !== "EnvironmentAuthorizationError") return yield* Effect.die(deniedWrite);
    assert.equal(deniedWrite.requiredPermission, AuthFilesystemWriteScope);
    assert.equal(fileWrites, 0);
    assert.isFalse(yield* fs.exists(path.join(workspaceDir, "nested")));

    const writer = yield* makeClient("workspace-writer", [AuthFilesystemWriteScope]);
    assert.deepEqual(yield* writer[WS_METHODS.projectsWriteFile](writeInput), {
      relativePath: writeInput.relativePath,
    });
    assert.equal(
      yield* fs.readFileString(path.join(workspaceDir, writeInput.relativePath)),
      writeInput.contents,
    );

    const expectWriteFailure = (cwd: string, relativePath: string) =>
      writer[WS_METHODS.projectsWriteFile]({ ...writeInput, cwd, relativePath }).pipe(
        Effect.flip,
        Effect.filterOrElse(
          (error) => error._tag === "ProjectWriteFileError",
          (error) => Effect.die(error),
        ),
      );
    assert.equal(
      (yield* expectWriteFailure(outsideDir, "outside.txt")).failure,
      "workspace_path_outside_root",
    );
    const traversal = yield* expectWriteFailure(workspaceDir, "../outside/outside.txt");
    assert.equal(traversal.failure, "workspace_path_outside_root");
    assert.equal(traversal.cwd, workspaceDir);
    assert.equal(traversal.relativePath, "../outside/outside.txt");
    assert.equal(
      traversal.message,
      `Failed to write workspace file '../outside/outside.txt' in '${workspaceDir}'.`,
    );
    assert.isDefined(traversal.cause);
    assert.notProperty(traversal, "contents");
    if (hasDirectoryLink) {
      assert.equal(
        (yield* expectWriteFailure(workspaceDir, `${directoryLink}/outside.txt`)).failure,
        "resolved_path_outside_root",
      );
    }
    assert.equal(yield* fs.readFileString(outsideFile), "Outside fixture\n");
    assert.equal(
      (yield* expectWriteFailure(secretsDir, path.basename(privateFile))).failure,
      "workspace_path_outside_root",
    );
    assert.equal(yield* fs.readFileString(privateFile), privateContents);

    const notFile = yield* expectWriteFailure(workspaceDir, "src");
    assert.equal(notFile.failure, "path_not_file");
    assert.equal(notFile.resolvedPath, yield* fs.realPath(path.join(workspaceDir, "src")));
    assert.equal(
      yield* fs.readFileString(path.join(workspaceDir, "src", "index.ts")),
      "export const answer = 42;\n",
    );

    const failedWrite = yield* expectWriteFailure(workspaceDir, "failed-write.txt");
    const encodedWrite = (yield* encodeProjectWriteFileError(failedWrite));
    assert.equal(encodedWrite.failure, "operation_failed");
    assert.equal(encodedWrite.operation, "write-file");
    assert.notInclude(JSON.stringify(encodedWrite), writeInput.contents);

    const ignoredWorkspace = path.join(root, "ignored-workspace");
    yield* fs.makeDirectory(ignoredWorkspace);
    const vcs = yield* Effect.service(VcsProcess.VcsProcess).pipe(Effect.provide(VcsProcess.layer));
    const git = (args: ReadonlyArray<string>) => vcs.run({
      operation: "workspace search RPC fixture",
      command: "git",
      args,
      cwd: ignoredWorkspace,
    });
    yield* git(["init", "--quiet", "--template="]);
    yield* fs.makeDirectory(path.join(ignoredWorkspace, ".git", "info"), { recursive: true });
    yield* fs.makeDirectory(path.join(ignoredWorkspace, ".venv", "lib"), { recursive: true });
    yield* fs.makeDirectory(path.join(ignoredWorkspace, "src"));
    yield* fs.writeFileString(path.join(ignoredWorkspace, ".gitignore"), ".venv/\n");
    yield* fs.writeFileString(path.join(ignoredWorkspace, ".git", "info", "exclude"), "local-search-target.ts\n");
    yield* fs.writeFileString(path.join(ignoredWorkspace, ".venv", "lib", "ignored-search-target.ts"), "export {};\n");
    yield* fs.writeFileString(path.join(ignoredWorkspace, "local-search-target.ts"), "export {};\n");
    yield* fs.writeFileString(path.join(ignoredWorkspace, "src", "search-target.ts"), "export {};\n");
    yield* git(["add", "--force", "--", "src/search-target.ts"]);
    const ignoredSearchInput = { ...entryInput, cwd: ignoredWorkspace };
    assert.deepEqual(yield* reader[WS_METHODS.projectsSearchEntries]({
      ...ignoredSearchInput, query: "search-target",
    }), {
      entries: [{ path: "src/search-target.ts", kind: "file" }],
      truncated: false,
    });
    assert.deepEqual(yield* reader[WS_METHODS.projectsSearchEntries]({
      ...ignoredSearchInput, query: "ignored-search-target",
    }), { entries: [], truncated: false });

    const backendSearch = { ...searchInput, cwd: workspaceDir };
    const entryFailure = yield* reader[WS_METHODS.projectsSearchEntries](backendSearch).pipe(Effect.flip);
    const contentFailure = yield* reader[WS_METHODS.projectsSearchContents]({
      ...backendSearch, caseSensitive: false, wholeWord: false, useRegex: false,
    }).pipe(Effect.flip);
    if (entryFailure._tag !== "ProjectSearchEntriesError" || contentFailure._tag !== "ProjectSearchContentsError") {
      throw new Error("Expected typed index failures");
    }
    const encoded = [
      (yield* encodeProjectSearchEntriesError(entryFailure)),
      (yield* encodeProjectSearchContentsError(contentFailure)),
    ];
    for (const failure of encoded) {
      assert.equal(failure.failure, "search_index_search_failed");
      assert.equal(failure.queryLength, sensitiveQuery.length);
      assert.isDefined(failure.cause);
      assert.notInclude(JSON.stringify(failure), "Bearer");
      assert.notInclude(JSON.stringify(failure), "fixture-secret-token");
    }
  }).pipe(Effect.scoped, Effect.provide(layerWorkspaceFailureServices)),
);

it.effect("read-only config subscriptions isolate theme and usage-command opt-ins across live updates", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const serverBrowser = yield* ServerBrowser.ServerBrowser;
    const checkedAt = "2026-04-11T00:00:00.000Z";
    const codexDriver = ProviderDriverKind.make("codex");
    const codex: ServerProvider = {
      instanceId: ProviderInstanceId.make("codex"), driver: codexDriver,
      enabled: true, installed: true, version: "1.0.0", status: "ready",
      auth: { status: "authenticated" }, checkedAt, models: [], slashCommands: [], skills: [],
    };
    const claude: ServerProvider = {
      ...codex, instanceId: ProviderInstanceId.make("claude"), driver: ProviderDriverKind.make("claude"),
    };
    const providers = [codex, claude];
    const limits = {
      checkedAt,
      windows: [{ id: "weekly", kind: "weekly" as const, label: "Weekly", usedPercent: 25 }],
    };
    const source: UsageLimitSourceSnapshot = {
      id: UsageLimitSourceId.make("hub"), kind: "cliproxy", label: "Accounts", checkedAt,
      accounts: [{ id: "work", driver: codexDriver, usageLimits: limits }],
    };
    const published: ReadonlyArray<PublishedEnvironmentTheme> = [
      { id: "nightfall", name: "Nightfall", appearance: "dark", canvas: "#1a1b26", accent: "#7aa2f7" },
    ];
    const themeState = yield* SubscriptionRef.make(published);
    const sourceState = yield* SubscriptionRef.make<ReadonlyArray<UsageLimitSourceSnapshot>>([]);
    const sourceDelivered = yield* Queue.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>();
    const providerChanges = yield* PubSub.unbounded<ReadonlyArray<ServerProvider>>();
    const providerSubscribed = yield* Queue.unbounded<void>();
    const providerDelivered = yield* Queue.unbounded<void>();
    let themeSubscriptions = 0;
    let settingsWrites = 0;

    const services = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(BackgroundBrowser)({}),
      Layer.mock(MausbotService)({}),
      Layer.mock(V2RoutingOwner)({}),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(ExternalLauncher.ExternalLauncher)({
        resolveAvailableEditors: () => Effect.succeed([]),
        resolveFileManagerRevealKind: () => Effect.undefined,
      }),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({ resolveTargets: () => Effect.succeed([]) }),
      Layer.mock(DirectEndpoints.DirectEndpoints)({
        resolve: () => Effect.succeed([]),
        resolveAvailable: () => Effect.succeed([]),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: process.cwd(),
        scratchRoot: Effect.succeedNone,
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("config-subscription-fixture")),
        getDescriptor: Effect.succeed({
          environmentId: EnvironmentId.make("config-subscription-fixture"),
          label: "Config subscription fixture", platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0", capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        getDescriptor: () => Effect.succeed({
          policy: "loopback-browser", bootstrapMethods: [],
          sessionMethods: ["browser-session-cookie"], sessionCookieName: "config-test-session",
        }),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed(providers),
        streamChanges: Stream.unwrap(PubSub.subscribe(providerChanges).pipe(
          Effect.tap(() => Queue.offer(providerSubscribed, undefined)),
          Effect.map((subscription) => Stream.fromSubscription(subscription).pipe(
            Stream.tap(() => Queue.offer(providerDelivered, undefined)),
          )),
        )),
      }),
      Layer.mock(UsageLimitSources.UsageLimitSources)({
        current: SubscriptionRef.get(sourceState),
        streamChanges: SubscriptionRef.changes(sourceState).pipe(
          Stream.tap((value) => Queue.offer(sourceDelivered, value)),
        ),
      }),
      Layer.succeed(ServerSettings.ServerSettingsService, {
        ...settings,
        updateSettings: (patch) => Effect.sync(() => {
          settingsWrites++;
        }).pipe(Effect.andThen(settings.updateSettings(patch))),
      }),
      Layer.mock(EnvironmentTheme.EnvironmentThemeService)({
        current: SubscriptionRef.get(themeState),
        streamChanges: Stream.unwrap(Effect.sync(() => {
          themeSubscriptions++;
          return SubscriptionRef.changes(themeState);
        })),
      }),
      Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
      Layer.succeed(SqlClient.SqlClient, sql),
    );
    const scopes = [AuthOrchestrationReadScope] as const;
    const subscribe = (id: string, input: typeof WsSubscribeServerConfigRpc.payloadSchema.Type) =>
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WsRpcGroup.middleware(RpcInstrumentation)).pipe(
          Effect.provide(layerWsRpc(
            { sessionId: AuthSessionId.make(id), subject: "fixture", method: "browser-session-cookie", scopes },
            {}, serverBrowser, () => Effect.void, { secretReferences: true },
          ).pipe(
            Layer.provide(services),
            Layer.merge(RpcAuthorization.layer(scopes)),
            Layer.merge(rpcInstrumentationLayer),
          )),
        );
        const responses = yield* Queue.unbounded<ServerConfigStreamEvent>();
        yield* client[WS_METHODS.subscribeServerConfig](input).pipe(
          Stream.runForEach((event) => Queue.offer(responses, event)),
          Effect.forkScoped,
        );
        return { client, responses };
      });
    const { client: themeReader, responses: optedIn } = yield* subscribe("config-opt-in", {
      environmentThemes: true,
      usageLimitsCommand: true,
    });
    const { responses: ordinary } = yield* subscribe("config-ordinary", {});
    for (const responses of [optedIn, ordinary]) {
      const initial = yield* Queue.take(responses);
      if (initial.type !== "snapshot") return yield* Effect.die("Expected initial configuration");
      assert.deepEqual(initial.config.providers, providers);
      assert.isUndefined(initial.config.environmentThemes);
    }
    yield* Queue.take(providerSubscribed);
    yield* Queue.take(providerSubscribed);
    assert.deepEqual(yield* Queue.take(sourceDelivered), []);
    assert.deepEqual(yield* Queue.take(sourceDelivered), []);
    assert.deepEqual(yield* Queue.take(optedIn), {
      version: 1, type: "environmentThemesUpdated", payload: { themes: published },
    });
    assert.equal(themeSubscriptions, 1);

    const denied = yield* themeReader[WS_METHODS.serverUpdateSettings]({
      patch: { defaultProjectScripts: [] },
    }).pipe(Effect.flip);
    if (denied._tag !== "EnvironmentAuthorizationError") return yield* Effect.die(denied);
    assert.equal(denied.requiredPermission, AuthSettingsWriteScope);
    assert.equal(settingsWrites, 0);

    const updatedTheme = [{ ...published[0]!, name: "Nightfall updated" }];
    yield* SubscriptionRef.set(themeState, updatedTheme);
    assert.deepEqual(yield* Queue.take(optedIn), {
      version: 1, type: "environmentThemesUpdated", payload: { themes: updatedTheme },
    });

    yield* settings.updateSettings({ defaultTheme: "nightfall" });
    for (const responses of [optedIn, ordinary]) {
      const updated = yield* Queue.take(responses);
      if (updated.type !== "settingsUpdated") return yield* Effect.die("Expected a settings update");
      assert.equal(updated.payload.settings.defaultTheme, "nightfall");
    }

    // The provider registry has emitted nothing. The source alone adds the command.
    yield* SubscriptionRef.set(sourceState, [source]);
    assert.deepEqual(yield* Queue.take(sourceDelivered), [source]);
    assert.deepEqual(yield* Queue.take(sourceDelivered), [source]);
    yield* TestClock.adjust("1 second");
    assert.deepEqual(yield* Queue.take(optedIn), {
      version: 1, type: "providerStatuses",
      payload: { providers: [{ ...codex, slashCommands: [USAGE_LIMITS_COMMAND] }, claude] },
    });

    const changedQuota = {
      ...source,
      accounts: source.accounts.map((account) => ({
        ...account,
        usageLimits: {
          ...limits,
          windows: [{ ...limits.windows[0]!, usedPercent: 40 }],
        },
      })),
    };
    yield* SubscriptionRef.set(sourceState, [changedQuota]);
    assert.deepEqual(yield* Queue.take(sourceDelivered), [changedQuota]);
    assert.deepEqual(yield* Queue.take(sourceDelivered), [changedQuota]);
    yield* TestClock.adjust("1 second");
    assert.isTrue(Option.isNone(yield* Queue.poll(optedIn)));
    assert.isTrue(Option.isNone(yield* Queue.poll(ordinary)));

    // The next ordinary event is a real provider change, with no injected commands.
    const native = { ...claude, version: "1.0.1", usageLimits: limits };
    yield* PubSub.publish(providerChanges, [codex, native]);
    yield* Queue.take(providerDelivered);
    yield* Queue.take(providerDelivered);
    yield* TestClock.adjust("1 second");
    assert.deepEqual(yield* Queue.take(ordinary), {
      version: 1, type: "providerStatuses", payload: { providers: [codex, native] },
    });
    assert.deepEqual(yield* Queue.take(optedIn), {
      version: 1, type: "providerStatuses",
      payload: { providers: [
        { ...codex, slashCommands: [USAGE_LIMITS_COMMAND] },
        { ...native, slashCommands: [USAGE_LIMITS_COMMAND] },
      ] },
    });

    yield* SubscriptionRef.set(sourceState, []);
    assert.deepEqual(yield* Queue.take(sourceDelivered), []);
    assert.deepEqual(yield* Queue.take(sourceDelivered), []);
    yield* TestClock.adjust("1 second");
    assert.deepEqual(yield* Queue.take(optedIn), {
      version: 1, type: "providerStatuses",
      payload: { providers: [codex, { ...native, slashCommands: [USAGE_LIMITS_COMMAND] }] },
    });
    assert.isTrue(Option.isNone(yield* Queue.poll(ordinary)));

    // A provider status change still reaches both clients when it has no limits.
    const withoutNativeLimits = { ...claude, version: "1.0.2" };
    yield* PubSub.publish(providerChanges, [codex, withoutNativeLimits]);
    yield* Queue.take(providerDelivered);
    yield* Queue.take(providerDelivered);
    yield* TestClock.adjust("1 second");
    for (const responses of [optedIn, ordinary]) {
      assert.deepEqual(yield* Queue.take(responses), {
        version: 1, type: "providerStatuses",
        payload: { providers: [codex, withoutNativeLimits] },
      });
    }
  }).pipe(
    Effect.scoped,
    Effect.provide(ProjectionStore.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(layerConfigSources, Layer.mock(ServerBrowser.ServerBrowser)({}))),
    )),
  ),
);

it.effect.each(["available", "unavailable", "editors-blocked", "reveal-blocked", "not-offered"] as const)(
  "serves authorized configuration with %s file-manager discovery",
  (discovery) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const browser = yield* ServerBrowser.ServerBrowser;
      const settings = yield* ServerSettings.ServerSettingsService;
      const expectedSettings = ServerSettings.redactServerSettingsForClient(
        yield* settings.getSettings,
        { secretReferences: true },
      );
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const block = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      );
      let editorProbes = 0;
      let revealProbes = 0;
      const id = EnvironmentId.make("file-manager-config-fixture");
      const services = Layer.mergeAll(
        layerUnusedConfigRpcServices,
        Layer.mock(BackgroundBrowser)({}),
        Layer.mock(MausbotService)({}),
        Layer.mock(V2RoutingOwner)({}),
        Layer.mock(ExternalLauncher.ExternalLauncher)({
          resolveAvailableEditors: () =>
            Effect.suspend(() => {
              editorProbes++;
              if (discovery === "editors-blocked") return block;
              return Effect.succeed(
                discovery === "not-offered" ? ["vscode"] as const : ["file-manager"] as const,
              );
            }),
          resolveFileManagerRevealKind: () =>
            Effect.suspend(() => {
              revealProbes++;
              if (discovery === "reveal-blocked") return block;
              return Effect.succeed(discovery === "unavailable" ? undefined : "file-explorer");
            }),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(UsageLimitSources.UsageLimitSources)({}),
        Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({ resolveTargets: () => Effect.succeed([]) }),
        Layer.mock(DirectEndpoints.DirectEndpoints)({ resolve: () => Effect.succeed([]) }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/fixture",
          scratchRoot: Effect.succeedNone,
        }),
        Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(id),
          getDescriptor: Effect.succeed({
            environmentId: id,
            label: "File-manager fixture",
            platform: { os: "windows", arch: "x64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: false },
          }),
        }),
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          getDescriptor: () => Effect.succeed({
            policy: "desktop-managed-local",
            bootstrapMethods: ["desktop-bootstrap"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "file-manager-fixture",
          }),
        }),
        Layer.succeed(SqlClient.SqlClient, sql),
      );
      const makeClient = (
        subject: string,
        scopes: EnvironmentAuth.AuthenticatedSession["scopes"],
      ) =>
        RpcTest.makeClient(WsRpcGroup.middleware(RpcInstrumentation)).pipe(
          Effect.provide(layerWsRpc(
            { sessionId: AuthSessionId.make(subject), subject, method: "bearer-access-token", scopes },
            {},
            browser,
            () => Effect.void,
            { secretReferences: true },
          ).pipe(
            Layer.provide(services),
            Layer.merge(RpcAuthorization.layer(scopes)),
            Layer.merge(rpcInstrumentationLayer),
          )),
        );

      const manager = yield* makeClient("config-manager", [AuthAccessWriteScope]);
      const denied = yield* manager[WS_METHODS.serverGetConfig]({}).pipe(Effect.flip);
      if (denied._tag !== "EnvironmentAuthorizationError") return yield* Effect.die(denied);
      assert.equal(denied.requiredScope, AuthOrchestrationReadScope);
      assert.equal(editorProbes, 0);
      assert.equal(revealProbes, 0);

      const reader = yield* makeClient("config-reader", [AuthOrchestrationReadScope]);
      const configFiber = yield* reader[WS_METHODS.serverGetConfig]({}).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      const blocked = discovery === "editors-blocked" || discovery === "reveal-blocked";
      if (blocked) {
        yield* Deferred.await(started);
        assert.deepEqual(yield* reader[WS_METHODS.serverGetSettings]({}), expectedSettings);
        yield* TestClock.adjust("5 seconds");
        yield* Deferred.await(interrupted);
      }
      const config = yield* Fiber.join(configFiber);
      assert.equal(config.environment.environmentId, id);
      assert.deepEqual(config.settings, expectedSettings);
      assert.deepEqual(
        config.availableEditors,
        discovery === "editors-blocked" ? [] :
          discovery === "not-offered" ? ["vscode"] : ["file-manager"],
      );
      assert.equal(config.shellRevealInFileManager, discovery === "available" ? true : undefined);
      assert.equal(
        config.shellRevealInFileManagerKind,
        discovery === "available" ? "file-explorer" : undefined,
      );
      assert.equal(revealProbes, discovery === "editors-blocked" || discovery === "not-offered" ? 0 : 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(layerConfigSources, Layer.mock(ServerBrowser.ServerBrowser)({})),
      ),
    ),
);

it.effect.each([
  "pending",
  "cached",
  "direct-pending",
  "direct-cached",
  "direct-failed",
  "direct-interrupted",
] as const)(
  "%s endpoint discovery preserves initial config and updates through discovery and ACK",
  (discovery) =>
    Effect.gen(function* () {
      const keybindings = yield* Keybindings.Keybindings;
      const settings = yield* ServerSettings.ServerSettingsService;
      const config = yield* ServerConfigModule.ServerConfig;
      const otlp = {
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        otlpLogsUrl: "http://localhost:4318/v1/logs",
      };
      const keybindingsSubscribed = yield* Deferred.make<void>();
      const settingsSubscribed = yield* Deferred.make<void>();
      const keybindingsChanges = keybindings.subscribeChanges.pipe(
        Effect.tap(() => Deferred.succeed(keybindingsSubscribed, undefined)),
      );
      const settingsChanges = settings.subscribeChanges.pipe(
        Effect.tap(() => Deferred.succeed(settingsSubscribed, undefined)),
      );
      const initialKeybindings = (yield* keybindings.getSnapshot).keybindings;
      const discoveryStarted = yield* Deferred.make<void>();
      const finishDiscovery = yield* Deferred.make<void>();
      const remoteDiscoveryStarted = yield* Deferred.make<void>();
      const finishRemoteDiscovery = yield* Deferred.make<void>();
      const targets = [{ kind: "mdns" as const, host: "test.local" }];
      const direct = discovery.startsWith("direct-");
      const bound = [{ kind: "lan" as const, httpBaseUrl: "http://192.168.1.10:3773/" }];
      const endpoints = [
        ...bound,
        { kind: "tailnet" as const, httpBaseUrl: "https://test.ts.net/" },
      ];
      const directStarted = yield* Deferred.make<void>();
      const finishDirect = yield* Deferred.make<void>();
      const directStopped = yield* Deferred.make<void>();
      const responses = yield* Queue.unbounded<ServerConfigStreamEvent>();
      const configRpcServices = Layer.mergeAll(
        layerUnusedConfigRpcServices,
        Layer.succeed(ServerConfigModule.ServerConfig, { ...config, ...otlp }),
        Layer.mock(ExternalLauncher.ExternalLauncher)({
          resolveAvailableEditors: () =>
            Deferred.succeed(discoveryStarted, undefined).pipe(
              Effect.andThen(Deferred.await(finishDiscovery)),
              Effect.as([]),
            ),
          resolveFileManagerRevealKind: () => Effect.undefined,
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
          streamChanges: Stream.never,
        }),
        Layer.mock(UsageLimitSources.UsageLimitSources)({ streamChanges: Stream.make([]) }),
        Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({
          resolveTargets: () =>
            Deferred.succeed(remoteDiscoveryStarted, undefined).pipe(
              Effect.andThen(
                discovery === "cached" || direct
                  ? Effect.void
                  : Deferred.await(finishRemoteDiscovery),
              ),
              Effect.as(targets),
            ),
        }),
        Layer.mock(DirectEndpoints.DirectEndpoints)({
          resolveAvailable: () => Effect.succeed(discovery === "direct-cached" ? endpoints : bound),
          resolve: () =>
            direct
              ? Deferred.succeed(directStarted, undefined).pipe(
                  Effect.andThen(
                    discovery === "direct-cached" ? Effect.void : Deferred.await(finishDirect),
                  ),
                  Effect.andThen(
                    discovery === "direct-failed"
                      ? Effect.die("probe failed")
                      : Effect.succeed(endpoints),
                  ),
                  Effect.onExit(() => Deferred.succeed(directStopped, undefined)),
                )
              : Effect.succeed(bound),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          scratchRoot: Effect.succeedNone,
          namedProjectsRoot: process.cwd(),
        }),
        Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("ws-fixture")),
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("config-test"),
            label: "Config test",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0",
            capabilities: { repositoryIdentity: false },
          }),
        }),
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          getDescriptor: () =>
            Effect.succeed({
              policy: "loopback-browser",
              bootstrapMethods: [],
              sessionMethods: ["browser-session-cookie"],
              sessionCookieName: "config-test-session",
            }),
        }),
        // Signal subscription on either accessor so the test also fails, rather
        // than hangs, against a handler that subscribes after the snapshot.
        Layer.succeed(Keybindings.Keybindings, {
          ...keybindings,
          streamChanges: Stream.unwrap(keybindingsChanges),
          subscribeChanges: keybindingsChanges,
        }),
        Layer.succeed(ServerSettings.ServerSettingsService, {
          ...settings,
          streamChanges: Stream.unwrap(settingsChanges),
          subscribeChanges: settingsChanges,
        }),
      );
      const server = yield* RpcServer.makeNoSerialization(
        RpcGroup.make(WsSubscribeServerConfigRpc),
        {
          ...WS_RPC_SERVER_OPTIONS,
          onFromServer: (response) =>
            response._tag === "Chunk"
              ? Effect.forEach(response.values, (event) => Queue.offer(responses, event), {
                  discard: true,
                })
              : Effect.void,
        },
      ).pipe(
        Effect.provide(
          layerWsRpc(
            {
              sessionId: AuthSessionId.make("config-test"),
              subject: "config-test",
              method: "browser-session-cookie",
              scopes: [],
            },
            {},
            yield* ServerBrowser.ServerBrowser,
            () => Effect.void,
            { secretReferences: true },
          ).pipe(Layer.provide(configRpcServices)),
        ),
      );
      const requestId = RpcMessage.RequestId("config");
      const acknowledge = server.write(0, { _tag: "Ack", requestId });
      yield* server.write(0, {
        _tag: "Request",
        id: requestId,
        tag: WS_METHODS.subscribeServerConfig,
        payload: {},
        headers: Headers.empty,
      });
      yield* Deferred.await(discoveryStarted);
      assert.isTrue(yield* Deferred.isDone(remoteDiscoveryStarted));

      const duringDiscovery = yield* settings.updateSettings({ defaultAutoPull: true });
      yield* Deferred.succeed(finishDiscovery, undefined);
      const snapshot = yield* Queue.take(responses);
      assert.equal(snapshot.type, "snapshot");
      if (snapshot.type !== "snapshot") return yield* Effect.die("Missing initial snapshot");
      assert.equal(snapshot.version, 1);
      assert.include(snapshot.config.observability, {
        ...otlp,
        logsDirectoryPath: config.logsDir,
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpMetricsEnabled: true,
        otlpLogsEnabled: true,
      });
      assert.deepEqual(
        snapshot.config.remoteOpenTargets,
        discovery === "cached" || direct ? targets : [],
      );
      assert.deepEqual(
        snapshot.config.directEndpoints,
        discovery === "direct-cached" ? endpoints : bound,
      );
      assert.isFalse(snapshot.config.settings.defaultAutoPull);
      assert.deepEqual(snapshot.config.keybindings, initialKeybindings);
      const duringAck = yield* keybindings.upsertKeybindingRule({
        key: "mod+alt+y",
        command: "terminal.toggle",
      });
      yield* acknowledge;
      yield* Deferred.await(keybindingsSubscribed);
      yield* Deferred.await(settingsSubscribed);

      // Later updates expose a dropped buffered event as a value mismatch, not a timeout.
      const latestSettings = yield* settings.updateSettings({ enableProviderUpdateChecks: false });
      const latestKeybindings = yield* keybindings.upsertKeybindingRule({
        key: "mod+alt+z",
        command: "terminal.split",
      });
      const expectedSettings = [duringDiscovery, latestSettings].map((value) =>
        ServerSettings.redactServerSettingsForClient(value, { secretReferences: true }),
      );
      const expectedKeybindings = [duringAck.keybindings, latestKeybindings.keybindings];
      // The two sources can interleave, but each must retain its own publication order.
      for (let i = 0; i < 4; i++) {
        const event = yield* Queue.take(responses);
        if (event.type === "settingsUpdated") {
          assert.deepEqual(event.payload.settings, expectedSettings.shift());
        } else {
          assert.equal(event.type, "keybindingsUpdated");
          if (event.type !== "keybindingsUpdated")
            return yield* Effect.die("Unexpected config event");
          assert.deepEqual(event.payload.keybindings, expectedKeybindings.shift());
          assert.deepEqual(event.payload.issues, []);
        }
        yield* acknowledge;
      }
      assert.isEmpty(expectedSettings);
      assert.isEmpty(expectedKeybindings);
      if (discovery === "pending") {
        yield* Deferred.await(remoteDiscoveryStarted);
        yield* Deferred.succeed(finishRemoteDiscovery, undefined);
        const resolved = yield* Queue.take(responses);
        assert.equal(resolved.type, "snapshot");
        if (resolved.type !== "snapshot") return yield* Effect.die("Missing remote targets");
        assert.deepEqual(resolved.config.remoteOpenTargets, targets);
        assert.deepEqual(
          resolved.config.settings,
          ServerSettings.redactServerSettingsForClient(latestSettings, { secretReferences: true }),
        );
        assert.deepEqual(resolved.config.keybindings, latestKeybindings.keybindings);
        yield* acknowledge;
      }
      if (direct) {
        yield* Deferred.await(directStarted);
        if (discovery === "direct-pending") {
          yield* Deferred.succeed(finishDirect, undefined);
          const resolved = yield* Queue.take(responses);
          assert.equal(resolved.type, "snapshot");
          if (resolved.type !== "snapshot") return yield* Effect.die("Missing direct endpoints");
          assert.deepEqual(resolved.config.directEndpoints, endpoints);
          assert.deepEqual(
            resolved.config.settings,
            ServerSettings.redactServerSettingsForClient(latestSettings, {
              secretReferences: true,
            }),
          );
          assert.deepEqual(resolved.config.keybindings, latestKeybindings.keybindings);
          yield* acknowledge;
        } else if (discovery === "direct-failed") {
          yield* Deferred.succeed(finishDirect, undefined);
          yield* Deferred.await(directStopped);
          yield* settings.updateSettings({ defaultAutoPull: false });
          const event = yield* Queue.take(responses);
          assert.equal(event.type, "settingsUpdated");
          yield* acknowledge;
        }
      }
      yield* server.write(0, { _tag: "Interrupt", requestId, interruptors: [] });
      if (direct) yield* Deferred.await(directStopped);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.fresh(layerConfigSources),
          Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
          Layer.mock(ServerBrowser.ServerBrowser)({}),
        ),
      ),
    ),
);

it.effect("replays lifecycle snapshots and buffers live events published during capture", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const browser = yield* ServerBrowser.ServerBrowser;
    const lifecycle = yield* Effect.service(ServerLifecycleEvents.ServerLifecycleEvents).pipe(
      Effect.provide(ServerLifecycleEvents.layer),
    );
    const environment = {
      environmentId: EnvironmentId.make("lifecycle-fixture"),
      label: "Lifecycle fixture",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.0",
      capabilities: { repositoryIdentity: false },
    } as const;
    const welcomePayload = { environment, cwd: "/fixture", projectName: "Fixture" };
    const pending = yield* lifecycle.publish({
      version: 1,
      type: "welcome",
      payload: { ...welcomePayload, bootstrapStatus: "pending" },
    });
    const readyInput = {
      version: 1,
      type: "ready",
      payload: { at: "2026-01-01T00:00:00.000Z", environment },
    } as const;
    const completeInput = {
      version: 1,
      type: "welcome",
      payload: {
        ...welcomePayload,
        bootstrapStatus: "complete",
        bootstrapProjectId: ProjectId.make("lifecycle-project"),
        bootstrapThreadId: ThreadId.make("lifecycle-thread"),
        bootstrapProjectCreated: true,
        bootstrapThreadCreated: true,
      },
    } as const;
    const closed = yield* Queue.unbounded<void>();
    let snapshots = 0;
    const services = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(BackgroundBrowser)({}),
      Layer.mock(MausbotService)({}),
      Layer.mock(V2RoutingOwner)({}),
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(UsageLimitSources.UsageLimitSources)({}),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
      Layer.mock(DirectEndpoints.DirectEndpoints)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/fixture" }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(environment.environmentId),
      }),
      Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
      Layer.succeed(SqlClient.SqlClient, sql),
      Layer.succeed(ServerLifecycleEvents.ServerLifecycleEvents, {
        ...lifecycle,
        stream: lifecycle.stream.pipe(
          Stream.ensuring(Queue.offer(closed, undefined).pipe(Effect.asVoid)),
        ),
        snapshot: Effect.gen(function* () {
          if (++snapshots !== 1) return yield* lifecycle.snapshot;
          yield* lifecycle.publish(readyInput);
          const captured = yield* lifecycle.snapshot;
          yield* lifecycle.publish(completeInput);
          return captured;
        }),
      }),
    );
    const makeClient = (
      id: string,
      scopes: EnvironmentAuth.AuthenticatedSession["scopes"],
    ) =>
      RpcTest.makeClient(WsRpcGroup.middleware(RpcInstrumentation)).pipe(
        Effect.provide(layerWsRpc(
          { sessionId: AuthSessionId.make(id), subject: id, method: "bearer-access-token", scopes },
          {}, browser, () => Effect.void, { secretReferences: true },
        ).pipe(
          Layer.provide(services),
          Layer.merge(RpcAuthorization.layer(scopes)),
          Layer.merge(rpcInstrumentationLayer),
        )),
      );

    const deniedClient = yield* makeClient("lifecycle-denied", []);
    const denied = yield* deniedClient[WS_METHODS.subscribeServerLifecycle]({}).pipe(
      Stream.runHead,
      Effect.flip,
    );
    assert.equal(denied.requiredScope, AuthOrchestrationReadScope);
    assert.equal(snapshots, 0);

    const reader = yield* makeClient("lifecycle-reader", [AuthOrchestrationReadScope]);
    assert.deepEqual(yield* reader[WS_METHODS.serverProbe]({}), {});
    const received = yield* Queue.unbounded<ServerLifecycleStreamEvent>();
    const subscription = yield* reader[WS_METHODS.subscribeServerLifecycle]({}).pipe(
      Stream.runForEach((event) => Queue.offer(received, event)),
      Effect.forkScoped,
    );
    assert.deepEqual(yield* Queue.take(received), pending);
    assert.deepEqual(yield* Queue.take(received), { ...readyInput, sequence: 2 });
    // Ready arrived both in the live buffer and the snapshot. Deliver it only once.
    assert.deepEqual(yield* Queue.take(received), { ...completeInput, sequence: 3 });

    const latestReady = yield* lifecycle.publish({
      ...readyInput,
      payload: { ...readyInput.payload, at: "2026-01-01T00:00:01.000Z" },
    });
    assert.deepEqual(yield* Queue.take(received), latestReady);
    yield* Fiber.interrupt(subscription);
    yield* Queue.take(closed);

    const replayed = yield* reader[WS_METHODS.subscribeServerLifecycle]({}).pipe(
      Stream.take(2),
      Stream.runCollect,
    );
    assert.deepEqual(Array.from(replayed), [{ ...completeInput, sequence: 3 }, latestReady]);
    yield* Queue.take(closed);
    assert.equal(snapshots, 2);
  }).pipe(
    Effect.scoped,
    Effect.provide(ProjectionStore.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(layerConfigSources, Layer.mock(ServerBrowser.ServerBrowser)({}))),
    )),
  ),
);

it.effect("streams cached resource telemetry and releases sampling after the last reader", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const browser = yield* ServerBrowser.ServerBrowser;
    const samples = yield* PubSub.unbounded<NativeTelemetryClient.NativeTelemetrySnapshot>();
    const samplingStarted = yield* Queue.unbounded<void>();
    const samplingStopped = yield* Queue.unbounded<void>();
    const unsubscribed = yield* Queue.unbounded<void>();
    let subscriptionCount = 0;
    const telemetry = yield* ResourceTelemetry.make().pipe(
      Effect.provide(Layer.mergeAll(
        NativeTelemetryClient.layerTest({
          sampleNow: Effect.never,
          snapshots: Stream.unwrap(
            PubSub.subscribe(samples).pipe(
              Effect.tap(() => Queue.offer(samplingStarted, undefined)),
              Effect.map(Stream.fromSubscription),
            ),
          ).pipe(
            Stream.ensuring(Queue.offer(samplingStopped, undefined).pipe(Effect.asVoid)),
          ),
        }),
        DesktopTelemetryReceiver.layerTest(),
        ResourceAttribution.layer,
      )),
    );
    const services = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(BackgroundBrowser)({}),
      Layer.mock(MausbotService)({}),
      Layer.mock(V2RoutingOwner)({}),
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(UsageLimitSources.UsageLimitSources)({}),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
      Layer.mock(DirectEndpoints.DirectEndpoints)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/fixture" }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("resource-telemetry-fixture")),
      }),
      Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
      Layer.succeed(SqlClient.SqlClient, sql),
      Layer.succeed(ResourceTelemetry.ResourceTelemetry, ResourceTelemetry.ResourceTelemetry.of({
        ...telemetry,
        subscribe: Effect.gen(function* () {
          subscriptionCount++;
          yield* Effect.addFinalizer(() =>
            Queue.offer(unsubscribed, undefined).pipe(Effect.asVoid),
          );
          return yield* telemetry.subscribe;
        }),
      })),
    );
    const makeClient = (
      id: string,
      scopes: EnvironmentAuth.AuthenticatedSession["scopes"],
    ) =>
      RpcTest.makeClient(WsRpcGroup.middleware(RpcInstrumentation)).pipe(
        Effect.provide(layerWsRpc(
          { sessionId: AuthSessionId.make(id), subject: id, method: "bearer-access-token", scopes },
          {}, browser, () => Effect.void, { secretReferences: true },
        ).pipe(
          Layer.provide(services),
          Layer.merge(RpcAuthorization.layer(scopes)),
          Layer.merge(rpcInstrumentationLayer),
        )),
      );

    const reader = yield* makeClient("telemetry-unscoped", [AuthOrchestrationReadScope]);
    assert.deepEqual(yield* reader[WS_METHODS.serverProbe]({}), {});
    const denied = yield* reader[WS_METHODS.subscribeResourceTelemetry]({}).pipe(
      Stream.runHead,
      Effect.flip,
    );
    if (denied._tag !== "EnvironmentAuthorizationError") return yield* Effect.die(denied);
    assert.equal(denied.requiredPermission, AuthDiagnosticsReadScope);
    assert.equal(subscriptionCount, 0);

    const subscribe = (id: string) =>
      Effect.gen(function* () {
        const client = yield* makeClient(id, [AuthDiagnosticsReadScope]);
        const received = yield* Queue.unbounded<ResourceTelemetrySnapshot>();
        const fiber = yield* client[WS_METHODS.subscribeResourceTelemetry]({}).pipe(
          Stream.runForEach((snapshot) => Queue.offer(received, snapshot)),
          Effect.forkScoped,
        );
        return { received, fiber };
      });
    const publish = (sequence: number) =>
      PubSub.publish(samples, {
        generation: 0,
        snapshot: {
          version: 3,
          type: "snapshot",
          sequence,
          sampledAtUnixMs: 1_000 * sequence,
          collectionDurationMicros: 100,
          scannedProcessCount: sequence,
          retainedProcessCount: 0,
          inaccessibleProcessCount: 0,
          processes: [],
        },
      });

    const first = yield* subscribe("telemetry-first");
    const initial = yield* Queue.take(first.received);
    assert.deepEqual(initial.processes, []);
    assert.equal(initial.groups.backend.processCount, 0);
    yield* Queue.take(samplingStarted);

    const second = yield* subscribe("telemetry-second");
    assert.deepEqual(yield* Queue.take(second.received), initial);
    assert.equal(subscriptionCount, 2);
    assert.isTrue(Option.isNone(yield* Queue.poll(samplingStarted)));

    yield* publish(1);
    assert.equal((yield* Queue.take(first.received)).health.scannedProcessCount, 1);
    assert.equal((yield* Queue.take(second.received)).health.scannedProcessCount, 1);

    yield* Fiber.interrupt(first.fiber);
    yield* Queue.take(unsubscribed);
    assert.isTrue(Option.isNone(yield* Queue.poll(samplingStopped)));
    yield* publish(2);
    const cached = yield* Queue.take(second.received);
    assert.equal(cached.health.scannedProcessCount, 2);
    assert.isTrue(Option.isNone(yield* Queue.poll(first.received)));

    yield* Fiber.interrupt(second.fiber);
    yield* Queue.take(unsubscribed);
    yield* Queue.take(samplingStopped);

    const reconnect = yield* makeClient("telemetry-reconnect", [AuthDiagnosticsReadScope]);
    const head = yield* reconnect[WS_METHODS.subscribeResourceTelemetry]({}).pipe(
      Stream.runHead,
    );
    assert.deepEqual(Option.getOrThrow(head), cached);
    yield* Queue.take(unsubscribed);
    assert.equal(subscriptionCount, 3);
  }).pipe(
    Effect.scoped,
    Effect.provide(ProjectionStore.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(layerConfigSources, Layer.mock(ServerBrowser.ServerBrowser)({}))),
    )),
  ),
);

it.effect("streams relay installation progress only for an authorized writer", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const browser = yield* ServerBrowser.ServerBrowser;
    let installCalls = 0;
    const missing = { status: "missing", version: RelayClient.CLOUDFLARED_VERSION } as const;
    const installed = {
      status: "available",
      executablePath: "/fixture/tools/cloudflared",
      source: "managed",
      version: RelayClient.CLOUDFLARED_VERSION,
    } satisfies RelayClient.AvailableRelayClient;
    const services = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(BackgroundBrowser)({}),
      Layer.mock(MausbotService)({}),
      Layer.mock(V2RoutingOwner)({}),
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(UsageLimitSources.UsageLimitSources)({}),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
      Layer.mock(DirectEndpoints.DirectEndpoints)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/fixture" }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("relay-install-fixture")),
      }),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      Layer.mock(RelayClient.RelayClient)({
        resolve: Effect.succeed(missing),
        installWithProgress: (report) =>
          Effect.gen(function* () {
            installCalls++;
            yield* report({ type: "progress", stage: "checking" });
            yield* report({ type: "progress", stage: "downloading" });
            return installed;
          }),
      }),
      Layer.succeed(SqlClient.SqlClient, sql),
    );
    const makeClient = (
      id: string,
      scopes: EnvironmentAuth.AuthenticatedSession["scopes"],
    ) =>
      RpcTest.makeClient(WsRpcGroup.middleware(RpcInstrumentation)).pipe(
        Effect.provide(
          layerWsRpc(
            { sessionId: AuthSessionId.make(id), subject: id, method: "bearer-access-token", scopes },
            {},
            browser,
            () => Effect.void,
            { secretReferences: true },
          ).pipe(
            Layer.provide(services),
            Layer.merge(RpcAuthorization.layer(scopes)),
            Layer.merge(rpcInstrumentationLayer),
          ),
        ),
      );

    const reader = yield* makeClient("relay-reader", ["relay:read"]);
    assert.deepEqual(yield* reader[WS_METHODS.cloudGetRelayClientStatus]({}), missing);
    const denied = yield* reader[WS_METHODS.cloudInstallRelayClient]({}).pipe(
      Stream.runCollect,
      Effect.flip,
    );
    if (denied._tag !== "EnvironmentAuthorizationError") return yield* Effect.die(denied);
    assert.equal(denied.requiredScope, "relay:write");
    assert.equal(installCalls, 0);

    const owner = yield* makeClient("relay-owner", ["relay:read", "relay:write"]);
    const received = yield* owner[WS_METHODS.cloudInstallRelayClient]({}).pipe(Stream.runCollect);
    assert.deepEqual(Array.from(received), [
      { type: "progress", stage: "checking" },
      { type: "progress", stage: "downloading" },
      { type: "complete", status: installed },
    ]);
    assert.equal(installCalls, 1);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(layerConfigSources, Layer.mock(ServerBrowser.ServerBrowser)({})),
    ),
  ),
);

it.effect("serves signed host JPEG and video on their issuing environment without a local thread", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    const browser = yield* ServerBrowser.ServerBrowser;
    const signer = yield* AssetSigner.AssetSigner;
    const config = yield* ServerConfigModule.ServerConfig;
    const clock = yield* Clock.Clock;
    const fixtures = yield* fs.makeTempDirectoryScoped({ prefix: "j1-host-media-" });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 2, 0, 3]);
    const video = new Uint8Array([1, 2, 3, 4]);
    const html = "<p>draft</p>";
    yield* fs.writeFile(path.join(fixtures, "photo.jpeg"), jpeg);
    yield* fs.writeFile(path.join(fixtures, "recording.mp4"), video);
    yield* fs.writeFileString(path.join(fixtures, "note.html"), html);

    const threadId = ThreadId.make("thread-on-another-environment");
    const deleted = ThreadId.make("deleted-host-media-thread");
    const localThread = ThreadId.make("local-media-thread");
    const projectId = ProjectId.make("local-media-project");
    const at = "2026-08-31T12:00:00.000Z";
    const lookups: ThreadId[] = [];
    const services = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(BackgroundBrowser)({}),
      Layer.mock(MausbotService)({}),
      Layer.mock(V2RoutingOwner)({}),
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(UsageLimitSources.UsageLimitSources)({}),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
      Layer.mock(DirectEndpoints.DirectEndpoints)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/fixture" }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("ws-fixture")),
      }),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      Layer.succeed(SqlClient.SqlClient, sql),
      Layer.succeed(AssetSigner.AssetSigner, signer),
      Layer.succeed(ServerConfigModule.ServerConfig, config),
      Layer.succeed(ServerSettings.ServerSettingsService, yield* ServerSettings.ServerSettingsService),
      WorkspacePaths.layer,
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) => {
          assert.equal(id, projectId);
          return Effect.succeedSome({
            id, title: "Media fixture", workspaceRoot: fixtures, defaultModelSelection: null,
            scripts: [], createdAt: at, updatedAt: at, deletedAt: null,
          });
        },
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadRecords: (id, fields) => Effect.suspend(() => {
          lookups.push(id);
          assert.isEmpty(fields);
          if (id === localThread || id === deleted) {
            return Effect.succeed({
              thread: { id, projectId, worktreePath: null, deletedAt: id === deleted ? DateTime.makeUnsafe(at) : null },
            } as never);
          }
          return Effect.fail(new Orchestrator.OrchestratorProjectionError({
                threadId: id, cause: new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId: id }),
              }));
        }),
      }),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const makeClient = (id: string, scopes: EnvironmentAuth.AuthenticatedSession["scopes"]) =>
      RpcTest.makeClient(WsRpcGroup.middleware(RpcInstrumentation)).pipe(
        Effect.provide(layerWsRpc(
          { sessionId: AuthSessionId.make(id), subject: id, method: "bearer-access-token", scopes },
          {}, browser, () => Effect.void, { secretReferences: true },
        ).pipe(
          Layer.provide(services),
          Layer.merge(RpcAuthorization.layer(scopes)),
          Layer.merge(rpcInstrumentationLayer),
        )),
      );

    const renderApp = (key: AssetSigner.AssetSigner["Service"]) =>
      Effect.acquireRelease(
        Effect.sync(() => HttpRouter.toWebHandler(
          ServerHttp.layerAssetRoute.pipe(
            Layer.provideMerge(Layer.mergeAll(
              Layer.succeed(AssetSigner.AssetSigner, key),
              Layer.succeed(Clock.Clock, clock),
              Layer.succeed(ServerConfigModule.ServerConfig, config),
              Layer.mock(Orchestrator.OrchestratorV2)({}),
              Layer.mock(NativeAppIconResolver.NativeAppIconResolver)({}),
              Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
              Layer.succeed(BuiltInSourceControlDrivers.SourceControlDrivers, []),
              FetchHttpClient.layer,
              NodeHttpPlatform.layer,
              NodeServices.layer,
            )),
          ), { disableLogger: true },
        )),
        (app) => Effect.promise(() => app.dispose()),
      );
    const app = yield* renderApp(signer);
    const other = yield* Layer.build(Layer.fresh(layerConfigSources));
    const foreignApp = yield* renderApp(Context.get(other, AssetSigner.AssetSigner));
    const request = (url: string) => new Request(new URL(url, "http://127.0.0.1"));
    const workspaceContext = yield* Layer.build(WorkspacePaths.layer);
    const send = (target: Effect.Success<ReturnType<typeof renderApp>>, url: string) =>
      Effect.promise(() => target.handler(request(url), workspaceContext));
    const unprivileged = yield* makeClient("media-denied", [AuthOrchestrationReadScope]);
    const allowed = yield* makeClient("media-reader", [AuthFilesystemReadScope]);
    const absolute = { _tag: "media-file" as const, threadId, path: path.join(fixtures, "photo.jpeg") };
    const denied = yield* unprivileged[WS_METHODS.assetsCreateUrl]({ resource: absolute }).pipe(Effect.flip);
    if (denied._tag !== "EnvironmentAuthorizationError") return yield* Effect.die(denied);
    assert.equal(denied.requiredPermission, AuthFilesystemReadScope);

    for (const [name, mimeType, bytes] of [
      ["photo.jpeg", "image/jpeg", jpeg],
      ["recording.mp4", "video/mp4", video],
    ] as const) {
      const issued = yield* allowed[WS_METHODS.assetsCreateUrl]({
        resource: { ...absolute, path: path.join(fixtures, name) },
      });
      if (mimeType === "image/jpeg") assert.deepEqual(issued.imageDimensions, { width: 3, height: 2 });
      const response = yield* send(app, issued.relativeUrl);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), mimeType);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(new Uint8Array(yield* Effect.promise(() => response.arrayBuffer())), bytes);

      const foreign = yield* send(foreignApp, issued.relativeUrl);
      assert.equal(foreign.status, 404);
      const sibling = issued.relativeUrl.replace(/[^/]+$/, "note.html");
      const wrongPath = yield* send(app, sibling);
      assert.equal(wrongPath.status, 404);
    }

    const draft = yield* allowed[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "draft-workspace-file", cwd: fixtures, path: "note.html" },
    });
    const response = yield* send(app, draft.relativeUrl);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(yield* Effect.promise(() => response.text()), html);
    assert.isEmpty(lookups);

    for (const id of [threadId, deleted]) {
      const refused = yield* allowed[WS_METHODS.assetsCreateUrl]({
        resource: { ...absolute, threadId: id, path: "photo.jpeg" },
      }).pipe(Effect.flip);
      assert.equal(refused._tag, "AssetWorkspaceContextNotFoundError");
    }
    const relative = yield* allowed[WS_METHODS.assetsCreateUrl]({
      resource: { ...absolute, threadId: localThread, path: "photo.jpeg" },
    });
    const local = yield* send(app, relative.relativeUrl);
    assert.equal(local.status, 200);
    assert.deepEqual(new Uint8Array(yield* Effect.promise(() => local.arrayBuffer())), jpeg);
    assert.deepEqual(lookups, [threadId, deleted, localThread]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(layerConfigSources, Layer.mock(ServerBrowser.ServerBrowser)({})),
    ),
  ),
);

it.effect("uploads feedback only through the selected thread's live provider session", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const browser = yield* ServerBrowser.ServerBrowser;
    const threadId = ThreadId.make("feedback-thread");
    const missingId = ThreadId.make("missing-feedback-thread");
    const foreignId = ThreadId.make("foreign-feedback-thread");
    const driver = ProviderDriverKind.make("codex");
    const instanceId = ProviderInstanceId.make("codex-feedback-account");
    const sessionId = ProviderSessionId.make("feedback-session");
    const active = {
      id: ProviderThreadId.make("feedback-active"),
      appThreadId: threadId,
      driver,
      providerInstanceId: instanceId,
      providerSessionId: sessionId,
      nativeThreadRef: { driver, nativeId: "native-feedback", strength: "strong" as const },
    };
    const other = {
      ...active,
      id: ProviderThreadId.make("feedback-older"),
      providerSessionId: ProviderSessionId.make("older-feedback-session"),
    };
    const thread = {
      id: threadId, activeProviderThreadId: active.id as ProviderThreadId | null, deletedAt: null,
    };
    let projection = {
      thread: { ...thread, deletedAt: null as DateTime.Utc | null },
      providerThreads: [active, other],
    };
    const payload = { threadId, reason: "The agent stopped early." };
    const lookups: ThreadId[] = [];
    const sessions: ProviderSessionId[] = [];
    const uploads: unknown[] = [];
    const privateMarker = "private-fixture-workspace-and-account";
    const goodRuntime = {
      instanceId, driver, providerSessionId: sessionId,
      uploadFeedback: (input) => Effect.sync(() => {
        uploads.push(input);
        return { feedbackId: "codex-thread-feedback" };
      }),
    } satisfies Pick<ProviderAdapterV2SessionRuntime, "instanceId" | "driver" | "providerSessionId" | "uploadFeedback">;
    let runtime: Partial<ProviderAdapterV2SessionRuntime> | null = goodRuntime;
    const services = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(BackgroundBrowser)({}),
      Layer.mock(MausbotService)({}),
      Layer.mock(V2RoutingOwner)({}),
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(UsageLimitSources.UsageLimitSources)({}),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
      Layer.mock(DirectEndpoints.DirectEndpoints)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/fixture" }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("ws-fixture")),
      }),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadRecords: (id, fields) => Effect.suspend(() => {
          lookups.push(id);
          assert.deepEqual<readonly string[]>(fields, ["providerThreads"]);
          return id === missingId
            ? Effect.fail(new Orchestrator.OrchestratorProjectionError({
                threadId: id, cause: new Error("Projection failure", { cause: privateMarker }),
              }))
            : Effect.succeed(projection as never);
        }),
      }),
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
        get: (id) => Effect.sync(() => {
          sessions.push(id);
          return Option.fromNullishOr(runtime as ProviderAdapterV2SessionRuntime | null);
        }),
      }),
      Layer.succeed(SqlClient.SqlClient, sql),
    );
    const makeClient = (id: string, scopes: EnvironmentAuth.AuthenticatedSession["scopes"]) =>
      RpcTest.makeClient(WsRpcGroup.middleware(RpcInstrumentation)).pipe(
        Effect.provide(layerWsRpc(
          { sessionId: AuthSessionId.make(id), subject: id, method: "bearer-access-token", scopes },
          {}, browser, () => Effect.void, { secretReferences: true },
        ).pipe(
          Layer.provide(services),
          Layer.merge(RpcAuthorization.layer(scopes)),
          Layer.merge(rpcInstrumentationLayer),
        )),
      );
    const reader = yield* makeClient("feedback-reader", [AuthOrchestrationReadScope]);
    const denied = yield* reader[WS_METHODS.providerUploadFeedback](payload).pipe(Effect.flip);
    if (denied._tag !== "EnvironmentAuthorizationError") return yield* Effect.die(denied);
    assert.equal(denied.requiredScope, AuthOrchestrationOperateScope);
    assert.isEmpty(lookups);

    const operator = yield* makeClient("feedback-operator", [
      AuthOrchestrationReadScope, AuthOrchestrationOperateScope,
    ]);
    const feedbackErrorJson = Schema.fromJsonString(ProviderUploadFeedbackError);
    const encodeFeedbackError = Schema.encodeEffect(feedbackErrorJson);
    const decodeFeedbackError = Schema.decodeEffect(feedbackErrorJson);
    const expectFeedbackError = (id: ThreadId, cause: string) =>
      Effect.gen(function* () {
        const error = yield* operator[WS_METHODS.providerUploadFeedback]({ threadId: id }).pipe(
          Effect.flip,
        );
        if (error._tag !== "ProviderUploadFeedbackError") return yield* Effect.die(error);
        const encoded = yield* encodeFeedbackError(error);
        assert.notInclude(encoded, privateMarker);
        const decoded = yield* decodeFeedbackError(encoded);
        assert.equal(decoded._tag, "ProviderUploadFeedbackError");
        assert.equal(decoded.threadId, id);
        assert.equal(decoded.message, `Failed to upload feedback for thread ${id}.`);
        assert.equal(decoded.cause, cause);
      });

    yield* expectFeedbackError(missingId, "The requested thread is unavailable.");
    projection = { ...projection, thread: { ...thread, deletedAt: DateTime.makeUnsafe(0) } };
    yield* expectFeedbackError(threadId, "The requested thread is unavailable.");
    projection = { thread, providerThreads: [{ ...active, appThreadId: foreignId }] };
    yield* expectFeedbackError(threadId, "The requested thread is unavailable.");
    projection = { thread, providerThreads: [] };
    yield* expectFeedbackError(threadId, "No provider session has run in this thread yet.");
    assert.isEmpty(sessions);

    projection = { thread, providerThreads: [active, other] };
    runtime = null;
    yield* expectFeedbackError(threadId, "The provider session is no longer running. Send a message first.");
    runtime = { ...goodRuntime, instanceId: ProviderInstanceId.make("other-codex-account") };
    yield* expectFeedbackError(threadId, "The provider session does not match this thread.");
    const { uploadFeedback: _uploadFeedback, ...unavailable } = goodRuntime;
    runtime = unavailable;
    yield* expectFeedbackError(threadId, "Provider 'codex' does not support feedback uploads.");
    assert.isEmpty(uploads);

    runtime = {
      ...goodRuntime,
      uploadFeedback: () => Effect.fail(new ProviderAdapterProtocolError({
        driver, detail: privateMarker, payload: { workspace: privateMarker },
      })),
    };
    yield* expectFeedbackError(threadId, "The provider could not upload thread feedback.");

    runtime = goodRuntime;
    assert.deepEqual(yield* operator[WS_METHODS.providerUploadFeedback](payload), {
      feedbackId: "codex-thread-feedback",
    });
    projection = {
      thread: { ...thread, activeProviderThreadId: null },
      providerThreads: [other, active],
    };
    assert.deepEqual(yield* operator[WS_METHODS.providerUploadFeedback]({ threadId }), {
      feedbackId: "codex-thread-feedback",
    });
    assert.deepEqual(uploads, [
      { providerThread: active, reason: payload.reason },
      { providerThread: active },
    ]);
    assert.isTrue(sessions.every((id) => id === sessionId));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(layerConfigSources, Layer.mock(ServerBrowser.ServerBrowser)({})),
    ),
  ),
);

it.effect("preserves structured agent import refusals and scanner counts at the RPC boundary", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const browser = yield* ServerBrowser.ServerBrowser;
    const projectId = ProjectId.make("agent-import-rpc-project");
    const missingId = ProjectId.make("missing-import-project");
    const workspaceRoot = "/fixture/import-workspace";
    const at = "2026-08-31T12:00:00.000Z";
    const project = {
      id: projectId, title: "Agent import", workspaceRoot, defaultModelSelection: null,
      scripts: [], createdAt: at, updatedAt: at, deletedAt: null,
    } as const;
    const scanResult = {
      candidates: [{
        path: workspaceRoot, title: project.title, projectId, sources: ["codex"],
        threadCount: 2, lastActiveAt: at, alreadyImported: true,
      }],
      scannedAt: at,
      truncated: true,
    } as const;
    const lookedUp: ProjectId[] = [];
    const scanned: string[] = [];
    const deps = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(BackgroundBrowser)({}),
      Layer.mock(MausbotService)({}),
      Layer.mock(V2RoutingOwner)({}),
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(UsageLimitSources.UsageLimitSources)({}),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
      Layer.mock(DirectEndpoints.DirectEndpoints)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/fixture" }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("ws-fixture")),
      }),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      Layer.mock(EventSink.EventSinkV2)({}),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
      IdAllocator.layer,
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
      Layer.mock(ThreadCommandExecutor.ThreadCommandExecutor)({}),
      Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
        list: () => Effect.succeed([]),
      }),
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) => Effect.sync(() => {
          lookedUp.push(id);
          return id === projectId ? Option.some(project) : Option.none();
        }),
      }),
      Layer.mock(AgentSessionScanner.AgentSessionScanner)({
        scan: Effect.succeed(scanResult),
        recentThreads: (root) => Stream.unwrap(Effect.sync(() => {
          scanned.push(root);
          return Stream.succeed({ _tag: "Skipped" } as const);
        })),
      }),
      Layer.succeed(SqlClient.SqlClient, sql),
    );
    const services = AgentSessionImporter.layer.pipe(Layer.provideMerge(deps));
    const makeClient = (id: string, scopes: EnvironmentAuth.AuthenticatedSession["scopes"]) =>
      RpcTest.makeClient(WsRpcGroup.middleware(RpcInstrumentation)).pipe(
        Effect.provide(layerWsRpc(
          { sessionId: AuthSessionId.make(id), subject: id, method: "bearer-access-token", scopes },
          {}, browser, () => Effect.void, { secretReferences: true },
        ).pipe(
          Layer.provide(services),
          Layer.merge(RpcAuthorization.layer(scopes)),
          Layer.merge(rpcInstrumentationLayer),
        )),
      );
    const reader = yield* makeClient("agent-import-reader", [AuthOrchestrationReadScope]);
    assert.deepEqual(yield* reader[WS_METHODS.agentSessionsScan]({}), scanResult);
    const denied = yield* reader[WS_METHODS.agentSessionsImport]({ projectId }).pipe(Effect.flip);
    if (denied._tag !== "EnvironmentAuthorizationError") return yield* Effect.die(denied);
    assert.equal(denied.requiredScope, AuthOrchestrationOperateScope);
    assert.isEmpty(lookedUp);

    const operator = yield* makeClient("agent-import-operator", [
      AuthOrchestrationReadScope, AuthOrchestrationOperateScope,
    ]);
    const missing = yield* operator[WS_METHODS.agentSessionsImport]({
      projectId: missingId,
    }).pipe(Effect.flip);
    if (missing._tag !== "AgentSessionImportProjectNotFoundError") return yield* Effect.die(missing);
    assert.equal(missing.projectId, missingId);
    const stale = yield* operator[WS_METHODS.agentSessionsImport]({
      projectId, expectedWorkspaceRoot: "/fixture/stale-workspace",
    }).pipe(Effect.flip);
    if (stale._tag !== "AgentSessionImportProjectChangedError") return yield* Effect.die(stale);
    assert.equal(stale.projectId, projectId);
    assert.deepEqual(lookedUp, [missingId, projectId]);
    assert.isEmpty(scanned);
    assert.deepEqual(
      yield* operator[WS_METHODS.agentSessionsImport]({ projectId, expectedWorkspaceRoot: workspaceRoot }),
      { importedCount: 0, skippedCount: 1 },
    );
    assert.deepEqual(scanned, [workspaceRoot]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(layerConfigSources, Layer.mock(ServerBrowser.ServerBrowser)({})),
    ),
  ),
);

it.effect("persists keybinding RPC edits only for settings writers in the connected environment", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfigModule.ServerConfig;
    const keybindings = yield* Keybindings.Keybindings;
    const localServices = yield* Effect.context<
      | FileSystem.FileSystem
      | ServerConfigModule.ServerConfig
      | Keybindings.Keybindings
      | ServerSettings.ServerSettingsService
      | SqlClient.SqlClient
    >();
    const other = yield* Layer.build(Layer.fresh(layerConfigSources));
    const otherConfig = Context.get(other, ServerConfigModule.ServerConfig);
    const otherKeybindings = Context.get(other, Keybindings.Keybindings);
    assert.notEqual(config.keybindingsConfigPath, otherConfig.keybindingsConfigPath);

    const rule = { key: "ctrl+k", command: "terminal.toggle" } as const;
    const neighbor = { key: "mod+alt+z", command: "terminal.split" } as const;
    const original = JSON.stringify([neighbor]);
    yield* fs.writeFileString(config.keybindingsConfigPath, original);
    yield* fs.writeFileString(otherConfig.keybindingsConfigPath, original);
    const otherSnapshot = yield* otherKeybindings.getSnapshot;
    const changes = yield* keybindings.subscribeChanges;
    const services = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(BackgroundBrowser)({}),
      Layer.mock(MausbotService)({}),
      Layer.mock(V2RoutingOwner)({}),
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(UsageLimitSources.UsageLimitSources)({}),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
      Layer.mock(DirectEndpoints.DirectEndpoints)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/fixture" }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("keybinding-rpc-fixture")),
      }),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      Layer.succeedContext(localServices),
    );
    const browser = yield* ServerBrowser.ServerBrowser;
    const makeClient = (id: string, scopes: EnvironmentAuth.AuthenticatedSession["scopes"]) =>
      RpcTest.makeClient(WsRpcGroup.middleware(RpcInstrumentation)).pipe(
        Effect.provide(layerWsRpc(
          { sessionId: AuthSessionId.make(id), subject: id, method: "bearer-access-token", scopes },
          {}, browser, () => Effect.void, { secretReferences: true },
        ).pipe(
          Layer.provide(services),
          Layer.merge(RpcAuthorization.layer(scopes)),
          Layer.merge(rpcInstrumentationLayer),
        )),
      );

    const reader = yield* makeClient("keybinding-reader", [AuthOrchestrationReadScope]);
    const writer = yield* makeClient("keybinding-writer", [
      AuthOrchestrationReadScope,
      AuthOrchestrationOperateScope,
      AuthSettingsWriteScope,
    ]);
    const readConfig = fs.readFileString(config.keybindingsConfigPath);
    const decodeRules = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.Unknown)));
    for (const denied of yield* Effect.all([
      reader[WS_METHODS.serverUpsertKeybinding](rule).pipe(Effect.flip),
      reader[WS_METHODS.serverRemoveKeybinding](neighbor).pipe(Effect.flip),
    ])) {
      if (denied._tag !== "EnvironmentAuthorizationError") return yield* Effect.die(denied);
      assert.equal(denied.requiredPermission, AuthSettingsWriteScope);
    }
    assert.equal(yield* readConfig, original);
    assert.deepEqual(
      yield* reader[WS_METHODS.serverGetSettings]({}),
      yield* writer[WS_METHODS.serverGetSettings]({}),
    );

    const saved = yield* writer[WS_METHODS.serverUpsertKeybinding](rule);
    assert.isEmpty(saved.issues);
    assert.ok(saved.keybindings.some(({ command, shortcut }) =>
      command === rule.command && shortcut.key === "k" && shortcut.ctrlKey
    ));
    assert.deepEqual((yield* decodeRules(yield* readConfig)), [neighbor, rule]);

    const removed = yield* writer[WS_METHODS.serverRemoveKeybinding](rule);
    assert.isEmpty(removed.issues);
    assert.isFalse(removed.keybindings.some(({ command, shortcut }) =>
      command === rule.command && shortcut.key === "k" && shortcut.ctrlKey
    ));
    assert.deepEqual((yield* decodeRules(yield* readConfig)), [neighbor]);
    assert.deepEqual(
      Array.from(yield* changes.pipe(Stream.take(2), Stream.runCollect)),
      [saved, removed],
    );

    const malformed = "{ not-json";
    yield* fs.writeFileString(config.keybindingsConfigPath, malformed);
    for (const invalid of yield* Effect.all([
      writer[WS_METHODS.serverUpsertKeybinding](rule).pipe(Effect.flip),
      writer[WS_METHODS.serverRemoveKeybinding](neighbor).pipe(Effect.flip),
    ])) {
      if (invalid._tag !== "KeybindingsConfigParseError") return yield* Effect.die(invalid);
      assert.equal(invalid.configPath, config.keybindingsConfigPath);
      assert.equal(invalid.detail, "expected JSON array");
    }
    assert.equal(yield* readConfig, malformed);
    assert.equal(yield* fs.readFileString(otherConfig.keybindingsConfigPath), original);
    assert.deepEqual(yield* otherKeybindings.getSnapshot, otherSnapshot);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(layerConfigSources, Layer.mock(ServerBrowser.ServerBrowser)({})),
    ),
  ),
);

class AuthInventoryTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.auth,
) {}

it.effect("preserves client and pairing inventory privacy across scoped sessions", () =>
  Effect.gen(function* () {
    const fixtureCredential = "inventory-desktop-bootstrap";
    const nodeServices = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
    const layerConfig = Layer.effect(
      ServerConfigModule.ServerConfig,
      Effect.gen(function* () {
        const config = yield* ServerConfigModule.ServerConfig;
        return {
          ...config,
          mode: "desktop" as const,
          host: "0.0.0.0",
          desktopBootstrapToken: fixtureCredential,
        };
      }),
    ).pipe(
      Layer.provide(
        ServerConfigModule.layerTest(process.cwd(), { prefix: "j1-auth-inventory-" }),
      ),
    );
    const layerAuth = EnvironmentAuth.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          SqlitePersistence.layerMemory,
          ServerSecretStore.layer,
          ServerEnvironment.layerIdentity,
        ).pipe(Layer.provideMerge(layerConfig)),
      ),
      Layer.provideMerge(AssetSigner.layer.pipe(
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(layerConfig),
      )),
      Layer.provideMerge(nodeServices),
    );
    const shared = yield* Layer.build(layerAuth);
    const auth = Context.get(shared, EnvironmentAuth.EnvironmentAuth);
    const clock = yield* Clock.Clock;
    const routes = HttpApiBuilder.layer(AuthInventoryTestApi).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
      Layer.provideMerge(HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak))),
      Layer.provideMerge(Layer.succeedContext(shared)),
      Layer.provideMerge(Layer.succeed(Clock.Clock, clock)),
    );
    const http = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      (app) => Effect.promise(() => app.dispose()),
    );
    const random = yield* SecureRandom.SecureRandom;
    const requestContext = shared.pipe(
      Context.add(SecureRandom.SecureRandom, random),
      Context.add(Clock.Clock, clock),
    );
    const origin = "http://127.0.0.1";
    const jsonRequest = (
      path: string,
      body: unknown,
      headers?: Readonly<Record<string, string>>,
    ) =>
      new Request(origin + path, {
        method: "POST",
        headers: { host: "127.0.0.1", "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const send = (request: Request) =>
      Effect.promise(() => http.handler(request, requestContext));

    const pairedScopes = [
      AuthOrchestrationReadScope,
      AuthOrchestrationOperateScope,
      "terminal:operate",
    ] as const;
    const ownerBootstrap = yield* send(
      jsonRequest("/api/auth/browser-session", { credential: fixtureCredential }),
    );
    assert.equal(ownerBootstrap.status, 200);
    const ownerCookie = ownerBootstrap.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";
    const ownerHeaders = { cookie: ownerCookie };
    const pairing = yield* send(
      jsonRequest("/api/auth/pairing-token", { scopes: pairedScopes }, ownerHeaders),
    );
    assert.equal(pairing.status, 200);
    const { credential } = (yield* Effect.promise(() => pairing.json())) as { credential: string };
    const mobile = {
      label: "J1 Code Mobile",
      deviceType: "mobile",
      os: "iOS",
      ipAddress: "127.0.0.1",
      userAgent: "undici",
    } as const;

    // The in-process HTTP adapter has no socket. Set its source request's peer
    // address so the real token endpoint reads the same address as the Node adapter.
    const exchangeRequest = Object.assign(
      new Request(origin + "/oauth/token", {
        method: "POST",
        headers: { host: "127.0.0.1", "user-agent": mobile.userAgent },
        body: new URLSearchParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: credential,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
          scope: pairedScopes.join(" "),
          client_label: mobile.label,
          client_device_type: mobile.deviceType,
          client_os: mobile.os,
        }),
      }),
      { remoteAddress: mobile.ipAddress },
    );
    const exchanged = yield* send(exchangeRequest);
    assert.equal(exchanged.status, 200);
    const bearer = (yield* Effect.promise(() => exchanged.json())) as {
      access_token: string;
      token_type: string;
      scope: string;
    };
    assert.equal(bearer.token_type, "Bearer");
    assert.equal(bearer.scope, pairedScopes.join(" "));
    const mobileHeaders = { authorization: `Bearer ${bearer.access_token}` };

    const upgradeRequest = (headers: Readonly<Record<string, string>>) =>
      HttpServerRequest.fromWeb(new Request(origin + "/ws", { headers }));
    const missing = yield* auth.authenticateWebSocketUpgrade(upgradeRequest({}), "rpc").pipe(Effect.flip);
    assert.equal(missing._tag, "ServerAuthMissingCredentialError");
    const owner = yield* auth.authenticateWebSocketUpgrade(upgradeRequest(ownerHeaders), "rpc");
    const paired = yield* auth.authenticateWebSocketUpgrade(upgradeRequest(mobileHeaders), "rpc");
    assert.equal(owner.subject, "desktop-bootstrap");
    assert.equal(paired.subject, "one-time-token");
    assert.notEqual(paired.sessionId, owner.sessionId);

    const foreign = Context.get(
      yield* Layer.build(Layer.fresh(layerAuth)),
      EnvironmentAuth.EnvironmentAuth,
    );
    const foreignBearer = yield* foreign.issueSession({
      subject: "other-environment",
      scopes: [AuthAccessReadScope],
    });
    const rejected = yield* auth.authenticateWebSocketUpgrade(
      upgradeRequest({ authorization: `Bearer ${foreignBearer.token}` }),
      "rpc",
    ).pipe(Effect.flip);
    assert.equal(rejected._tag, "ServerAuthInvalidCredentialError");

    const unrelated = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(BackgroundBrowser)({}),
      Layer.mock(MausbotService)({}),
      Layer.mock(V2RoutingOwner)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: process.cwd() }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(UsageLimitSources.UsageLimitSources)({}),
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
      Layer.mock(DirectEndpoints.DirectEndpoints)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Context.get(shared, ServerEnvironment.ServerEnvironmentIdentity).getEnvironmentId,
      }),
      Keybindings.layer,
      ServerSettings.layerTest(),
    ).pipe(Layer.provide(Layer.succeedContext(shared)));
    const rpcServices = Layer.merge(unrelated, Layer.succeedContext(shared));
    const browser = yield* Effect.service(ServerBrowser.ServerBrowser).pipe(
      Effect.provide(Layer.mock(ServerBrowser.ServerBrowser)({})),
    );
    const makeClient = (session: EnvironmentAuth.AuthenticatedSession) =>
      RpcTest.makeClient(WsRpcGroup.middleware(RpcInstrumentation)).pipe(
        Effect.provide(layerWsRpc(
          session, {}, browser, () => Effect.void, { secretReferences: true },
        ).pipe(
          Layer.provide(rpcServices),
          Layer.merge(RpcAuthorization.layer(session.scopes)),
          Layer.merge(rpcInstrumentationLayer),
        )),
      );

    const pairedClient = yield* makeClient(paired);
    const refused = yield* pairedClient[WS_METHODS.subscribeAuthAccess]({}).pipe(
      Stream.runHead,
      Effect.flip,
    );
    if (refused._tag !== "EnvironmentAuthorizationError") {
      return yield* Effect.die(refused);
    }
    assert.equal(refused.requiredScope, AuthAccessReadScope);
    const permitted = yield* send(jsonRequest("/api/auth/workspace-credential", {}, mobileHeaders));
    assert.equal(permitted.status, 200);

    const ownerClient = yield* makeClient(owner);
    const snapshot = yield* ownerClient[WS_METHODS.subscribeAuthAccess]({}).pipe(
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
    if (snapshot.type !== "snapshot") return yield* Effect.die("Expected auth inventory snapshot");
    const { clientSessions } = snapshot.payload;
    assert.deepEqual(
      clientSessions.filter((entry) => entry.current).map((entry) => entry.sessionId),
      [owner.sessionId],
    );
    const mobileEntry = clientSessions.find((entry) => entry.sessionId === paired.sessionId);
    if (!mobileEntry) return yield* Effect.die("HTTP-issued mobile session missing from inventory");
    assert.equal(mobileEntry.current, false);
    assert.equal(mobileEntry.subject, "one-time-token");
    assert.equal(mobileEntry.method, "bearer-access-token");
    assert.deepEqual(mobileEntry.scopes, pairedScopes);
    assert.deepEqual(mobileEntry.permissions, pairedScopes);
    assert.deepInclude(mobileEntry.client, mobile);
    assert.isFalse(clientSessions.some((entry) => entry.sessionId === foreignBearer.sessionId));

    const managerPairing = yield* send(
      jsonRequest("/api/auth/pairing-token", { scopes: [AuthAccessWriteScope] }, ownerHeaders),
    );
    assert.equal(managerPairing.status, 200);
    const { credential: managerCredential } = (yield* Effect.promise(
      () => managerPairing.json(),
    )) as { credential: string };
    const exchangePairing = (credential: string, scope?: string) =>
      send(new Request(origin + "/oauth/token", {
        method: "POST",
        headers: { host: "127.0.0.1" },
        body: new URLSearchParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: credential,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
          ...(scope ? { scope } : {}),
        }),
      }));
    const managerExchange = yield* exchangePairing(managerCredential, AuthAccessWriteScope);
    assert.equal(managerExchange.status, 200);
    const managerBearer = (yield* Effect.promise(() => managerExchange.json())) as {
      access_token: string;
      scope: string;
    };
    assert.equal(managerBearer.scope, AuthAccessWriteScope);
    const managerHeaders = { authorization: `Bearer ${managerBearer.access_token}` };

    const overbroad = yield* send(jsonRequest("/api/auth/pairing-token", {}, managerHeaders));
    assert.equal(overbroad.status, 403);
    const overbroadError = (yield* Effect.promise(() => overbroad.json())) as {
      code: string;
      requiredScope: string;
    };
    assert.equal(overbroadError.code, "insufficient_scope");
    assert.equal(overbroadError.requiredScope, AuthOrchestrationReadScope);
    const delegated = yield* send(jsonRequest(
      "/api/auth/pairing-token", { scopes: [AuthAccessWriteScope] }, managerHeaders,
    ));
    assert.equal(delegated.status, 200);

    const issueTicket = (headers: Record<string, string>) =>
      Effect.gen(function* () {
        const response = yield* send(new Request(origin + "/api/auth/websocket-ticket/rpc", {
          method: "POST",
          headers,
        }));
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const { ticket } = (yield* Effect.promise(() => response.json())) as { ticket: string };
        const upgradeUrl = new URL("/ws", origin);
        upgradeUrl.searchParams.set("wsTicket", ticket);
        upgradeUrl.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
        return HttpServerRequest.fromWeb(new Request(upgradeUrl, { headers: { host: "127.0.0.1" } }));
      });
    const managerUpgrade = yield* issueTicket(managerHeaders);
    const wrongAudience = yield* auth.authenticateWebSocketUpgrade(managerUpgrade, "media").pipe(Effect.flip);
    assert.equal(wrongAudience._tag, "ServerAuthInvalidCredentialError");
    const manager = yield* auth.authenticateWebSocketUpgrade(managerUpgrade, "rpc");
    assert.deepEqual(manager.scopes, [AuthAccessWriteScope]);
    const managerClient = yield* makeClient(manager);
    const forbiddenConfig = yield* managerClient[WS_METHODS.serverGetConfig]({}).pipe(Effect.flip);
    if (forbiddenConfig._tag !== "EnvironmentAuthorizationError") return yield* Effect.die(forbiddenConfig);
    assert.equal(forbiddenConfig.requiredScope, AuthOrchestrationReadScope);
    const forbiddenInventory = yield* managerClient[WS_METHODS.subscribeAuthAccess]({}).pipe(
      Stream.runHead,
      Effect.flip,
    );
    if (forbiddenInventory._tag !== "EnvironmentAuthorizationError") {
      return yield* Effect.die(forbiddenInventory);
    }
    assert.equal(forbiddenInventory.requiredScope, AuthAccessReadScope);

    const queryOnlySession = new URL("/ws", origin);
    queryOnlySession.searchParams.set(
      ORCHESTRATION_PROTOCOL_QUERY_PARAM,
      String(ORCHESTRATION_PROTOCOL_VERSION),
    );
    for (const token of [
      ownerCookie.slice(ownerCookie.indexOf("=") + 1),
      bearer.access_token,
    ]) {
      assert.isNotEmpty(token);
      queryOnlySession.searchParams.set("token", token);
      const rejected = yield* auth.authenticateWebSocketUpgrade(
        HttpServerRequest.fromWeb(new Request(queryOnlySession)),
        "rpc",
      ).pipe(Effect.flip);
      assert.equal(rejected._tag, "ServerAuthMissingCredentialError");
    }

    const pairedUpgrade = yield* issueTicket(mobileHeaders);
    const reader = yield* auth.authenticateWebSocketUpgrade(pairedUpgrade, "rpc");
    assert.equal(reader.sessionId, paired.sessionId);
    const readerClient = yield* makeClient(reader);
    assert.deepEqual(
      yield* readerClient[WS_METHODS.serverGetSettings]({}),
      yield* pairedClient[WS_METHODS.serverGetSettings]({}),
    );

    const revoked = yield* send(jsonRequest(
      "/api/auth/clients/revoke", { sessionId: manager.sessionId }, ownerHeaders,
    ));
    assert.equal(revoked.status, 200);
    assert.equal(
      (yield* auth.authenticateWebSocketUpgrade(managerUpgrade, "rpc").pipe(Effect.flip))._tag,
      "ServerAuthInvalidCredentialError",
    );
    assert.equal(
      (yield* auth.authenticateWebSocketUpgrade(pairedUpgrade, "rpc")).sessionId,
      paired.sessionId,
    );

    const issuePairing = (label: string, scopes?: string[]) =>
      Effect.gen(function* () {
        const response = yield* send(jsonRequest("/api/auth/pairing-token", {
          label, ...(scopes ? { scopes } : {}),
        }, ownerHeaders));
        assert.equal(response.status, 200);
        return (yield* Effect.promise(() => response.json())) as {
          id: string;
          credential: string;
        };
      });
    const accessLink = yield* issuePairing("Inventory reader", [AuthAccessReadScope]);
    const accessToken = yield* exchangePairing(accessLink.credential);
    assert.equal(accessToken.status, 200);
    const accessBearer = (yield* Effect.promise(() => accessToken.json())) as { access_token: string };
    const accessHeaders = { authorization: `Bearer ${accessBearer.access_token}` };
    const accessUpgrade = yield* issueTicket(accessHeaders);
    const accessSession = yield* auth.authenticateWebSocketUpgrade(accessUpgrade, "rpc");
    assert.deepEqual(accessSession.scopes, [AuthAccessReadScope]);
    const accessClient = yield* makeClient(accessSession);
    const readerCannotIssue = yield* send(jsonRequest("/api/auth/pairing-token", {}, accessHeaders));
    assert.equal(readerCannotIssue.status, 403);
    const issueRefusal = (yield* Effect.promise(() => readerCannotIssue.json())) as {
      requiredScope: string;
    };
    assert.equal(issueRefusal.requiredScope, AuthAccessWriteScope);

    const initialLink = yield* issuePairing("Initial fixture link");
    const events = yield* Queue.unbounded<AuthAccessStreamEvent>();
    yield* accessClient[WS_METHODS.subscribeAuthAccess]({}).pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkScoped({ startImmediately: true }),
    );
    const initial = yield* Queue.take(events);
    if (initial.type !== "snapshot") return yield* Effect.die("Expected pairing inventory snapshot");
    const listed = initial.payload.pairingLinks.find((link) => link.id === initialLink.id);
    if (!listed) return yield* Effect.die("Initial pairing link missing from inventory");
    assert.equal(listed.label, "Initial fixture link");
    assert.deepEqual(listed.permissions, AuthStandardClientScopes);
    assert.notInclude(JSON.stringify(initial), '"credential"');
    assert.notInclude(JSON.stringify(initial), initialLink.credential);
    assert.notInclude(JSON.stringify(initial), accessLink.credential);

    const liveLink = yield* issuePairing("Live fixture link");
    const live = yield* Queue.take(events);
    if (live.type !== "pairingLinkUpserted") return yield* Effect.die("Expected pairing link update");
    assert.equal(live.payload.id, liveLink.id);
    assert.equal(live.payload.label, "Live fixture link");
    assert.deepEqual(live.payload.permissions, AuthStandardClientScopes);
    assert.notInclude(JSON.stringify(live), '"credential"');
    assert.notInclude(JSON.stringify(live), liveLink.credential);
    assert.equal((yield* exchangePairing(liveLink.id)).status, 401);

    const revokeLink = (headers: Record<string, string>) =>
      send(jsonRequest("/api/auth/pairing-links/revoke", { id: initialLink.id }, headers));
    const readerCannotRevoke = yield* revokeLink(accessHeaders);
    assert.equal(readerCannotRevoke.status, 403);
    const ownerRevoked = yield* revokeLink(ownerHeaders);
    assert.equal(ownerRevoked.status, 200);
    assert.deepEqual(yield* Effect.promise(() => ownerRevoked.json()), { revoked: true });
    const removed = yield* Queue.take(events);
    if (removed.type !== "pairingLinkRemoved") return yield* Effect.die("Expected pairing link removal");
    assert.equal(removed.payload.id, initialLink.id);
    assert.equal((yield* exchangePairing(initialLink.credential)).status, 401);

    const foreignLink = yield* foreign.issuePairingCredential();
    assert.equal((yield* exchangePairing(foreignLink.credential)).status, 401);
    const redeemed = yield* exchangePairing(liveLink.credential);
    assert.equal(redeemed.status, 200);
    const liveBearer = (yield* Effect.promise(() => redeemed.json())) as { scope: string };
    assert.equal(liveBearer.scope, AuthStandardClientScopes.join(" "));
    assert.equal((yield* exchangePairing(liveLink.credential)).status, 401);

    const revokeOthers = yield* send(jsonRequest("/api/auth/clients/revoke-others", {}, ownerHeaders));
    assert.equal(revokeOthers.status, 200);
    assert.deepEqual(yield* Effect.promise(() => revokeOthers.json()), { revokedCount: 3 });
    for (const upgrade of [accessUpgrade, pairedUpgrade]) {
      const revoked = yield* auth.authenticateWebSocketUpgrade(upgrade, "rpc").pipe(Effect.flip);
      assert.equal(revoked._tag, "ServerAuthInvalidCredentialError");
    }
    assert.equal(
      (yield* auth.authenticateWebSocketUpgrade(upgradeRequest(ownerHeaders), "rpc")).sessionId,
      owner.sessionId,
    );
    const final = yield* ownerClient[WS_METHODS.subscribeAuthAccess]({}).pipe(
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
    if (final.type !== "snapshot") return yield* Effect.die("Expected inventory after peer revocation");
    assert.deepEqual(
      final.payload.clientSessions.map((entry) => ({ id: entry.sessionId, current: entry.current })),
      [{ id: owner.sessionId, current: true }],
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

it.effect("access changes made while the snapshot loads reach the client after it", () =>
  Effect.gen(function* () {
    const pairingChanges = yield* PubSub.unbounded<PairingGrantStore.BootstrapCredentialChange>();
    const sessionChanges = yield* PubSub.unbounded<SessionStore.SessionCredentialChange>();
    const subscribed = yield* Queue.unbounded<void>();
    const subscribe = <A>(changes: PubSub.PubSub<A>) =>
      Stream.unwrap(
        PubSub.subscribe(changes).pipe(
          Effect.tap(() => Queue.offer(subscribed, undefined)),
          Effect.map(Stream.fromSubscription),
        ),
      );
    const revokedElsewhere = AuthSessionId.make("revoked-elsewhere");
    const responses = yield* Queue.unbounded<AuthAccessStreamEvent>();
    const server = yield* RpcServer.makeNoSerialization(WsRpcGroup, {
      ...WS_RPC_SERVER_OPTIONS,
      onFromServer: (response) =>
        response._tag === "Chunk"
          ? Effect.forEach(
              response.values,
              (event) => Queue.offer(responses, event as AuthAccessStreamEvent),
              {
                discard: true,
              },
            )
          : Effect.void,
    }).pipe(
      Effect.provide(
        layerWsRpc(
          {
            sessionId: AuthSessionId.make("current"),
            subject: "current",
            method: "browser-session-cookie",
            scopes: [],
          },
          {},
          yield* ServerBrowser.ServerBrowser,
          () => Effect.void,
          { secretReferences: true },
        ).pipe(
          Layer.merge(RpcAuthorization.layer([AuthAccessReadScope])),
          Layer.provide(
            Layer.mergeAll(
              layerUnusedConfigRpcServices,
              Layer.mock(ExternalLauncher.ExternalLauncher)({}),
              Layer.mock(ProviderRegistry.ProviderRegistry)({}),
              Layer.mock(UsageLimitSources.UsageLimitSources)({}),
              Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
              Layer.mock(DirectEndpoints.DirectEndpoints)({}),
              Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                namedProjectsRoot: "/unused",
              }),
              Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
              Layer.mock(ServerEnvironment.ServerEnvironment)({
                getEnvironmentId: Effect.succeed(EnvironmentId.make("ws-fixture")),
              }),
              Layer.mock(EnvironmentAuth.EnvironmentAuth)({
                listPairingLinks: () => Effect.succeed([]),
                listConnectDevices: () => Effect.succeed([]),
                // Another client revokes a session after the snapshot read it.
                listClientSessions: () =>
                  PubSub.publish(sessionChanges, {
                    type: "clientRemoved",
                    sessionId: revokedElsewhere,
                  }).pipe(Effect.as([])),
              }),
              Layer.mock(PairingGrantStore.PairingGrantStore)({
                streamChanges: subscribe(pairingChanges),
              }),
              Layer.mock(SessionStore.SessionStore)({
                cookieName: "auth-access-test",
                legacyCookieName: undefined,
                streamChanges: subscribe(sessionChanges),
              }),
            ),
          ),
        ),
      ),
    );
    const requestId = RpcMessage.RequestId("auth-access");
    yield* server.write(0, {
      _tag: "Request",
      id: requestId,
      tag: WS_METHODS.subscribeAuthAccess,
      payload: {},
      headers: Headers.empty,
    });
    const snapshot = yield* Queue.take(responses);
    assert.equal(snapshot.type, "snapshot");
    yield* server.write(0, { _tag: "Ack", requestId });
    yield* Queue.take(subscribed);
    yield* Queue.take(subscribed);

    // A later change arrives either way, so a dropped revocation fails as a mismatch.
    yield* PubSub.publish(pairingChanges, { type: "pairingLinkRemoved", id: "later" });
    const next = yield* Queue.take(responses);
    assert.deepEqual(next, {
      version: 1,
      revision: 2,
      type: "clientRemoved",
      payload: { sessionId: revokedElsewhere },
    });
    yield* server.write(0, { _tag: "Ack", requestId });
    assert.equal((yield* Queue.take(responses)).type, "pairingLinkRemoved");
    yield* server.write(0, { _tag: "Ack", requestId });

    // Device trust has no incremental event, so a change re-sends the whole snapshot.
    yield* PubSub.publish(pairingChanges, { type: "connectDevicesChanged" });
    assert.deepEqual(yield* Queue.take(responses), {
      version: 1,
      revision: 4,
      type: "snapshot",
      payload: { pairingLinks: [], clientSessions: [], connectDevices: [] },
    });
    yield* server.write(0, { _tag: "Interrupt", requestId, interruptors: [] });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.fresh(layerConfigSources),
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
        Layer.mock(ServerBrowser.ServerBrowser)({}),
      ),
    ),
  ),
);

it.effect("on-demand clients get provider config without workspace snapshots", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const snapshotFor = (cwd: string, checkedAt: string) => ({
      cwd,
      checkedAt,
      slashCommands: [{ name: `${cwd.slice(1)}-command` }],
      skills: [],
    });
    const provider: ServerProvider = {
      instanceId,
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-25T00:00:00.000Z",
      models: [],
      slashCommands: [{ name: "machine-command", description: "A machine command" }],
      skills: [
        {
          name: "machine-skill",
          description: "Machine skill",
          path: "/skills/machine-skill",
          enabled: true,
        },
      ],
      workspaceSnapshots: [
        snapshotFor("/a", "2026-10-25T00:00:00.000Z"),
        snapshotFor("/b", "2026-10-25T00:00:00.000Z"),
      ],
    };
    let scansCwd = true;
    const refreshCalls: string[] = [];
    let registryProviders: ReadonlyArray<ServerProvider> = [provider];
    const providerChanges = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
    const pulled = yield* Queue.unbounded<void>();
    const responses = yield* Queue.unbounded<unknown>();
    const configRpcServices = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(ExternalLauncher.ExternalLauncher)({
        resolveAvailableEditors: () => Effect.succeed([]),
        resolveFileManagerRevealKind: () => Effect.undefined,
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.sync(() => registryProviders),
        streamChanges: Stream.fromQueue(providerChanges).pipe(
          Stream.tap(() => Queue.offer(pulled, undefined)),
        ),
        invalidateModelCaches: (input) => Effect.sync(() => {
          refreshCalls.push(`invalidate:${input.instanceId ?? "all"}`);
        }),
        refresh: () => Effect.sync(() => {
          refreshCalls.push("probe:all");
          return registryProviders;
        }),
        refreshInstance: (id) => Effect.sync(() => {
          refreshCalls.push(`probe:${id}`);
          return registryProviders;
        }),
        refreshWorkspaceSnapshot: () => Effect.sync(() => registryProviders),
      }),
      Layer.mock(ProjectService.ProjectService)({
        workspaceScanDirectory: (cwd) => Effect.succeed(cwd),
      }),
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        listInstances: Effect.sync(() => [
          (scansCwd
            ? { instanceId, snapshotForCwd: () => Effect.die("unused") }
            : { instanceId }) as never,
        ]),
        getInstance: () =>
          Effect.sync(
            () =>
              (scansCwd
                ? { instanceId, snapshotForCwd: () => Effect.die("unused") }
                : { instanceId }) as never,
          ),
      }),
      Layer.mock(UsageLimitSources.UsageLimitSources)({
        current: Effect.succeed([]),
        streamChanges: Stream.make([]),
        refresh: Effect.void,
      }),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({
        resolveTargets: () => Effect.succeed([]),
      }),
      Layer.mock(DirectEndpoints.DirectEndpoints)({
        resolve: () => Effect.succeed([]),
        resolveAvailable: () => Effect.succeed([]),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        scratchRoot: Effect.succeedNone,
        namedProjectsRoot: process.cwd(),
      }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("ws-fixture")),
        getDescriptor: Effect.succeed({
          environmentId: EnvironmentId.make("config-test"),
          label: "Config test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        getDescriptor: () =>
          Effect.succeed({
            policy: "loopback-browser",
            bootstrapMethods: [],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "config-test-session",
          }),
      }),
    );
    const server = yield* RpcServer.makeNoSerialization(
      RpcGroup.make(WsSubscribeServerConfigRpc, WsServerRefreshProvidersRpc),
      {
        ...WS_RPC_SERVER_OPTIONS,
        onFromServer: (response) =>
          response._tag === "Chunk"
            ? Effect.forEach(response.values, (value) => Queue.offer(responses, value), {
                discard: true,
              })
            : response._tag === "Exit" && response.exit._tag === "Success"
              ? Queue.offer(responses, response.exit.value)
              : Effect.void,
      },
    ).pipe(
      Effect.provide(
        layerWsRpc(
          {
            sessionId: AuthSessionId.make("config-test"),
            subject: "config-test",
            method: "browser-session-cookie",
            scopes: [],
          },
          {},
          yield* ServerBrowser.ServerBrowser,
          () => Effect.void,
          { secretReferences: true },
        ).pipe(Layer.provide(configRpcServices)),
      ),
    );
    const firstConnection = RpcMessage.RequestId("before-reconnect");
    yield* server.write(1, {
      _tag: "Request",
      id: firstConnection,
      tag: WS_METHODS.subscribeServerConfig,
      payload: { workspaceSnapshotsOnDemand: true, providerCatalogsOnDemand: true },
      headers: Headers.empty,
    });
    const beforeReconnect = (yield* Queue.take(responses)) as ServerConfigStreamEvent;
    if (beforeReconnect.type !== "snapshot") return yield* Effect.die("Missing pre-reconnect snapshot");
    assert.deepEqual(refreshCalls, []);
    yield* server.write(1, { _tag: "Interrupt", requestId: firstConnection, interruptors: [] });

    const configRequest = RpcMessage.RequestId("config");
    yield* server.write(0, {
      _tag: "Request",
      id: configRequest,
      tag: WS_METHODS.subscribeServerConfig,
      payload: { workspaceSnapshotsOnDemand: true, providerCatalogsOnDemand: true },
      headers: Headers.empty,
    });
    const snapshot = (yield* Queue.take(responses)) as ServerConfigStreamEvent;
    if (snapshot.type !== "snapshot") return yield* Effect.die("Missing initial snapshot");
    assert.deepEqual(snapshot.config.providers, beforeReconnect.config.providers);
    assert.deepEqual(refreshCalls, []);
    assert.isUndefined(snapshot.config.providers[0]?.workspaceSnapshots);
    // The cwd snapshot the client fetches carries the catalog, so only command names are sent.
    assert.deepEqual(snapshot.config.providers[0]?.slashCommands, [{ name: "machine-command" }]);
    assert.deepEqual(snapshot.config.providers[0]?.skills, [
      { name: "machine-skill", path: "/skills/machine-skill", enabled: true },
    ]);
    yield* server.write(0, { _tag: "Ack", requestId: configRequest });

    // A rescan that only touches a snapshot sends nothing; the next real change does.
    yield* Queue.offer(providerChanges, [
      { ...provider, workspaceSnapshots: [snapshotFor("/a", "2026-10-25T00:05:00.000Z")] },
    ]);
    yield* Queue.take(pulled);
    yield* TestClock.adjust("1 second");
    // Late /usage-limits discovery still reaches the client, so it refetches its cwd snapshot.
    yield* Queue.offer(providerChanges, [
      {
        ...provider,
        status: "warning",
        slashCommands: [...provider.slashCommands, USAGE_LIMITS_COMMAND],
      },
    ]);
    yield* Queue.take(pulled);
    yield* TestClock.adjust("1 second");
    const update = (yield* Queue.take(responses)) as ServerConfigStreamEvent;
    if (update.type !== "providerStatuses") return yield* Effect.die("Expected provider update");
    assert.equal(update.payload.providers[0]?.status, "warning");
    assert.isUndefined(update.payload.providers[0]?.workspaceSnapshots);
    assert.deepEqual(update.payload.providers[0]?.slashCommands, [
      { name: "machine-command" },
      { name: USAGE_LIMITS_COMMAND.name },
    ]);
    yield* server.write(0, { _tag: "Ack", requestId: configRequest });
    // A replacement that cannot scan a cwd sends its full machine catalog.
    scansCwd = false;
    yield* Queue.offer(providerChanges, [{ ...provider, status: "warning" }]);
    yield* Queue.take(pulled);
    yield* TestClock.adjust("1 second");
    const replaced = (yield* Queue.take(responses)) as ServerConfigStreamEvent;
    if (replaced.type !== "providerStatuses") return yield* Effect.die("Expected provider update");
    assert.deepEqual(replaced.payload.providers[0]?.slashCommands, provider.slashCommands);
    assert.deepEqual(replaced.payload.providers[0]?.skills, provider.skills);

    yield* server.write(0, {
      _tag: "Request",
      id: RpcMessage.RequestId("refresh"),
      tag: WS_METHODS.serverRefreshProviders,
      payload: { instanceId, cwd: "/b", workspaceSnapshotsOnDemand: true },
      headers: Headers.empty,
    });
    const refreshed = (yield* Queue.take(responses)) as {
      readonly providers: ReadonlyArray<ServerProvider>;
    };
    assert.deepEqual(
      refreshed.providers.map((entry) => [entry.workspaceSnapshots, entry.slashCommands]),
      [[[snapshotFor("/b", "2026-10-25T00:00:00.000Z")], []]],
    );
    // A failed scan still gives a client without the machine catalog its commands.
    scansCwd = true;
    yield* server.write(0, {
      _tag: "Request",
      id: RpcMessage.RequestId("refresh-failed-scan"),
      tag: WS_METHODS.serverRefreshProviders,
      payload: {
        instanceId,
        cwd: "/c",
        workspaceSnapshotsOnDemand: true,
        providerCatalogsOnDemand: true,
      },
      headers: Headers.empty,
    });
    const fallback = (yield* Queue.take(responses)) as {
      readonly providers: ReadonlyArray<ServerProvider>;
    };
    assert.deepEqual(fallback.providers[0]?.workspaceSnapshots, [
      {
        cwd: "/c",
        checkedAt: provider.checkedAt,
        slashCommands: provider.slashCommands,
        slashCommandsPending: true,
        skills: provider.skills,
      },
    ]);
    yield* server.write(0, { _tag: "Interrupt", requestId: configRequest, interruptors: [] });

    // A client that takes digests and deltas, against a catalog of over 200 KB.
    const heavy: ServerProvider = {
      ...provider,
      slashCommands: Array.from({ length: 250 }, (_, index) => ({
        name: `command-${index}`,
        description: "d".repeat(400),
      })),
      skills: Array.from({ length: 200 }, (_, index) => ({
        name: `skill-${index}`,
        description: "d".repeat(500),
        path: `/home/user/.claude/skills/skill-${index}/SKILL.md`,
        enabled: true,
      })),
    };
    registryProviders = [heavy];
    const lightRequest = RpcMessage.RequestId("light-config");
    yield* server.write(0, {
      _tag: "Request",
      id: lightRequest,
      tag: WS_METHODS.subscribeServerConfig,
      payload: {
        workspaceSnapshotsOnDemand: true,
        providerCatalogsOnDemand: true,
        providerCatalogDigests: true,
        providerStatusDeltas: true,
      },
      headers: Headers.empty,
    });
    const light = (yield* Queue.take(responses)) as ServerConfigStreamEvent;
    if (light.type !== "snapshot") return yield* Effect.die("Missing light snapshot");
    const digest = light.config.providers[0]?.catalogDigest;
    assert.isString(digest);
    assert.deepEqual(
      [light.config.providers[0]?.slashCommands, light.config.providers[0]?.skills],
      [[], []],
    );
    // Budget for the first config a phone decodes: the catalog stays out of it.
    assert.isBelow(JSON.stringify(light.config.providers).length, 1024);
    yield* server.write(0, { _tag: "Ack", requestId: lightRequest });

    // A health check sends the provider without the lists the client already holds.
    yield* Queue.offer(providerChanges, [{ ...heavy, checkedAt: "2026-10-25T00:10:00.000Z" }]);
    yield* Queue.take(pulled);
    yield* TestClock.adjust("1 second");
    const delta = (yield* Queue.take(responses)) as ServerConfigStreamEvent;
    if (delta.type !== "providerStatusDeltas") return yield* Effect.die("Expected provider deltas");
    assert.deepEqual(
      delta.payload.providers.map((entry) => [
        entry.checkedAt,
        entry.catalogDigest,
        entry.models,
        entry.slashCommands,
        entry.skills,
      ]),
      [["2026-10-25T00:10:00.000Z", digest, undefined, undefined, undefined]],
    );
    yield* server.write(0, { _tag: "Ack", requestId: lightRequest });

    // A changed description changes the digest, so the client loads the lists again.
    yield* Queue.offer(providerChanges, [
      {
        ...heavy,
        checkedAt: "2026-10-25T00:20:00.000Z",
        skills: heavy.skills.map((skill, index) =>
          index === 0 ? { ...skill, description: "changed" } : skill,
        ),
      },
    ]);
    yield* Queue.take(pulled);
    yield* TestClock.adjust("1 second");
    const redescribed = (yield* Queue.take(responses)) as ServerConfigStreamEvent;
    if (redescribed.type !== "providerStatusDeltas") {
      return yield* Effect.die("Expected provider deltas");
    }
    assert.notEqual(redescribed.payload.providers[0]?.catalogDigest, digest);
    yield* server.write(0, { _tag: "Ack", requestId: lightRequest });

    // A caller that only waits for a machine refresh gets no provider list back.
    yield* server.write(0, {
      _tag: "Request",
      id: RpcMessage.RequestId("refresh-omitted"),
      tag: WS_METHODS.serverRefreshProviders,
      payload: { workspaceSnapshotsOnDemand: true, omitProviders: true },
      headers: Headers.empty,
    });
    assert.deepEqual(yield* Queue.take(responses), { providers: [] });

    // The cwd snapshot brings the lists the digest stands for, under the same digest.
    yield* server.write(0, {
      _tag: "Request",
      id: RpcMessage.RequestId("refresh-machine-catalog"),
      tag: WS_METHODS.serverRefreshProviders,
      payload: {
        instanceId,
        cwd: "/b",
        workspaceSnapshotsOnDemand: true,
        providerCatalogsOnDemand: true,
        omitProviders: true,
        machineCatalog: true,
      },
      headers: Headers.empty,
    });
    const loaded = (yield* Queue.take(responses)) as {
      readonly providers: ReadonlyArray<ServerProvider>;
    };
    assert.equal(loaded.providers[0]?.catalogDigest, digest);
    assert.deepEqual(loaded.providers[0]?.slashCommands[0], { name: "command-0" });
    assert.deepEqual(loaded.providers[0]?.skills[0], {
      name: "skill-0",
      path: "/home/user/.claude/skills/skill-0/SKILL.md",
      enabled: true,
    });
    assert.lengthOf(loaded.providers[0]?.workspaceSnapshots ?? [], 1);
    for (const [name, payload, expected] of [
      ["background", {}, ["probe:all"]],
      ["targeted", { instanceId, refreshModels: true }, [`invalidate:${instanceId}`, `probe:${instanceId}`]],
      ["all", { refreshModels: true }, ["invalidate:all", "probe:all"]],
    ] as const) {
      refreshCalls.length = 0;
      yield* server.write(0, {
        _tag: "Request",
        id: RpcMessage.RequestId(`refresh-order-${name}`),
        tag: WS_METHODS.serverRefreshProviders,
        payload,
        headers: Headers.empty,
      });
      const result = yield* Queue.take(responses);
      assert.deepEqual(result, { providers: registryProviders });
      assert.deepEqual(refreshCalls, [...expected]);
    }
    yield* server.write(0, { _tag: "Interrupt", requestId: lightRequest, interruptors: [] });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.fresh(layerConfigSources),
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
        Layer.mock(ServerBrowser.ServerBrowser)({}),
      ),
    ),
  ),
);

it.effect("a missing thread worktree gets its project's skills in the cwd snapshot", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfigModule.ServerConfig;
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const projectId = ProjectId.make("project:skills");
    const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-missing-worktree-project-",
    });
    const skillPath = path.join(workspaceRoot, ".claude", "skills", "finalize", "SKILL.md");
    yield* fileSystem.makeDirectory(path.dirname(skillPath), { recursive: true });
    yield* fileSystem.writeFileString(skillPath, "---\nname: finalize\n---\n");
    // Removed with `git worktree remove`; only the next turn start recreates it.
    const worktreePath = path.join(serverConfig.worktreesDir, "proj", "t3-6f94fb95");
    const thread = {
      id: ThreadId.make("thread:worktree"),
      projectId,
      archivedAt: null,
      worktreePath,
      branch: "t3/reply-ok",
    } as unknown as OrchestrationV2ThreadShell;
    const project = {
      id: projectId,
      title: "proj",
      workspaceRoot,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-11-07T00:00:00.000Z",
      updatedAt: "2026-11-07T00:00:00.000Z",
    } satisfies OrchestrationProjectShell;
    const provider: ServerProvider = {
      instanceId,
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-11-07T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    };
    // Like Claude's probe: project skills come from the scanned cwd, and a missing cwd is final.
    const scan = (cwd: string) =>
      fileSystem.exists(path.join(cwd, ".claude", "skills", "finalize", "SKILL.md")).pipe(
        Effect.orDie,
        Effect.map((found) => ({
          cwd,
          checkedAt: "2026-11-07T00:00:00.000Z",
          slashCommands: [],
          slashCommandsPending: false,
          skills: found
            ? [{ name: "finalize", path: path.join(cwd, ".claude/skills/finalize"), enabled: true }]
            : [],
        })),
      );
    const responses = yield* Queue.unbounded<unknown>();
    const services = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([provider]),
        refreshWorkspaceSnapshot: (input) =>
          Effect.map(scan(input.scanCwd ?? input.cwd), (snapshot) => [
            { ...provider, workspaceSnapshots: [{ ...snapshot, cwd: input.cwd }] },
          ]),
      }),
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        listInstances: Effect.succeed([]),
        getInstance: () => Effect.succeed({ instanceId, snapshotForCwd: scan } as never),
      }),
      Layer.effect(ProjectService.ProjectService, ProjectService.make).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              readShellSnapshot: (options) =>
                Effect.succeed(
                  Effect.succeed({
                    schemaVersion: 1,
                    snapshotSequence: 0,
                    threads: [thread].filter(
                      (candidate) =>
                        options?.worktreePath === undefined ||
                        candidate.worktreePath === options.worktreePath,
                    ),
                    archivedThreads: [],
                  } as never),
                ),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              get: () => Effect.succeedSome(project as never),
            }),
            Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
            Layer.mock(WorkspacePaths.WorkspacePaths)({}),
            Layer.mock(EventSink.EventSinkV2)({}),
            IdAllocator.layer,
            Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({}),
            Layer.mock(ThreadCommandExecutor.ThreadCommandExecutor)({}),
          ),
        ),
      ),
      Layer.mock(UsageLimitSources.UsageLimitSources)({ current: Effect.succeed([]) }),
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
      Layer.mock(DirectEndpoints.DirectEndpoints)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        scratchRoot: Effect.succeedNone,
        namedProjectsRoot: process.cwd(),
      }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("ws-fixture")),
      }),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
    );
    const server = yield* RpcServer.makeNoSerialization(
      RpcGroup.make(WsServerRefreshProvidersRpc),
      {
        ...WS_RPC_SERVER_OPTIONS,
        onFromServer: (response) =>
          response._tag === "Exit" && response.exit._tag === "Success"
            ? Queue.offer(responses, response.exit.value)
            : response._tag === "Exit"
              ? Queue.offer(responses, response.exit)
              : Effect.void,
      },
    ).pipe(
      Effect.provide(
        layerWsRpc(
          {
            sessionId: AuthSessionId.make("worktree-skills-test"),
            subject: "worktree-skills-test",
            method: "browser-session-cookie",
            scopes: [],
          },
          {},
          yield* ServerBrowser.ServerBrowser,
          () => Effect.void,
          { secretReferences: true },
        ).pipe(Layer.provide(services)),
      ),
    );

    yield* server.write(0, {
      _tag: "Request",
      id: RpcMessage.RequestId("refresh"),
      tag: WS_METHODS.serverRefreshProviders,
      payload: { instanceId, cwd: worktreePath, workspaceSnapshotsOnDemand: true },
      headers: Headers.empty,
    });
    const refreshed = (yield* Queue.take(responses)) as {
      readonly providers: ReadonlyArray<ServerProvider>;
    };
    const snapshot = refreshed.providers[0]?.workspaceSnapshots?.find(
      (candidate) => candidate.cwd === worktreePath,
    );
    assert.deepEqual(
      snapshot?.skills?.map((skill) => skill.name),
      ["finalize"],
      "the thread's removed worktree should list the project's skills",
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.fresh(layerConfigSources),
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
        Layer.mock(ServerBrowser.ServerBrowser)({}),
      ),
    ),
  ),
);

it.effect.each(["pull", "stacked action"] as const)(
  "a git %s replies before its local-first status refresh finishes",
  (operation) =>
    Effect.gen(function* () {
      const failure = new GitManagerError({ operation: "test", cwd: "/repo", detail: "push failed" });
      const pulled = { status: "pulled", refName: "main", upstreamRef: "origin/main" } as const;
      const refreshed = yield* Deferred.make<string>();
      const finishRefresh = yield* Deferred.make<void>();
      const refreshFinished = yield* Deferred.make<void>();
      const exits = yield* Queue.unbounded<Exit.Exit<unknown, unknown>>();
      const services = Layer.mergeAll(
        layerUnusedConfigRpcServices,
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          pullCurrentBranch: () => Effect.succeed(pulled),
          runStackedAction: () => Effect.fail(failure),
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshAfterCheckout: (cwd) =>
            Deferred.succeed(refreshed, cwd).pipe(
              Effect.andThen(Deferred.await(finishRefresh)),
              Effect.andThen(Deferred.succeed(refreshFinished, undefined)),
              Effect.asVoid,
            ),
        }),
        Layer.mock(ExternalLauncher.ExternalLauncher)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(UsageLimitSources.UsageLimitSources)({}),
        Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
        Layer.mock(DirectEndpoints.DirectEndpoints)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
        Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("ws-fixture")),
        }),
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      );
      const server = yield* RpcServer.makeNoSerialization(WsRpcGroup, {
        ...WS_RPC_SERVER_OPTIONS,
        onFromServer: (response) =>
          response._tag === "Exit" ? Queue.offer(exits, response.exit) : Effect.void,
      }).pipe(
        Effect.provide(
          layerWsRpc(
            {
              sessionId: AuthSessionId.make("git-test"),
              subject: "git-test",
              method: "browser-session-cookie",
              scopes: [AuthSourceControlWriteScope],
            },
            {},
            yield* ServerBrowser.ServerBrowser,
            () => Effect.void,
            { secretReferences: true },
          ).pipe(
            Layer.provide(services),
            Layer.merge(RpcAuthorization.layer([AuthSourceControlWriteScope])),
          ),
        ),
      );
      yield* server.write(0, {
        _tag: "Request",
        id: RpcMessage.RequestId("git"),
        tag: operation === "pull" ? WS_METHODS.vcsPull : WS_METHODS.gitRunStackedAction,
        payload: operation === "pull"
          ? { cwd: "/repo" }
          : { actionId: "action", cwd: "/repo", action: "commit_push" },
        headers: Headers.empty,
      });
      const exit = yield* Queue.take(exits);
      assert.deepEqual(
        Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit,
        operation === "pull" ? Exit.succeed(pulled) : failure,
      );
      assert.equal(yield* Deferred.await(refreshed), "/repo");
      assert.isFalse(yield* Deferred.isDone(refreshFinished));
      yield* Deferred.succeed(finishRefresh, undefined);
      yield* Deferred.await(refreshFinished);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.fresh(layerConfigSources),
          Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
          Layer.mock(ServerBrowser.ServerBrowser)({}),
        ),
      ),
    ),
);

it.effect("a publish whose push fails still refreshes the new remote", () =>
  Effect.gen(function* () {
    const refreshes = yield* Queue.unbounded<string>();
    const exits = yield* Queue.unbounded<string>();
    const services = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
        publishRepository: (input) =>
          Effect.fail(
            new SourceControlRepositoryError({
              provider: input.provider,
              operation: "publishRepository",
              detail: 'Created owner/repo and added it as remote "origin", but the push failed.',
            }),
          ),
      }),
      Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
        resolve: (cwd, options) =>
          Queue.offer(refreshes, `identity ${cwd} refresh=${options?.refresh === true}`).pipe(
            Effect.as(null),
          ),
      }),
      Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
        refreshStatus: (cwd) =>
          Queue.offer(refreshes, `status ${cwd}`).pipe(Effect.andThen(Effect.die("unused"))),
      }),
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(UsageLimitSources.UsageLimitSources)({}),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
      Layer.mock(DirectEndpoints.DirectEndpoints)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("ws-fixture")),
      }),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
    );
    const server = yield* RpcServer.makeNoSerialization(WsRpcGroup, {
      ...WS_RPC_SERVER_OPTIONS,
      onFromServer: (response) =>
        response._tag === "Exit" ? Queue.offer(exits, response.exit._tag) : Effect.void,
    }).pipe(
      Effect.provide(
        layerWsRpc(
          {
            sessionId: AuthSessionId.make("publish-test"),
            subject: "publish-test",
            method: "browser-session-cookie",
            scopes: [AuthSourceControlWriteScope],
          },
          {},
          yield* ServerBrowser.ServerBrowser,
          () => Effect.void,
          { secretReferences: true },
        ).pipe(
          Layer.provide(services),
          Layer.merge(RpcAuthorization.layer([AuthSourceControlWriteScope])),
        ),
      ),
    );
    yield* server.write(0, {
      _tag: "Request",
      id: RpcMessage.RequestId("publish"),
      tag: WS_METHODS.sourceControlPublishRepository,
      payload: {
        cwd: "/repo",
        provider: "github",
        repository: "owner/repo",
        visibility: "private",
      },
      headers: Headers.empty,
    });
    assert.equal(yield* Queue.take(exits), "Failure");
    assert.deepEqual(
      [yield* Queue.take(refreshes), yield* Queue.take(refreshes)],
      ["identity /repo refresh=true", "status /repo"],
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.fresh(layerConfigSources),
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
        Layer.mock(ServerBrowser.ServerBrowser)({}),
      ),
    ),
  ),
);

// Pruned history cannot be replayed: a cursor below the boundary must resync from a snapshot,
// or, for a shell client that loads it over HTTP, be told to without the server building one.
// Post-snapshot shell deltas coalesce on the live clock.
it.live.each([
  { scope: "thread", httpSnapshotFallback: false },
  { scope: "shell", httpSnapshotFallback: false },
  { scope: "shell", httpSnapshotFallback: true },
] as const)(
  "$scope resume from a cursor below the pruned boundary (HTTP fallback: $httpSnapshotFallback)",
  ({ scope, httpSnapshotFallback }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-10-13T00:00:00.000Z";
      const threadId = ThreadId.make("thread:pruned");
      const insert = (version: number) => sql<{ sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`pruned:${version}`}, 'thread', ${threadId}, ${version}, 'provider-session.detached',
          ${now}, 'server', ${JSON.stringify({ providerSessionId: "session:pruned", detachedAt: now })},
          '{}', 2
        ) RETURNING sequence
      `;
      const [first] = yield* insert(0);
      const [second] = yield* insert(1);
      const [snapshotRow] = yield* insert(2);
      const projectId = ProjectId.make("project:pruned-fallback");
      const project = {
        id: projectId,
        title: "Fallback",
        workspaceRoot: "/tmp/pruned-fallback",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      } satisfies OrchestrationProjectShell;
      let deletedSequence: number | undefined;
      const decodeSnapshot = Effect.gen(function* () {
        // The snapshot transaction already captured the cursor. A subscriber to the live
        // PubSub alone would miss this write before the tail subscribes.
        const [deleted] = yield* sql<{ sequence: number }>`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, actor_kind, payload_json, metadata_json, application_event_version
          ) VALUES (
            'pruned:project-delete', 'project', ${projectId}, 0, 'project.deleted',
            ${now}, 'server', ${JSON.stringify({ projectId, deletedAt: now })}, '{}', 2
          ) RETURNING sequence
        `;
        deletedSequence = deleted!.sequence;
        return {
          schemaVersion: 2,
          snapshotSequence: snapshotRow!.sequence,
          threads: [],
          archivedThreads: [],
        };
      });
      yield* sql`
        INSERT INTO orchestration_v2_projection_metadata (
          projection_name, schema_version, last_sequence, updated_at
        ) VALUES (${OrchestrationEventStore.EVENT_LOG_PRUNED_THROUGH}, 2, ${second!.sequence}, ${now})
      `;
      const subscription = Effect.gen(function* () {
        const items: ReadonlyArray<unknown> =
          scope === "thread"
            ? yield* Stream.runCollect(
                yield* subscribeOrchestrationV2Thread({ threadId, afterSequence: first!.sequence }),
              )
            : yield* subscribeOrchestrationV2Shell({
                afterSequence: first!.sequence,
                requestCompletionMarker: true,
                ...(httpSnapshotFallback ? { httpSnapshotFallback: true as const } : {}),
              }).pipe(
                Effect.flatMap((stream) => stream.pipe(Stream.take(3), Stream.runCollect)),
              );
        return items;
      });
      const exit = yield* subscription.pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          getThreadSnapshot: () => Effect.die("snapshot"),
          listActiveShellIndex: () => Effect.die("snapshot"),
          readShellSnapshot: () =>
            httpSnapshotFallback ? Effect.die("snapshot") : Effect.succeed(decodeSnapshot),
          listActiveSubagentThreadIds: () => Effect.die("replay"),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([project]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(
          ProjectService.ProjectService,
          {} as ProjectService.ProjectService["Service"],
        ),
        Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
          subscribeChanges: PubSub.subscribe(yield* PubSub.unbounded<ProjectEnrichment.ProjectEnrichmentChange>()),
          getAvailable: () =>
            Effect.succeed({
              repositoryIdentity: null,
              faviconPath: null,
              repositoryIdentityResolved: false,
            }),
          peek: () => Effect.die("Unexpected project enrichment peek in replay"),
          request: () => Effect.die("Unexpected project enrichment request in replay"),
          readRepositoryIdentity: () => Effect.die("Unexpected repository identity read in replay"),
          invalidate: () => Effect.die("Unexpected project enrichment invalidation in replay"),
          refreshRepositoryIdentity: () => Effect.die("Unexpected repository identity refresh in replay"),
        }),
        Effect.exit,
      );
      const result = Exit.isFailure(exit) ? Cause.squash(exit.cause) : Array.from(exit.value);
      if (scope === "thread" || httpSnapshotFallback) {
        assert.deepEqual(
          result,
          httpSnapshotFallback ? [{ kind: "snapshot-required" }] : "snapshot",
        );
        assert.isUndefined(deletedSequence);
        return;
      }
      assert.isArray(result);
      const [snapshot, synchronized, removed] =
        result as ReadonlyArray<OrchestrationV2ShellStreamItem>;
      assert.equal(snapshot?.kind, "snapshot");
      if (snapshot?.kind !== "snapshot") throw new Error("No fallback snapshot");
      assert.equal(snapshot.snapshot.snapshotSequence, snapshotRow!.sequence);
      assert.deepEqual(snapshot.snapshot.projects.map((entry) => entry.id), [projectId]);
      assert.deepEqual(synchronized, { kind: "synchronized" });
      assert.isDefined(deletedSequence);
      assert.deepEqual(removed, { kind: "project.removed", sequence: deletedSequence, projectId });
    }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

// A prune pass can delete replayed rows after the boundary check; the read must not be trusted.
it.effect.each(["thread", "shell"] as const)(
  "%s resume loads a snapshot when pruning advances during the replay read",
  (scope) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-10-13T00:00:00.000Z";
      const threadId = ThreadId.make("thread:prune-race");
      const insert = (version: number) => sql<{ sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`prune-race:${version}`}, 'thread', ${threadId}, ${version}, 'provider-session.detached',
          ${now}, 'server', ${JSON.stringify({ providerSessionId: "session:race", detachedAt: now })},
          '{}', 2
        ) RETURNING sequence
      `;
      const [first] = yield* insert(0);
      const [second] = yield* insert(1);
      yield* insert(2);

      const readStarted = yield* Deferred.make<void>();
      const releaseRead = yield* Deferred.make<void>();
      let gated = false;
      const gateReplayRead: Statement.Transformer = (statement) => {
        const [query] = statement.compile();
        // The paged replay read (readApplicationRows), not the stats or high-water queries.
        if (!gated && /^\s*SELECT\s+sequence,\s+event_id,/.test(query)) {
          gated = true;
          return Deferred.succeed(readStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRead)),
            Effect.as(statement),
          );
        }
        return Effect.succeed(statement);
      };
      const subscription = Effect.gen(function* () {
        const stream =
          scope === "thread"
            ? yield* subscribeOrchestrationV2Thread({ threadId, afterSequence: first!.sequence })
            : yield* subscribeOrchestrationV2Shell({ afterSequence: first!.sequence });
        return stream;
      }).pipe(
        Effect.provideService(Statement.CurrentTransformer, gateReplayRead),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          getThreadSnapshot: () => Effect.die("snapshot"),
          listActiveShellIndex: () => Effect.die("snapshot"),
          readShellSnapshot: () => Effect.die("snapshot"),
          listActiveSubagentThreadIds: () => Effect.succeed([]),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(
          ProjectService.ProjectService,
          {} as ProjectService.ProjectService["Service"],
        ),
        Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
          subscribeChanges: PubSub.subscribe(yield* PubSub.unbounded()),
        } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
        Effect.exit,
        Effect.forkChild,
      );
      const fiber = yield* subscription;
      yield* Deferred.await(readStarted);
      // A pass publishes its boundary, then deletes the rows it covers.
      yield* sql`
        INSERT INTO orchestration_v2_projection_metadata (
          projection_name, schema_version, last_sequence, updated_at
        ) VALUES (${OrchestrationEventStore.EVENT_LOG_PRUNED_THROUGH}, 2, ${second!.sequence}, ${now})
      `;
      yield* sql`DELETE FROM orchestration_events WHERE sequence = ${second!.sequence}`;
      yield* Deferred.succeed(releaseRead, undefined);
      const exit = yield* Fiber.join(fiber);
      assert.deepEqual(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit, "snapshot");
    }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

// A cursor at the high-water missed nothing, including an empty log or a cursor below the
// pruned boundary. Project identity enrichment can still precede the synchronization marker.
it.effect.each([
  {
    scope: "shell",
    log: "empty",
    knowsIdentities: false,
    isRepository: false,
    kinds: ["synchronized"],
  },
  { scope: "thread", log: "pruned", knowsIdentities: false, isRepository: true, kinds: [] },
  {
    scope: "shell",
    log: "pruned",
    knowsIdentities: false,
    isRepository: true,
    kinds: ["snapshot", "synchronized"],
  },
  {
    scope: "shell",
    log: "pruned",
    knowsIdentities: true,
    isRepository: true,
    kinds: ["synchronized"],
  },
  // The client keeps a cached identity over an absent one, so "resolved to none" still goes out.
  {
    scope: "shell",
    log: "pruned",
    knowsIdentities: true,
    isRepository: false,
    kinds: ["snapshot", "synchronized"],
  },
] as const)(
  "$scope resume at its high-water skips the snapshot ($log log, knows identities: $knowsIdentities, repository: $isRepository)",
  ({ scope, log, knowsIdentities, isRepository, kinds }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-10-13T00:00:00.000Z";
      const threadId = ThreadId.make("thread:idle");
      let afterSequence = 0;
      if (log === "pruned") {
        const [last] = yield* sql<{ sequence: number }>`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, actor_kind, payload_json, metadata_json, application_event_version
          ) VALUES (
            'idle:0', 'thread', ${threadId}, 0, 'provider-session.detached',
            ${now}, 'server', ${JSON.stringify({ providerSessionId: "session:idle", detachedAt: now })},
            '{}', 2
          ) RETURNING sequence
        `;
        afterSequence = last!.sequence;
        yield* sql`
          INSERT INTO orchestration_v2_projection_metadata (
            projection_name, schema_version, last_sequence, updated_at
          ) VALUES (${OrchestrationEventStore.EVENT_LOG_PRUNED_THROUGH}, 2, ${afterSequence + 10}, ${now})
        `;
      }
      const identity = isRepository
        ? ({
            canonicalKey: "github.com/t3/idle",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "git@github.com:t3/idle",
            },
          } as const)
        : null;
      const project = {
        id: ProjectId.make("project:idle"),
        title: "Idle",
        workspaceRoot: "/tmp/idle",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      } satisfies OrchestrationProjectShell;
      const subscription = Effect.gen(function* () {
        if (scope === "thread") {
          return yield* subscribeOrchestrationV2Thread({
            threadId,
            afterSequence,
          }).pipe(Effect.as([]));
        }
        const stream = yield* subscribeOrchestrationV2Shell({
          afterSequence,
          requestCompletionMarker: true,
          ...(knowsIdentities
            ? {
                knownProjectIdentities: projectIdentitiesDigest([
                  { ...project, repositoryIdentity: identity },
                ]),
              }
            : {}),
        });
        return yield* stream.pipe(
          Stream.takeUntil((item) => item.kind === "synchronized"),
          Stream.map((item) => item.kind),
          Stream.runCollect,
        );
      });
      const exit = yield* subscription.pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          getThreadSnapshot: () => Effect.die("snapshot"),
          listActiveShellIndex: () => Effect.die("snapshot"),
          readShellSnapshot: () => Effect.die("snapshot"),
          listActiveSubagentThreadIds: () => Effect.succeed([]),
          streamStoredEventsFrom: () => Stream.empty,
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed(log === "empty" ? [] : [project]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(
          ProjectService.ProjectService,
          {} as ProjectService.ProjectService["Service"],
        ),
        Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
          subscribeChanges: PubSub.subscribe(yield* PubSub.unbounded()),
          getAvailable: () =>
            Effect.succeed({
              repositoryIdentity: identity,
              faviconPath: null,
              repositoryIdentityResolved: true,
            }),
        } as unknown as ProjectEnrichment.ProjectEnrichmentService["Service"]),
        Effect.exit,
      );
      // A snapshot load dies with "snapshot", so success means the resume replayed nothing.
      assert.deepEqual(
        Exit.isFailure(exit) ? Cause.squash(exit.cause) : Array.from(exit.value),
        kinds,
      );
    }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

const acpDriver = ProviderDriverKind.make("acpRegistry");
const acpInstanceId = ProviderInstanceId.make("acpRegistry_test");
const acpProjectId = ProjectId.make("project:acp");
const acpThreadId = (sessionId: string) =>
  IdAllocator.deriveThreadFromProviderThread({
    driver: acpDriver,
    providerInstanceId: acpInstanceId,
    nativeThreadId: sessionId,
  });
const acpSessionTags = [
  WS_METHODS.serverListAcpRegistrySessions,
  WS_METHODS.serverImportAcpRegistrySession,
  WS_METHODS.serverDeleteAcpRegistrySession,
] as const;
const acpSessionRpcs = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<
      keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
      (typeof acpSessionTags)[number]
    > => !(acpSessionTags as ReadonlyArray<string>).includes(tag),
  ),
);
const acpStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const seedAcpThread = Effect.fn(function* (
  sessionId: string,
  state: { readonly imported: boolean; readonly ran: boolean; readonly nativeId?: string },
) {
  const sink = yield* EventSink.EventSinkV2;
  const now = DateTime.makeUnsafe("2026-10-23T00:00:00.000Z");
  const threadId = acpThreadId(sessionId);
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: acpProjectId,
    title: sessionId,
    providerInstanceId: acpInstanceId,
    modelSelection: { instanceId: acpInstanceId, model: "default" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    ...(state.imported ? { historyOrigin: "v1_import" as const } : {}),
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
  };
  const events: Array<OrchestrationV2DomainEvent> = [
    {
      id: EventId.make(`${threadId}:created`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: thread,
    },
  ];
  if (state.nativeId !== undefined) {
    events.push({
      id: EventId.make(`${threadId}:provider`),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: ProviderThreadId.make(`${threadId}:provider`),
        appThreadId: threadId,
        ownerNodeId: null,
        driver: acpDriver,
        providerInstanceId: acpInstanceId,
        providerSessionId: null,
        nativeThreadRef: { driver: acpDriver, nativeId: state.nativeId, strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        pendingBackgroundTasks: [],
      },
    });
  }
  if (state.ran) {
    events.push({
      id: EventId.make(`${threadId}:run`),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: RunId.make(`${threadId}:run`),
        threadId,
        ordinal: 1,
        providerInstanceId: acpInstanceId,
        modelSelection: thread.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make(`${threadId}:prompt`),
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
  }
  yield* sink.write({ events });
  return threadId;
});

it.effect("ACP session RPCs list a thread missing its history and repair it on import", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const pending = yield* seedAcpThread("pending", { imported: false, ran: false });
    const complete = yield* seedAcpThread("complete", { imported: true, ran: false });
    const ran = yield* seedAcpThread("ran", { imported: false, ran: true });
    const owned = yield* seedAcpThread("existing-t3-thread", {
      imported: false,
      ran: true,
      nativeId: "owned-session",
    });
    const repaired: Array<ThreadId> = [];
    const deleted: Array<string> = [];
    const session = (sessionId: string) => ({
      sessionId,
      cwd: "/workspace/acp",
      additionalDirectories: [],
      title: null,
      updatedAt: null,
      importedThreadId: null,
    });
    const instance = {
      driverKind: acpDriver,
      snapshot: {
        getSnapshot: Effect.succeed({ nativeSessions: { canLoad: true, canDelete: true } }),
      },
      acpSessionManagement: {
        listSessions: () =>
          Effect.succeed({
            sessions: ["new", "pending", "complete", "ran", "owned-session"].map(session),
            nextCursor: null,
            canLoad: true,
            canResume: true,
            canDelete: true,
          }),
        deleteSession: ({ sessionId }: { readonly sessionId: string }) =>
          Effect.sync(() => {
            deleted.push(sessionId);
          }),
      },
    } as unknown as ProviderInstance;
    const dependencies = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.fresh(layerConfigSources),
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(UsageLimitSources.UsageLimitSources)({}),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
      Layer.mock(DirectEndpoints.DirectEndpoints)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("ws-fixture")),
      }),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      Layer.mock(ProjectService.ProjectService)({
        getById: () =>
          Effect.succeedSome({
            id: acpProjectId,
            title: "ACP",
            workspaceRoot: "/workspace/acp",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-10-23T00:00:00.000Z",
            updatedAt: "2026-10-23T00:00:00.000Z",
            deletedAt: null,
          }),
      }),
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: () => Effect.succeed(instance),
      }),
      Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({
        withSessionMutation: (effect) => effect,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          projections
            .getThreadShell(threadId)
            .pipe(
              Effect.mapError(
                (cause) => new Orchestrator.OrchestratorProjectionError({ threadId, cause }),
              ),
            ),
      }),
      // Repairing an existing thread must not launch another one.
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(AgentSessionImporter.AgentSessionImporter)({
        importNativeHistory: ({ threadId }) =>
          Effect.sync(() => repaired.push(threadId)).pipe(Effect.as(1)),
      }),
      Layer.succeed(SqlClient.SqlClient, sql),
    );
    const services = AcpRegistrySessions.layer.pipe(Layer.provideMerge(dependencies));
    const serverBrowser = yield* ServerBrowser.ServerBrowser;
    const makeClient = (sessionId: string, scopes: EnvironmentAuth.AuthenticatedSession["scopes"]) =>
      RpcTest.makeClient(acpSessionRpcs).pipe(
        Effect.provide(
          layerWsRpc(
            {
              sessionId: AuthSessionId.make(sessionId),
              subject: "acp-test",
              method: "browser-session-cookie",
              scopes,
            },
            {},
            serverBrowser,
            () => Effect.void,
            { secretReferences: true },
          ).pipe(
            Layer.provide(services),
            Layer.merge(RpcAuthorization.layer(scopes)),
          ),
        ),
      );

    const reader = yield* makeClient("acp-reader", [AuthOrchestrationReadScope]);
    const readOnlyList = yield* reader[WS_METHODS.serverListAcpRegistrySessions]({
      instanceId: acpInstanceId,
      projectId: acpProjectId,
    });
    assert.isTrue(readOnlyList.sessions.some((session) => session.sessionId === "pending"));
    const denied = yield* reader[WS_METHODS.serverImportAcpRegistrySession]({
      instanceId: acpInstanceId,
      projectId: acpProjectId,
      sessionId: "pending",
    }).pipe(Effect.flip);
    assert.deepInclude(denied, {
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: AuthOrchestrationOperateScope,
    });
    assert.deepEqual(repaired, []);

    const client = yield* makeClient("acp-operator", [
      AuthOrchestrationReadScope,
      AuthOrchestrationOperateScope,
    ]);
    const listed = yield* client[WS_METHODS.serverListAcpRegistrySessions]({
      instanceId: acpInstanceId,
      projectId: acpProjectId,
    });
    assert.deepEqual(
      listed.sessions.map(({ sessionId, importedThreadId, nativeHistoryPending }) => [
        sessionId,
        importedThreadId,
        nativeHistoryPending,
      ]),
      [
        ["new", null, undefined],
        ["pending", pending, true],
        ["complete", complete, undefined],
        ["ran", ran, undefined],
        ["owned-session", owned, undefined],
      ],
    );

    const imported = yield* client[WS_METHODS.serverImportAcpRegistrySession]({
      instanceId: acpInstanceId,
      projectId: acpProjectId,
      sessionId: "pending",
    });
    assert.deepEqual(imported, { threadId: pending, imported: true });
    assert.deepEqual(repaired, [pending]);
    const reopened = yield* client[WS_METHODS.serverImportAcpRegistrySession]({
      instanceId: acpInstanceId,
      projectId: acpProjectId,
      sessionId: "owned-session",
    });
    assert.deepEqual(reopened, { threadId: owned, imported: false });
    assert.deepEqual(repaired, [pending]);
    const deletion = yield* client[WS_METHODS.serverDeleteAcpRegistrySession]({
      instanceId: acpInstanceId,
      projectId: acpProjectId,
      sessionId: "owned-session",
    }).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(deletion));
    assert.deepEqual(deleted, []);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        EventSink.layer.pipe(Layer.provideMerge(acpStores)),
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
        Layer.mock(ServerBrowser.ServerBrowser)({}),
      ),
    ),
  ),
);
