import * as NodeOS from "node:os";
import { ProviderDriverKind, ProviderSetupError } from "@j1code/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import { describeWithCodex } from "../deepai/DeepAICodexVision.ts";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ServerConfig } from "../../config.ts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import * as ProviderCredentialStore from "../ProviderCredentialStore.ts";
import * as ProviderAuthFlow from "@j1code/provider-core/server/providerAuthFlow";
import type { ProviderDriver } from "@j1code/provider-core/server/driver";
import { defaultProviderContinuationIdentity } from "@j1code/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@j1code/provider-core/server/maintenanceResolver";
import { buildServerProvider } from "@j1code/provider-core/server/snapshotProbe";
import { withInstanceIdentity } from "@j1code/provider-core/server/instanceIdentity";
import { makeDeepAIAdapter } from "../deepai/DeepAIAdapter.ts";
import { DeepAIRequestError, makeDeepAIClient } from "../deepai/DeepAIClient.ts";
import { makeDeepAITextGeneration } from "../deepai/DeepAITextGeneration.ts";

import { HostProcessPlatform } from "@j1code/shared/hostProcess";
import { deepAIMachineDigest } from "../deepai/DeepAIMachine.ts";
import { makeDeepAIVision } from "../deepai/DeepAIVision.ts";
import { deepAIModelCapabilities } from "../deepai/DeepAIModelCapabilities.ts";

const DRIVER = ProviderDriverKind.make("deepai");
const Config = Schema.Struct({
  codexVisionFallback: Schema.optionalKey(Schema.Boolean),
  visionEndpoint: Schema.optionalKey(Schema.String),
  visionModel: Schema.optionalKey(Schema.NonEmptyString),
}).check(
  Schema.makeFilter(
    (value) =>
      Boolean(value.visionEndpoint) === Boolean(value.visionModel) ||
      "Set both the vision endpoint and vision model, or remove both.",
  ),
);
const Account = Schema.fromJsonString(Schema.Struct({ apiKey: Schema.NonEmptyString }));
const decodeAccount = Schema.decodeUnknownSync(Account);
export type DeepAIDriverEnv =
  | ServerConfig
  | ServerSecretStore
  | FileSystem.FileSystem
  | Digest.Digest
  | SecureRandom.SecureRandom
  | SqlClient.SqlClient
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner;

export const DeepAIDriver: ProviderDriver<typeof Config.Type, DeepAIDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "DeepAI", supportsMultipleInstances: true },
  configSchema: Config,
  defaultConfig: () => ({}),
  create: ({ instanceId, enabled, displayName, accentColor, config: providerConfig }) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const clock = yield* Clock.Clock;
      const store = yield* ProviderCredentialStore.make("deepai", instanceId);
      const context = yield* Effect.context<DeepAIDriverEnv>();
      const run = Effect.runPromiseWith(context);
      const platform = yield* HostProcessPlatform;
      const machineDigest = yield* Effect.promise(() => deepAIMachineDigest(platform));
      const client = makeDeepAIClient({ ...(machineDigest ? { machineDigest } : {}) });
      const credentials = async () => {
        const stored = await run(store.get);
        if (Option.isNone(stored)) throw new Error("Sign in to DeepAI first.");
        return new TextDecoder().decode(stored.value);
      };
      const catalog = () => client.models(AbortSignal.timeout(15000));
      const runtimeBindings = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository.pipe(
        Effect.provide(ProviderSessionRuntime.layer),
      );
      const orchestrationAdapter = yield* makeDeepAIAdapter({
        client,
        instanceId,
        credentials,
        catalog,
        attachmentsDir: config.attachmentsDir,
        legacyHistory: (threadId) => runtimeBindings.getByThreadId({ threadId }).pipe(
          Effect.map((binding) => {
            if (Option.isNone(binding)) return undefined;
            const cursor = binding.value.resumeCursor;
            if (cursor === null || typeof cursor !== "object" || !("sessionFile" in cursor)) return undefined;
            if (typeof cursor.sessionFile !== "string") return undefined;
            return {
              threadId: binding.value.threadId,
              providerName: binding.value.providerName,
              providerInstanceId: binding.value.providerInstanceId,
              sessionFile: cursor.sessionFile,
            };
          }),
        ),
        ...(providerConfig.codexVisionFallback
          ? {
              visionLabel: "Codex vision (uses Codex subscription allowance)",
              describeImages: (
                question: string,
                images: ReadonlyArray<{ data: string; mimeType: string }>,
                signal?: AbortSignal,
              ) => Effect.runPromiseWith(context)(describeWithCodex(question, images), { signal }),
            }
          : providerConfig.visionEndpoint && providerConfig.visionModel
            ? {
                describeImages: makeDeepAIVision({
                  endpoint: providerConfig.visionEndpoint,
                  model: providerConfig.visionModel,
                }),
              }
            : {}),
        directory: paths.join(config.stateDir, "providers", "deepai", instanceId),
      });
      const setupError = (cause?: unknown) =>
        new ProviderSetupError({
          instanceId,
          operation: "authenticate",
          detail:
            cause instanceof DeepAIRequestError
              ? cause.message
              : "Sign in to DeepAI Code on this server first, then import the account again.",
        });
      let refreshAfterAuth: Effect.Effect<void> = Effect.void;
      const auth = yield* ProviderAuthFlow.make({
        instanceId,
        credentialBinding: store.binding,
        methods: Effect.succeed([
          {
            id: "import",
            name: "Import DeepAI Code account",
            description: "Use the DeepAI Code account signed in on this server.",
            type: "agent",
          },
        ]),
        defaultMethodId: "import",
        authenticate: () =>
          Effect.gen(function* () {
            const accountFile = paths.join(
              NodeOS.homedir(),
              ".deepai-code",
              "userdata",
              "secrets",
              "deepai-account.bin",
            );
            const text = yield* fs.readFileString(accountFile).pipe(Effect.mapError(setupError));
            const account = yield* Effect.try({
              try: () => decodeAccount(text),
              catch: setupError,
            });
            const allowance = yield* Effect.tryPromise({
              try: (signal) => client.allowance(account.apiKey, signal),
              catch: setupError,
            });
            if (!allowance.enabled) return yield* setupError();
            yield* store
              .set(new TextEncoder().encode(account.apiKey))
              .pipe(Effect.mapError(setupError));
            yield* refreshAfterAuth;
          }),
        logout: store.remove.pipe(
          Effect.mapError(setupError),
          Effect.tap(() => refreshAfterAuth),
        ),
      });
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId,
      });
      const stamp = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const snapshot = Effect.promise(async () => {
        let authenticated = false;
        let models: Awaited<ReturnType<typeof catalog>> | undefined;
        try {
          const apiKey = await credentials();
          authenticated =
            !enabled || (await client.allowance(apiKey, AbortSignal.timeout(15000))).enabled;
        } catch {
          /* Missing credentials is an ordinary state. */
        }
        if (enabled) {
          try {
            models = await catalog();
          } catch {
            /* Refresh can recover availability. */
          }
        }
        return stamp(
          buildServerProvider({
            driver: DRIVER,
            presentation: {
              displayName: "DeepAI",
              supportsConversationRollback: false,
              showInteractionModeToggle: false,
              requiresNewThreadForModelChange: true,
            },
            enabled,
            checkedAt: DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe())),
            models:
              models?.models.map((model) => ({
                slug: model.id,
                name: model.name,
                isDefault: models?.default === model.id,
                isCustom: false,
                capabilities: deepAIModelCapabilities(model),
              })) ?? [],
            probe: {
              installed: true,
              version: "1.5.1",
              status: authenticated && models ? "ready" : "warning",
              auth: { status: authenticated ? "authenticated" : "unauthenticated", type: "deepai" },
              ...(!authenticated
                ? { message: "Import your signed-in DeepAI Code account to connect." }
                : {}),
            },
          }),
        );
      });
      const snapshots = yield* SubscriptionRef.make(yield* snapshot);
      const refresh = snapshot.pipe(Effect.tap((value) => SubscriptionRef.set(snapshots, value)));
      refreshAfterAuth = refresh.pipe(Effect.asVoid);
      return {
        instanceId,
        driverKind: DRIVER,
        continuationIdentity,
        displayName,
        enabled,
        ...(accentColor ? { accentColor } : {}),
        orchestrationAdapter,
        auth,
        snapshot: {
          resolveMaintenance: () =>
            Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({
                provider: DRIVER,
                packageName: null,
              }),
            ),
          getSnapshot: SubscriptionRef.get(snapshots),
          refresh,
          streamChanges: SubscriptionRef.changes(snapshots),
          applyUsageLimits: () => Effect.void,
        },
        textGeneration: makeDeepAITextGeneration({ credentials, catalog, client }),
      };
    }),
};
