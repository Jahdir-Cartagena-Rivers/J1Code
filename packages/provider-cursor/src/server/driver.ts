import {
  ProviderDriverKind,
  ProviderSetupError,
  type ServerProviderModel,
  type ServerSettings,
} from "@j1code/contracts";
import { CursorSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import { cursorRateModel } from "./accountUsage.ts";
import { readCursorUsageLimits } from "./usageLimits.ts";
import { readCursorCliUsageLogin } from "./cliUsageLogin.ts";

import * as ProviderHost from "@j1code/provider-core/server/ProviderHost";
import { makeCursorTextGeneration } from "./textGeneration.ts";
import { makeCursorAdapterV2, type CursorAdapterV2DriverEnv } from "./adapter.ts";
import { ProviderDriverError } from "@j1code/provider-core/server/errors";
import { buildInitialCursorProviderSnapshot, checkCursorProviderStatus } from "./status.ts";
import * as CursorSdkCatalog from "./CursorSdkCatalog.ts";
import { makeManagedServerProvider } from "@j1code/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@j1code/provider-core/server/driver";
import { withInstanceIdentity } from "@j1code/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@j1code/provider-core/server/instanceEnvironment";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@j1code/provider-core/server/maintenanceResolver";
import { haveProviderSnapshotSettingsChanged } from "@j1code/provider-core/server/snapshotSettings";
import { probeCursorSkills } from "./skills.ts";
import { makeCursorAuth } from "./auth.ts";
import * as CursorCredentialStore from "./credentialStore.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import * as CursorSdk from "./CursorSdk.ts";
import * as CursorUsageAccounts from "./CursorUsageAccounts.ts";
import type * as ProviderAdapter from "@j1code/provider-core/server/ProviderAdapter";
import type { ProviderInstanceId } from "@j1code/contracts";
import type { CursorAuth } from "./auth.ts";

const decodeCursorSettings = Schema.decodeSync(CursorSettings);
const isSdkRunnerError = Schema.is(CursorAgentSdk.CursorAgentSdkRunnerError);

const DRIVER_KIND = ProviderDriverKind.make("cursor");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type CursorDriverEnv =
  | CursorAdapterV2DriverEnv
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | CursorSdk.CursorSdk
  | ProviderHost.ProviderHost;

export interface CursorAdapterComposition {
  readonly instanceId: ProviderInstanceId;
  readonly config: CursorSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly auth: Pick<CursorAuth, "requireApiKey" | "withAccess">;
  readonly sdk: ProviderAdapter.ProviderAdapterV2["Service"];
}

export const makeCursorDriver = <R = never>(
  compose?: (input: CursorAdapterComposition) => Effect.Effect<ProviderAdapter.ProviderAdapterV2["Service"], never, R>,
): ProviderDriver<
  CursorSettings,
  CursorDriverEnv | R,
  CursorUsageAccounts.CursorUsageAccounts
> => ({
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Cursor",
    supportsMultipleInstances: true,
  },
  configSchema: CursorSettings,
  defaultConfig: (): CursorSettings => decodeCursorSettings({}),
  usage: {
    kind: "scan",
    provider: "cursor",
    rateModel: cursorRateModel,
    scan: ({ instances, settings, windowStartMs, retentionCutoffMs, awaitRefresh }) =>
      CursorUsageAccounts.CursorUsageAccounts.pipe(
        Effect.flatMap((accounts) =>
          accounts.scan({
            instances,
            allowKeychain: settings.cursorKeychainUsageEnabled,
            windowStartMs,
            retentionCutoffMs,
            awaitRefresh,
          }),
        ),
      ),
  },
  create: Effect.fn("CursorDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const host = yield* ProviderHost.ProviderHost;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    const sdkRunner = yield* CursorAgentSdk.CursorAgentSdkRunner;
    const processEnv = yield* mergeProviderInstanceEnvironment(environment);
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: displayName ?? "Cursor",
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies CursorSettings;
    const credentials = yield* CursorCredentialStore.makeCursorCredentialStore(
      instanceId,
      path.join(
        host.paths.stateDir,
        "provider-auth",
        encodeURIComponent(instanceId),
        "cursor.json",
      ),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Could not open the Cursor credential store.",
            cause,
          }),
      ),
    );
    const auth = yield* makeCursorAuth({
      instanceId,
      displayName: displayName ?? "Cursor",
      enabled,
      ...(processEnv.CURSOR_API_KEY ? { apiKey: processEnv.CURSOR_API_KEY } : {}),
      store: credentials.store,
      credentialBinding: credentials.binding,
      onChanged: (signedIn): Effect.Effect<void, ProviderSetupError> =>
        snapshot.refresh.pipe(
          Effect.flatMap((provider) =>
            !signedIn || provider.auth.status === "authenticated"
              ? Effect.void
              : Effect.fail(
                  new ProviderSetupError({
                    instanceId,
                    operation: "start",
                    detail: provider.message ?? "Could not verify the Cursor sign-in. Try again.",
                  }),
                ),
          ),
        ),
    });
    const stampSnapshot: typeof stampIdentity = (draft) =>
      stampIdentity({
        ...draft,
        setup: { canAuthenticate: !auth.usesApiKey, canInstall: false },
        auth: {
          ...draft.auth,
          canLogout: !auth.usesApiKey,
        },
      });

    let catalogModels: ReadonlyArray<ServerProviderModel> = [];
    const sdk = yield* makeCursorAdapterV2({
      instanceId,
      environment: processEnv,
      getModels: () => catalogModels,
    }).pipe(
      Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
        ...sdkRunner,
        open: (input) =>
          auth.requireApiKey.pipe(
            Effect.flatMap((apiKey) =>
              Effect.acquireRelease(
                sdkRunner
                  .open({ ...input, options: { ...input.options, apiKey } })
                  .pipe(
                    Effect.flatMap((session) =>
                      Effect.cached(session.close).pipe(
                        Effect.map((close) => ({ ...session, close })),
                      ),
                    ),
                  ),
                (session) => session.close.pipe(Effect.ignore),
              ),
            ),
            auth.withAccess,
            Effect.mapError((cause) =>
              isSdkRunnerError(cause)
                ? cause
                : new CursorAgentSdk.CursorAgentSdkRunnerError({ method: "open", cause }),
            ),
          ),
      }),
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Cursor orchestration adapter.",
            cause,
          }),
      ),
    );
    const orchestrationAdapter = compose === undefined ? sdk : yield* compose({
      instanceId, config: effectiveConfig, environment: processEnv, auth, sdk,
    });
    const textGeneration = yield* makeCursorTextGeneration(
      effectiveConfig,
      processEnv,
      auth.requireApiKey,
      auth.withAccess,
      () => catalogModels,
    );

    const readCliUsageLogin = (endpoint: string) =>
      host.settings.get.pipe(
        Effect.flatMap((settings) =>
          readCursorCliUsageLogin({
            environment: processEnv,
            endpoint,
            allowKeychain: settings.cursorKeychainUsageEnabled,
            readKeychain: host.readCursorKeychainToken,
          }),
        ),
        Effect.orElseSucceed(() => ({
          kind: "unavailable" as const,
          message: "Cursor CLI usage settings could not be read.",
        })),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
    const checkProvider = auth.readApiKey.pipe(
      Effect.result,
      Effect.flatMap((keyResult) => {
        const apiKey = Result.isSuccess(keyResult) ? keyResult.success : undefined;
        return checkCursorProviderStatus(
          effectiveConfig,
          {
            ...processEnv,
            CURSOR_API_KEY: apiKey,
          },
          auth.usesApiKey ? "api-key" : "browser",
        ).pipe(
          Effect.filterOrElse(
            (snapshot) =>
              !(
                effectiveConfig.enabled &&
                snapshot.installed &&
                Result.isSuccess(keyResult) &&
                (snapshot.auth.status === "authenticated" || apiKey === undefined)
              ),
            (snapshot) =>
              readCursorUsageLimits(
                effectiveConfig,
                { ...processEnv, CURSOR_API_KEY: apiKey },
                readCliUsageLogin,
              ).pipe(Effect.map((usageLimits) => ({ ...snapshot, usageLimits }))),
          ),
        );
      }),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.map(stampSnapshot),
      Effect.tap((provider) =>
        Effect.sync(() => {
          // A failed check lists only custom models, so keep the last loaded catalog.
          if (provider.models.some((model) => !model.isCustom)) {
            catalogModels = provider.models;
          }
        }),
      ),
      Effect.provide(CursorSdkCatalog.layer),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

    const snapshotSettings = (settings: ServerSettings) => ({
      provider: effectiveConfig,
      enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
      cursorKeychainUsageEnabled: settings.cursorKeychainUsageEnabled,
    });
    const snapshot = yield* makeManagedServerProvider<ReturnType<typeof snapshotSettings>>({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
      getSettings: host.settings.get.pipe(Effect.map(snapshotSettings)),
      streamSettings: host.settings.changes.pipe(Stream.map(snapshotSettings)),
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialCursorProviderSnapshot(settings.provider).pipe(Effect.map(stampSnapshot)),
      checkProvider,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Cursor snapshot.",
            cause,
          }),
      ),
    );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      auth: auth.controller,
      snapshot,
      snapshotForCwd: (cwd) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              probeCursorSkills(cwd, processEnv).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER_KIND,
                      instanceId,
                      detail: `Failed to discover Cursor skills for '${cwd}'`,
                      cause,
                    }),
                ),
              ),
            ]).pipe(Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills }))),
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
});

export const CursorDriver = makeCursorDriver();
