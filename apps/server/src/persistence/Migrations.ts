import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  DATABASE_MIGRATION_PROGRESS_MESSAGE,
  DATABASE_MIGRATIONS_FINISHED_MESSAGE,
  DATABASE_MIGRATIONS_STARTED_MESSAGE,
} from "@j1code/shared/databaseMigrationLog";

import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
import Migration0033 from "./Migrations/033_ProjectionThreadsSettled.ts";
import Migration0034 from "./Migrations/034_ProjectionThreadsSnoozed.ts";
import Migration0035 from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./Migrations/036_ProjectionThreadsPinned.ts";
import Migration0037 from "./Migrations/037_ProjectionTurnsKeysetIndex.ts";
import Migration0038 from "./Migrations/038_ProjectionThreadsPinOrderKey.ts";
import Migration0039 from "./Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0040 from "./Migrations/040_ProjectionProjectFaviconPath.ts";
import Migration0041 from "./Migrations/041_AuthSessionClientConnection.ts";
import Migration0042 from "./Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import Migration0043 from "./Migrations/043_ProjectionThreadsUnsettledAt.ts";
import Migration0044 from "./Migrations/044_ClearAutomaticProjectModelDefaults.ts";
import Migration0045 from "./Migrations/045_ProjectionProjectsAutoPull.ts";
import Migration0046 from "./Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import Migration0047 from "./Migrations/047_ProjectionProjectIcon.ts";
import Migration0048 from "./Migrations/048_ProjectionThreadBranchPullRequest.ts";
import Migration0049 from "./Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import Migration0050 from "./Migrations/050_ProjectionThreadPullRequests.ts";
import Migration0051 from "./Migrations/051_ProjectionThreadMessageContext.ts";
import Migration0052 from "./Migrations/052_ProjectionThreadTitleState.ts";
import Migration0053 from "./Migrations/053_PullRequestFilesViewed.ts";
import Migration0054 from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";
import {
  Migration0055,
  Migration0056,
  Migration0057,
  Migration0058,
  Migration0059,
  Migration0060,
  Migration0061,
  Migration0062,
  Migration0063,
  Migration0064,
} from "./J1MigrationBridge.ts";
import UpstreamMigration0055 from "./Migrations/055_OrchestrationV2.ts";
import UpstreamMigration0056 from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import UpstreamMigration0057 from "./Migrations/057_ScheduledTaskWebhooks.ts";
import UpstreamMigration0058 from "./Migrations/058_WebhookRelayDeliveries.ts";
import UpstreamMigration0059 from "./Migrations/059_McpAppModelContext.ts";
import UpstreamMigration0060 from "./Migrations/060_ThreadSnapshotWindowIndexes.ts";
import UpstreamMigration0061 from "./Migrations/061_PullRequestReviewGuides.ts";
import UpstreamMigration0062 from "./Migrations/062_ThreadFailureLookupIndex.ts";
import UpstreamMigration0063 from "./Migrations/063_DropUnusedV1Projections.ts";
import UpstreamMigration0064 from "./Migrations/064_CanonicalizeThreadPullRequestLinks.ts";
import UpstreamMigration0065 from "./Migrations/065_CodexUsageNativeTurnIndex.ts";
import UpstreamMigration0066 from "./Migrations/066_RepairClientSettlementTimestamps.ts";
import UpstreamMigration0067 from "./Migrations/067_WebhookDedupe.ts";
import UpstreamMigration0068 from "./Migrations/068_ShellStopRequestIndex.ts";
import UpstreamMigration0069 from "./Migrations/069_ThreadMessageSearch.ts";
import UpstreamMigration0070 from "./Migrations/070_PeerLinks.ts";
import UpstreamMigration0071 from "./Migrations/071_PeerLinkFence.ts";
import UpstreamMigration0072 from "./Migrations/072_WaitingLinkRequestIndex.ts";
import UpstreamMigration0073 from "./Migrations/073_ActiveTurnItemIndexes.ts";
import UpstreamMigration0074 from "./Migrations/074_ExcludeAttachmentPlaceholdersFromSearch.ts";
import UpstreamMigration0075 from "./Migrations/075_SubagentDeliveryState.ts";
import UpstreamMigration0076 from "./Migrations/076_ProjectionProjectsPinArchive.ts";
import UpstreamMigration0077 from "./Migrations/077_RepairBooleanSettledOverride.ts";
import UpstreamMigration0078 from "./Migrations/078_DropOrchestrationEventCorrelationIndex.ts";
import UpstreamMigration0079 from "./Migrations/079_DelegatedRecoveryIndexes.ts";
import UpstreamMigration0080 from "./Migrations/080_ScheduledTaskThreadMode.ts";
import UpstreamMigration0081 from "./Migrations/081_ProjectionMessageSearchText.ts";
import UpstreamMigration0082 from "./Migrations/082_TurnItemConversationIndex.ts";
import UpstreamMigration0083 from "./Migrations/083_CommandReadIndexes.ts";
import UpstreamMigration0084 from "./Migrations/084_LastExecutedRunIndex.ts";
import UpstreamMigration0085 from "./Migrations/085_TurnItemCounts.ts";
import UpstreamMigration0086 from "./Migrations/086_QueuedTurnInputIndex.ts";
import UpstreamMigration0087 from "./Migrations/087_ProjectionProjectsCustomTitle.ts";
import UpstreamMigration0088 from "./Migrations/088_TurnItemTypeStatusIndex.ts";
import UpstreamMigration0089 from "./Migrations/089_ShellThreadReadIndexes.ts";
import UpstreamMigration0090 from "./Migrations/090_AuthConnectDevices.ts";
import UpstreamMigration0091 from "./Migrations/091_AuthConnectDeniedRequests.ts";
import UpstreamMigration0092 from "./Migrations/092_QueuedTurnInputIndexJsonValid.ts";
import UpstreamMigration0093 from "./Migrations/093_ProviderTurnAttemptIndex.ts";
import UpstreamMigration0094 from "./Migrations/094_TurnItemMessageOrdinalIndex.ts";
import UpstreamMigration0095 from "./Migrations/095_TurnItemInlineWorkOutput.ts";
import UpstreamMigration0096 from "./Migrations/096_RepairStaleTitleRegeneration.ts";
import RequiredWorktreeLaunchJournal from "./Migrations/107_RequiredWorktreeLaunchJournal.ts";
import ProjectionProjectsTrackedFolders from "./Migrations/108_ProjectionProjectsTrackedFolders.ts";
import TaskFolders from "./Migrations/109_TaskFolders.ts";
import Workflows from "./Migrations/110_Workflows.ts";
import WorkflowSkippedRuns from "./Migrations/111_WorkflowSkippedRuns.ts";
import WorkflowRunIndexes from "./Migrations/112_WorkflowRunIndexes.ts";
import WorkflowRunTags from "./Migrations/113_WorkflowRunTags.ts";
import WorkflowMailSender from "./Migrations/114_WorkflowMailSender.ts";
import WorkflowPools from "./Migrations/115_WorkflowPools.ts";
import WorkflowRunSubject from "./Migrations/116_WorkflowRunSubject.ts";

const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "ProjectionThreadShellArchiveIndexes", Migration0030],
  [31, "AuthAuthorizationScopes", Migration0031],
  [32, "AuthPairingProofKeyThumbprint", Migration0032],
  [33, "ProjectionThreadsSettled", Migration0033],
  [34, "ProjectionThreadsSnoozed", Migration0034],
  [35, "ProjectionThreadTitleRegeneration", Migration0035],
  [36, "ProjectionThreadsPinned", Migration0036],
  [37, "ProjectionTurnsKeysetIndex", Migration0037],
  [38, "ProjectionThreadsPinOrderKey", Migration0038],
  [39, "ProjectionProjectsDefaultThreadEnvMode", Migration0039],
  [40, "ProjectionProjectFaviconPath", Migration0040],
  [41, "AuthSessionClientConnection", Migration0041],
  [42, "ProjectionThreadLinkedPullRequest", Migration0042],
  [43, "ProjectionThreadsUnsettledAt", Migration0043],
  [44, "ClearAutomaticProjectModelDefaults", Migration0044],
  [45, "ProjectionProjectsAutoPull", Migration0045],
  [46, "RepairAutomaticSettlementTimestamps", Migration0046],
  [47, "ProjectionProjectIcon", Migration0047],
  [48, "ProjectionThreadBranchPullRequest", Migration0048],
  [49, "ProjectionThreadsActiveOrderKey", Migration0049],
  [50, "ProjectionThreadPullRequests", Migration0050],
  [51, "ProjectionThreadMessageContext", Migration0051],
  [52, "ProjectionThreadTitleState", Migration0052],
  [53, "PullRequestFilesViewed", Migration0053],
  [54, "ProjectionThreadsAutoSettleDisabledAt", Migration0054],
  [55, "DotConnections", Migration0055],
  [56, "DotOAuth", Migration0056],
  [57, "WorkerChatLookupIndex", Migration0057],
  [58, "DotNativeChat", Migration0058],
  [59, "DotReplyRecovery", Migration0059],
  [60, "DurableRoutes", Migration0060],
  [61, "AutoModelAdmissions", Migration0061],
  [62, "TaskOwnerBindings", Migration0062],
  [63, "ProjectionThreadBotIdentity", Migration0063],
  [64, "BotRoutineRuns", Migration0064],

  // Upstream source 055?096 runs in original order after J1's released tail.
  // Preserve this migration's schema. Future V2 schema changes need new migrations.
  [65, "OrchestrationV2", UpstreamMigration0055],
  [66, "RemoveRedundantProjectionIndexes", UpstreamMigration0056],
  [67, "ScheduledTaskWebhooks", UpstreamMigration0057],
  [68, "WebhookRelayDeliveries", UpstreamMigration0058],
  [69, "McpAppModelContext", UpstreamMigration0059],
  [70, "ThreadSnapshotWindowIndexes", UpstreamMigration0060],
  [71, "PullRequestReviewGuides", UpstreamMigration0061],
  [72, "ThreadFailureLookupIndex", UpstreamMigration0062],
  [73, "DropUnusedV1Projections", UpstreamMigration0063],
  [74, "CanonicalizeThreadPullRequestLinks", UpstreamMigration0064],
  [75, "CodexUsageNativeTurnIndex", UpstreamMigration0065],
  [76, "RepairClientSettlementTimestamps", UpstreamMigration0066],
  [77, "WebhookDedupe", UpstreamMigration0067],
  [78, "ShellStopRequestIndex", UpstreamMigration0068],
  [79, "ThreadMessageSearch", UpstreamMigration0069],
  [80, "PeerLinks", UpstreamMigration0070],
  [81, "PeerLinkFence", UpstreamMigration0071],
  [82, "WaitingLinkRequestIndex", UpstreamMigration0072],
  [83, "ActiveTurnItemIndexes", UpstreamMigration0073],
  [84, "ExcludeAttachmentPlaceholdersFromSearch", UpstreamMigration0074],
  [85, "SubagentDeliveryState", UpstreamMigration0075],
  [86, "ProjectionProjectsPinArchive", UpstreamMigration0076],
  [87, "RepairBooleanSettledOverride", UpstreamMigration0077],
  [88, "DropOrchestrationEventCorrelationIndex", UpstreamMigration0078],
  [89, "DelegatedRecoveryIndexes", UpstreamMigration0079],
  [90, "ScheduledTaskThreadMode", UpstreamMigration0080],
  [91, "ProjectionMessageSearchText", UpstreamMigration0081],
  [92, "TurnItemConversationIndex", UpstreamMigration0082],
  [93, "CommandReadIndexes", UpstreamMigration0083],
  [94, "LastExecutedRunIndex", UpstreamMigration0084],
  [95, "TurnItemCounts", UpstreamMigration0085],
  [96, "QueuedTurnInputIndex", UpstreamMigration0086],
  [97, "ProjectionProjectsCustomTitle", UpstreamMigration0087],
  [98, "TurnItemTypeStatusIndex", UpstreamMigration0088],
  [99, "ShellThreadReadIndexes", UpstreamMigration0089],
  [100, "AuthConnectDevices", UpstreamMigration0090],
  [101, "AuthConnectDeniedRequests", UpstreamMigration0091],
  [102, "QueuedTurnInputIndexJsonValid", UpstreamMigration0092],
  [103, "ProviderTurnAttemptIndex", UpstreamMigration0093],
  [104, "TurnItemMessageOrdinalIndex", UpstreamMigration0094],
  [105, "TurnItemInlineWorkOutput", UpstreamMigration0095],
  [106, "RepairStaleTitleRegeneration", UpstreamMigration0096],
  [107, "RequiredWorktreeLaunchJournal", RequiredWorktreeLaunchJournal],
  [108, "ProjectionProjectsTrackedFolders", ProjectionProjectsTrackedFolders],
  [109, "TaskFolders", TaskFolders],
  [110, "Workflows", Workflows],
  [111, "WorkflowSkippedRuns", WorkflowSkippedRuns],
  [112, "WorkflowRunIndexes", WorkflowRunIndexes],
  [113, "WorkflowRunTags", WorkflowRunTags],
  [114, "WorkflowMailSender", WorkflowMailSender],
  [115, "WorkflowPools", WorkflowPools],
  [116, "WorkflowRunSubject", WorkflowRunSubject],
] as const;

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

export const FIRST_V2_MIGRATION_ID = 65;
/** Translate an upstream migration's source ID, never a recorded J1 ledger ID. */
export function canonicalUpstreamMigrationId(sourceId: number): number {
  if (!Number.isInteger(sourceId) || sourceId < 1 || sourceId > 96) {
    throw new RangeError(`Unsupported upstream migration source ID: ${sourceId}`);
  }
  return sourceId < 55 ? sourceId : sourceId + (FIRST_V2_MIGRATION_ID - 55);
}

export const latestMigrationId = Math.max(...migrationEntries.map(([id]) => id));

type RecordedMigration = { readonly id: number; readonly name: string };

/** Also called by the read-only launcher preflight. All recorded rows must form an exact prefix. */
export function skippedV2Migrations(recorded: ReadonlyArray<RecordedMigration>): string[] {
  const names = new Map<number, string>(migrationManifest);
  const recordedNames = new Map(recorded.map(({ id, name }) => [id, name]));
  const latest = Math.max(0, ...recorded.map(({ id }) => id));
  return [
    ...recorded.flatMap(({ id, name }) =>
      !Number.isInteger(id) || !names.has(id) ? [`${id}_${name} (unknown to this build)`] : [],
    ),
    ...(recordedNames.size !== recorded.length ? ["duplicate migration IDs"] : []),
    ...migrationManifest.flatMap(([id, name]) => {
      const actual = recordedNames.get(id);
      return id <= latest && actual !== name
        ? [`${id}_${name} (recorded: ${actual ?? "nothing"})`]
        : [];
    }),
  ];
}

const loadMigrationHistory = Effect.fn("loadMigrationHistory")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables =
    yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
  if (tables.length === 0) return [];
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations
  `;
  return rows.map((row) => ({ id: row.migration_id, name: row.name }));
});

export const validateMigrationHistory = Effect.fn("validateMigrationHistory")(function* () {
  const history = yield* loadMigrationHistory();
  const issues = skippedV2Migrations(history);
  if (issues.length > 0) {
    return yield* new Migrator.MigrationError({
      kind: "BadState",
      message: `Incompatible database migration history: ${issues.join(", ")}. No migrations were applied.`,
    });
  }
  const sql = yield* SqlClient.SqlClient;
  const latest = Math.max(0, ...history.map(({ id }) => id));
  const objects = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
  `;
  const present = new Set(objects.map(({ name }) => name));
  if (latest === 0 && objects.some(({ name }) => name !== "effect_sql_migrations")) {
    return yield* new Migrator.MigrationError({
      kind: "BadState",
      message: "Refusing to migrate a non-empty database without a known ledger.",
    });
  }

  const requiredObjects = [
    [55, "dot_connections"],
    [55, "dot_task_requests"],
    [56, "dot_oauth_setup"],
    [56, "dot_oauth_requests"],
    [56, "dot_oauth_codes"],
    [56, "dot_oauth_tokens"],
    [58, "dot_chat_messages"],
    [58, "dot_chat_subscriptions"],
    [58, "dot_chat_outbox"],
    [58, "dot_chat_revision"],
    [60, "durable_routes"],
    [61, "auto_model_admissions"],
    [62, "task_owner_bindings"],
    [64, "bot_routine_runs"],
    [FIRST_V2_MIGRATION_ID, "orchestration_v2_projection_threads"],
    [FIRST_V2_MIGRATION_ID, "orchestration_v2_legacy_imports"],
  ] as const;
  const missing: string[] = requiredObjects.flatMap(([id, object]) =>
    latest >= id && !present.has(object) ? [object] : [],
  );
  // Upstream's drop at combined ID 73 removes the activities table and its index.
  if (latest >= 57 && latest < 73 && !present.has("idx_projection_worker_chat_lookup")) {
    missing.push("idx_projection_worker_chat_lookup");
  }
  if (latest >= 59) {
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(dot_chat_outbox)`;
    for (const name of ["reminder_count", "event_created_at", "reply_due_at"]) {
      if (!columns.some((column) => column.name === name)) missing.push(`dot_chat_outbox.${name}`);
    }
  }
  if (latest >= 63) {
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
    if (!columns.some(({ name }) => name === "bot_identity_json")) {
      missing.push("projection_threads.bot_identity_json");
    }
  }
  if (missing.length > 0) {
    return yield* new Migrator.MigrationError({
      kind: "BadState",
      message: `Migration ledger is missing required schema: ${missing.join(", ")}.`,
    });
  }
  return latest;
});

export const hasPendingMigrations = Effect.fn("hasPendingMigrations")(function* () {
  const latest = yield* validateMigrationHistory();
  return latest < latestMigrationId;
});

const run = Migrator.make({});

interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  const latestRecordedId = yield* validateMigrationHistory();
  const pending = migrationEntries.filter(
    ([id]) =>
      id > latestRecordedId && (toMigrationInclusive === undefined || id <= toMigrationInclusive),
  );
  if (pending.length > 0) yield* Effect.log(DATABASE_MIGRATIONS_STARTED_MESSAGE);
  // One transaction per migration: an index build on a large database can take minutes, and a
  // restart then resumes after the last finished migration instead of rolling all of them back.
  const executedMigrations: Array<readonly [id: number, name: string]> = [];
  for (const [index, [id, name]] of pending.entries()) {
    if (latestRecordedId > 0) {
      yield* Effect.log(DATABASE_MIGRATION_PROGRESS_MESSAGE).pipe(
        Effect.annotateLogs({
          migration: `${id}_${name}`,
          progress: `${index + 1} of ${pending.length}`,
        }),
      );
    }
    executedMigrations.push(...(yield* run({ loader: makeMigrationLoader(id) })));
  }
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log(DATABASE_MIGRATIONS_FINISHED_MESSAGE).pipe(Effect.annotateLogs({ migrations }));

  return executedMigrations;
});
