import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProviderDriverKind, ProviderSetupError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ServerConfig } from "../../config.ts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import * as ProviderCredentialStore from "../ProviderCredentialStore.ts";
import * as ProviderAuthFlow from "../ProviderAuthFlow.ts";
import type { ProviderDriver } from "../ProviderDriver.ts";
import { defaultProviderContinuationIdentity } from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { buildServerProvider } from "../providerSnapshot.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { makeDeepAIAdapter } from "../deepai/DeepAIAdapter.ts";
import { DeepAIRequestError, makeDeepAIClient } from "../deepai/DeepAIClient.ts";
import { makeDeepAITextGeneration } from "../deepai/DeepAITextGeneration.ts";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { deepAIMachineDigest } from "../deepai/DeepAIMachine.ts";
import { makeDeepAIVision } from "../deepai/DeepAIVision.ts";
import { deepAIModelCapabilities } from "../deepai/DeepAIModelCapabilities.ts";

const DRIVER = ProviderDriverKind.make("deepai");
const Config = Schema.Struct({
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
  | Crypto.Crypto;

export const DeepAIDriver: ProviderDriver<typeof Config.Type, DeepAIDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "DeepAI", supportsMultipleInstances: true },
  configSchema: Config,
  defaultConfig: () => ({}),
  create: ({ instanceId, enabled, displayName, accentColor, config: providerConfig }) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const store = yield* ProviderCredentialStore.make("deepai", instanceId);
      const context = yield* Effect.context<never>();
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
      const adapter = yield* makeDeepAIAdapter({
        client,
        instanceId,
        credentials,
        catalog,
        attachmentsDir: config.attachmentsDir,
        ...(providerConfig.visionEndpoint && providerConfig.visionModel
          ? {
              describeImages: makeDeepAIVision({
                endpoint: providerConfig.visionEndpoint,
                model: providerConfig.visionModel,
              }),
            }
          : {}),
        directory: NodePath.join(config.stateDir, "providers", "deepai", instanceId),
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
            const accountFile = NodePath.join(
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
              requiresNewThreadForModelChange: true,
              showInteractionModeToggle: false,
            },
            enabled,
            checkedAt: new Date().toISOString(),
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
        adapter,
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
