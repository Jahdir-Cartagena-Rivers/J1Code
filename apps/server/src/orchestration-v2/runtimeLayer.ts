import * as WorktreeBranchSync from "./WorktreeBranchSync.ts";
import * as V2RouteAdmission from "../routing/v2RouteAdmission.ts";
import * as RoutingOwner from "../routing/engineDrain.ts";
import * as LocalRouteNotice from "../routing/localRouteNotice.ts";
import * as GuestShareService from "../guest/GuestShareService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import * as DelegatedTaskDeadline from "./DelegatedTaskDeadline.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Layer from "effect/Layer";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as OrchestrationCommandReceipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import * as McpAppRequests from "../mcpApps/McpAppRequests.ts";
import * as McpSignIn from "../mcpApps/McpSignIn.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ProviderInstallationGate from "../provider/ProviderInstallationGate.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as AgentHistory from "../project/AgentHistoryLive.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ScratchThreadPromotion from "../project/ScratchThreadPromotion.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as CommandPolicy from "./CommandPolicy.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@j1code/provider-core/server/IdAllocator";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as AutoModelRouting from "./AutoModelRouting.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@j1code/provider-core/server/ProviderContinuationRequests";
import * as ProviderContinuationService from "./ProviderContinuationService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as ProviderSwitchService from "./ProviderSwitchService.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import { layerThreadWorktreeRestore } from "../workspace/restoreMissingWorktree.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadForkService from "./ThreadForkService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as TaskFolderStore from "../workspace/TaskFolderStore.ts";
import * as WorkspaceFolders from "../workspace/WorkspaceFolders.ts";
import * as WorkflowRuntime from "../workflows/WorkflowRuntime.ts";
import * as WorkflowAgentThreads from "../workflows/WorkflowAgentThreads.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";

export const layerEventInfrastructure = Layer.mergeAll(
  OrchestrationEventStore.layer,
  OrchestrationCommandReceipts.layer,
);

const layerWorkspaceFoldersProvided = WorkspaceFolders.layer.pipe(
  Layer.provide(Layer.merge(ProjectStore.layer, TaskFolderStore.layer)),
);
const layerRuntimePolicyProvided = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(layerWorkspaceFoldersProvided),
  Layer.provide(ProjectStore.layer),
);

const layerEventStoreProvided = EventStore.layerFromOrchestrationEventStore.pipe(
  Layer.provide(layerEventInfrastructure),
);
const layerCommandReceiptStoreProvided = CommandReceiptStore.layerFromApplicationReceipts.pipe(
  Layer.provide(layerEventInfrastructure),
);

const layerStores = Layer.mergeAll(
  layerEventInfrastructure,
  layerEventStoreProvided,
  ProjectionStore.layer,
  ProjectStore.layer,
  layerCommandReceiptStoreProvided,
  EffectOutbox.layer,
  TurnItemPositionStore.layer,
);

export const layerEventSink = EventSink.layerFromStores.pipe(Layer.provide(layerStores));
const layerProjectionMaintenanceProvided = ProjectionMaintenance.layer.pipe(
  Layer.provide(layerStores),
);
const layerLegacyV1ThreadImporterProvided = LegacyV1ThreadImporter.layer.pipe(
  Layer.provide(layerEventSink),
);

export const layerProjectService = ProjectService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      ProjectionStore.layer,
      layerEventSink,
      IdAllocator.layer,
      layerLegacyV1ThreadImporterProvided,
    ),
  ),
);

const layerProviderEventIngestorProvided = ProviderEventIngestor.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerEventSink,
      IdAllocator.layer,
      ProjectionStore.layer,
      ThreadCommandExecutor.layer,
      GitVcsDriver.layer,
    ),
  ),
);

const layerCheckpointServiceProvided = CheckpointService.layer.pipe(
  Layer.provide(IdAllocator.layer),
  Layer.provide(layerWorkspaceFoldersProvided),
);
const layerContextHandoffServiceProvided = ContextHandoffService.layer.pipe(
  Layer.provide(IdAllocator.layer),
);

const layerProviderSwitchServiceProvided = ProviderSwitchService.layer.pipe(
  Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry),
);

const layerCommandOutputHubProvided = CommandOutputHub.layer.pipe(
  Layer.provide(Layer.merge(layerEventSink, ProjectionStore.layer)),
);

const layerProviderSessionManagerProvided = ProviderSessionManager.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerCommandOutputHubProvided,
      ProviderAdapterRegistry.layerFromProviderInstanceRegistry,
      layerEventSink,
      IdAllocator.layer,
      layerProviderEventIngestorProvided,
      ProjectionStore.layer,
      ProviderInstallationGate.layer,
    ),
  ),
);

const layerProviderAuthServiceProvided = ProviderAuthService.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, layerProviderSessionManagerProvided)),
);

const layerRunExecutionServiceProvided = RunExecutionService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      McpAppModelContext.layer,
      PreviewAgentActivity.layer,
      layerCheckpointServiceProvided,
      layerEventSink,
      IdAllocator.layer,
      layerProviderEventIngestorProvided,
      TurnItemPositionStore.layer,
      ThreadCommandExecutor.layer,
    ),
  ),
);

const layerProviderTurnStartServiceProvided = ProviderTurnStartService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerLegacyV1ThreadImporterProvided,
      layerContextHandoffServiceProvided,
      layerEventSink,
      IdAllocator.layer,
      ProjectionStore.layer,
      layerProviderSessionManagerProvided,
      layerProviderAuthServiceProvided,
      layerRunExecutionServiceProvided,
      layerRuntimePolicyProvided,
      TurnItemPositionStore.layer,
    ),
  ),
);

const layerV2RouteAdmissionProvided = V2RouteAdmission.layerV2RouteAdmission.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectionStore.layer,
      ProjectStore.layer,
      EffectOutbox.layer,
      layerRuntimePolicyProvided,
    ),
  ),
);
const layerStrictRouteAuthorizationProvided =
  V2RouteAdmission.layerStrictRouteNativeAuthorization.pipe(
    Layer.provide(layerV2RouteAdmissionProvided),
  );

const layerStrictNativeSteeringProvided = ProviderTurnControlService.layerStrictNativeSteering.pipe(
  Layer.provide(ProjectionStore.layer),
);

const layerProviderTurnControlServiceProvided = ProviderTurnControlService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerEventSink,
      ProjectionStore.layer,
      layerProviderSessionManagerProvided,
      layerRuntimePolicyProvided,
      layerStrictNativeSteeringProvided,
    ),
  ),
);
const layerRuntimeRequestServiceProvided = RuntimeRequestService.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, layerProviderSessionManagerProvided)),
);
const layerCheckpointRollbackServiceProvided = CheckpointRollbackService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      layerCheckpointServiceProvided,
      layerEventSink,
      IdAllocator.layer,
      ProjectionStore.layer,
      layerProviderSessionManagerProvided,
      ThreadCommandExecutor.layer,
      layerRuntimePolicyProvided,
    ),
  ),
);
const layerCheckpointCaptureServiceProvided = CheckpointCaptureService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerCheckpointServiceProvided,
      layerEventSink,
      IdAllocator.layer,
      ProjectionStore.layer,
    ),
  ),
);
const layerRunFinalizationServiceProvided = RunFinalizationService.layer.pipe(
  Layer.provide(Layer.merge(layerCheckpointCaptureServiceProvided, ProjectionStore.layer)),
);

const layerOrchestratorProvided = Orchestrator.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AutoModelRouting.layer,
      layerCheckpointServiceProvided,
      CommandPolicy.layer,
      layerStores,
      layerEventSink,
      layerCommandReceiptStoreProvided,
      layerContextHandoffServiceProvided,
      IdAllocator.layer,
      ProjectStore.layer,
      ProviderAdapterRegistry.layerFromProviderInstanceRegistry,
      // Reuse the continuation worker's layer reference so memoization shares one request queue.
      ProviderContinuationRequests.layer,
      layerProviderEventIngestorProvided,
      layerRuntimePolicyProvided,
      layerStrictNativeSteeringProvided,
      layerProviderSessionManagerProvided,
      layerProviderSwitchServiceProvided,
      layerRunExecutionServiceProvided,
      ThreadForkService.layer,
    ),
  ),
);

const layerLocalRouteNoticeProvided = LocalRouteNotice.layerLocalRouteNoticeWriter.pipe(
  Layer.provide(layerOrchestratorProvided),
);
const layerV2RoutingOwnerProvided = RoutingOwner.layerV2RoutingOwner.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerOrchestratorProvided,
      ProjectionStore.layer,
      layerEventSink,
      layerCommandReceiptStoreProvided,
      EffectOutbox.layer,
      layerRuntimePolicyProvided,
      layerProviderSessionManagerProvided,
      layerV2RouteAdmissionProvided,
      layerLocalRouteNoticeProvided,
    ),
  ),
);

// One scanner serves the wizard's scan and imports, so imports can reuse its candidates.
const layerAgentSessionScannerProvided = AgentSessionScanner.layer.pipe(
  Layer.provide(ProviderSessionRuntime.layer),
);
const layerAgentSessionImporterProvided = AgentSessionImporter.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerAgentSessionScannerProvided,
      layerProjectService,
      ProjectionStore.layer,
      layerOrchestratorProvided,
      layerEventSink,
      IdAllocator.layer,
      ProviderSessionRuntime.layer,
      ProviderAdapterRegistry.layerFromProviderInstanceRegistry,
      // Share the same admission lock as the orchestrator's command dispatch.
      ThreadCommandExecutor.layer,
    ),
  ),
);

const layerThreadManagementProvided = ThreadManagementService.layerWithLegacyImporter.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerAgentSessionImporterProvided,
      layerOrchestratorProvided,
      layerLegacyV1ThreadImporterProvided,
      layerCommandReceiptStoreProvided,
      layerProviderSessionManagerProvided,
      layerThreadWorktreeRestore,
    ),
  ),
);
export const layerProjectSetupScriptRunner = ProjectSetupScriptRunner.layer.pipe(
  Layer.provide(layerProjectService),
  // Whether a thread came from a linked environment, which skips setup.
  Layer.provide(ProjectionStore.layer),
);
const layerManagedProjectFoldersProvided = ManagedProjectFolders.layer.pipe(
  Layer.provide(layerProjectService),
);
const layerThreadLaunchProvided = ThreadLaunchService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AutoModelRouting.layer,
      layerProjectSetupScriptRunner,
      layerManagedProjectFoldersProvided,
      layerThreadManagementProvided,
      layerCommandReceiptStoreProvided,
      layerEventSink,
      ProjectionStore.layer,
      IdAllocator.layer,
    ).pipe(Layer.provideMerge(layerProjectService)),
  ),
);
const layerWorkflowsProvided = WorkflowRuntime.layer.pipe(
  Layer.provide(WorkflowAgentThreads.layer),
  Layer.provide(Layer.merge(layerThreadLaunchProvided, layerThreadManagementProvided)),
  Layer.provide(layerProjectService),
  Layer.provide(PeerMcpClient.layer),
  Layer.provide(PeerLinks.layer),
);
const layerSecretRequestsProvided = SecretRequests.layer.pipe(
  Layer.provide(layerThreadManagementProvided),
);
const layerScheduledTaskProvided = ScheduledTaskService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerThreadLaunchProvided,
      layerThreadManagementProvided,
      layerManagedProjectFoldersProvided,
      layerSecretRequestsProvided,
    ),
  ),
);
const layerScratchThreadPromotionProvided = ScratchThreadPromotion.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerManagedProjectFoldersProvided,
      layerThreadManagementProvided,
      layerScheduledTaskProvided,
    ).pipe(Layer.provideMerge(layerProjectService)),
  ),
);
const layerProviderContinuationWorkerProvided = ProviderContinuationService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProviderContinuationRequests.layer,
      layerThreadManagementProvided,
      IdAllocator.layer,
    ),
  ),
);
const layerThreadTitleRegenerationProvided = ThreadTitleRegenerationService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerThreadManagementProvided,
      TextGeneration.layer.pipe(Layer.provide(ProviderInstallationGate.layer)),
    ).pipe(Layer.provideMerge(ProjectStore.layer)),
  ),
);
const layerEffectExecutorProvided = EffectWorker.layerExecutor.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerRunFinalizationServiceProvided,
      layerCheckpointRollbackServiceProvided,
      layerProviderSessionManagerProvided,
      layerProviderTurnControlServiceProvided,
      layerProviderTurnStartServiceProvided,
      layerRuntimeRequestServiceProvided,
      layerThreadTitleRegenerationProvided,
      layerThreadManagementProvided,
      ProjectionStore.layer,
    ),
  ),
);
const layerEffectWorkerProvided = EffectWorker.layer.pipe(
  Layer.provide(Layer.merge(layerStores, layerEffectExecutorProvided)),
);
const layerProviderRuntimeRecoveryProvided = ProviderRuntimeRecoveryService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(layerEffectWorkerProvided, layerEventSink, IdAllocator.layer).pipe(
      Layer.provideMerge(layerStores),
    ),
  ),
);

const layerMcpAppRequestsProvided = McpAppRequests.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      McpAppModelContext.layer,
      layerOrchestratorProvided,
      layerThreadManagementProvided,
      layerProviderSessionManagerProvided,
    ),
  ),
);

const layerMcpSignInProvided = McpSignIn.layer.pipe(
  Layer.provide(Layer.merge(layerThreadManagementProvided, layerProviderSessionManagerProvided)),
);

export const layer = Layer.mergeAll(
  layerCommandOutputHubProvided,
  layerOrchestratorProvided,
  layerMcpAppRequestsProvided,
  layerMcpSignInProvided,
  layerThreadManagementProvided,
  layerEffectWorkerProvided,
  layerProviderSessionManagerProvided,
  layerProviderAuthServiceProvided,
  layerProviderRuntimeRecoveryProvided,
  layerProjectionMaintenanceProvided,
  layerLegacyV1ThreadImporterProvided,
).pipe(Layer.provide(ProjectStore.layer));

export const layerProduction = Layer.mergeAll(
  layerProviderTurnControlServiceProvided,
  layerV2RoutingOwnerProvided,
  layerLocalRouteNoticeProvided,
  WorktreeBranchSync.layer.pipe(
    Layer.provide(Layer.merge(layerThreadManagementProvided, ProjectionStore.layer)),
  ),
  layer,
  layerManagedProjectFoldersProvided,
  layerThreadLaunchProvided,
  layerWorkflowsProvided,
  layerScheduledTaskProvided,
  layerScratchThreadPromotionProvided,
  layerSecretRequestsProvided,
  GuestShareService.layer.pipe(
    Layer.provide(Layer.merge(layerOrchestratorProvided, layerCommandOutputHubProvided)),
  ),
  DelegatedTaskDeadline.layer.pipe(Layer.provide(layerOrchestratorProvided)),
  UsageLimitRecoveryWorker.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ProjectionStore.layer,
        layerThreadManagementProvided,
        layerOrchestratorProvided,
      ),
    ),
  ),
  layerProviderContinuationWorkerProvided,
  layerAgentSessionScannerProvided,
  layerAgentSessionImporterProvided,
  AgentHistory.AgentHistoryLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerAgentSessionImporterProvided,
        ProjectionStore.layer,
        ProviderSessionRuntime.layer,
        layerProjectService,
      ),
    ),
  ),
  EffectOutbox.layerPruneWorker.pipe(Layer.provide(EffectOutbox.layer)),
).pipe(
  Layer.provide(layerStrictRouteAuthorizationProvided),
  Layer.provide(layerV2RouteAdmissionProvided),
  Layer.provide(ResourceCleanupService.layer.pipe(Layer.provide(layerScheduledTaskProvided))),
  Layer.provideMerge(layerProjectService),
  Layer.provide(Scheduler.layer),
  Layer.provideMerge(layerEventInfrastructure),
);
