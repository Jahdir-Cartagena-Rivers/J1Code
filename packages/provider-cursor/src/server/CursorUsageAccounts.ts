import type { ProviderInstanceId } from "@j1code/contracts";
import * as ProviderHost from "@j1code/provider-core/server/ProviderHost";
import type { ProviderUsageScan } from "@j1code/provider-core/server/usage";
import { writeFileStringAtomically } from "@j1code/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  CURSOR_ACCOUNT_CACHE_FILE_NAME,
  CURSOR_ACCOUNT_TTL_MS,
  cursorFetchRange,
  decodeCursorAccountCaches,
  encodeCursorAccountCaches,
  isCursorCacheFresh,
  mergeCursorFetch,
  type CursorAccountCache,
  type CursorCredentialSource,
} from "./accountCache.ts";
import * as CursorAccountReader from "./CursorAccountReader.ts";
import { readStoredCursorApiKey } from "./credentialStore.ts";
import { cursorUsageEndpoint, readCursorCliUsageLogin } from "./cliUsageLogin.ts";
import { DEFAULT_CURSOR_API_ENDPOINT } from "./apiKey.ts";

const CURSOR_ACCOUNT_READ_ERROR = "Cursor account usage could not be read.";

const decodeCacheFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>),
);

export class CursorUsageAccounts extends Context.Service<
  CursorUsageAccounts,
  {
    readonly scan: (input: {
      readonly instances: ReadonlyArray<{
        readonly instanceId: ProviderInstanceId;
        readonly environment: NodeJS.ProcessEnv;
        readonly config?: { readonly apiEndpoint?: string } | undefined;
        readonly configured?: boolean;
      }>;
      readonly allowKeychain?: boolean;
      readonly windowStartMs: number;
      readonly retentionCutoffMs: number;
      readonly awaitRefresh: boolean;
    }) => Effect.Effect<ReadonlyArray<ProviderUsageScan>>;
    readonly awaitPersisted: Effect.Effect<void>;
  }
>()("@j1code/provider-cursor/server/CursorUsageAccounts") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* ProviderHost.ProviderHost;
  const accountReader = yield* CursorAccountReader.CursorAccountReader;
  const digest = yield* Digest.Digest;

  const cachePath = path.join(host.paths.stateDir, CURSOR_ACCOUNT_CACHE_FILE_NAME);
  const caches = new Map<string, CursorAccountCache>();
  let cacheDirty = false;
  /** Failed refreshes share the cache TTL to prevent repeated requests; null means no login. */
  const failures = new Map<string, { readonly atMs: number; readonly error: string | null }>();
  const refreshes = new Map<string, Deferred.Deferred<void>>();

  const ensureLoaded = yield* Effect.cached(
    fileSystem.readFileString(cachePath).pipe(
      Effect.flatMap((raw) => decodeCacheFile(raw)),
      Effect.catchCause(() => Effect.succeed(null)),
      Effect.map((document) => {
        for (const [key, cache] of decodeCursorAccountCaches(document)) caches.set(key, cache);
      }),
    ),
  );

  // Serialize snapshots; clear dirty before encoding and restore it on failure so changes retry.
  const persistLock = yield* Semaphore.make(1);
  const persist = Effect.gen(function* () {
    if (!cacheDirty) return;
    cacheDirty = false;
    yield* Effect.sync(() => encodeCursorAccountCaches(caches)).pipe(
      Effect.flatMap((contents) => writeFileStringAtomically({ filePath: cachePath, contents })),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catchCause(() =>
        Effect.sync(() => {
          cacheDirty = true;
        }),
      ),
    );
  }).pipe(persistLock.withPermit, Effect.withSpan("CursorUsageAccounts.persist"));

  const pendingPersists = new Set<Fiber.Fiber<void>>();
  const schedulePersist = Effect.forkDetach(persist).pipe(
    Effect.map((fiber) => {
      pendingPersists.add(fiber);
      fiber.addObserver(() => pendingPersists.delete(fiber));
    }),
  );
  const awaitPersisted = Effect.suspend(() => Fiber.awaitAll([...pendingPersists])).pipe(
    Effect.asVoid,
  );
  yield* Effect.addFinalizer(() => awaitPersisted);

  const refreshLock = yield* Semaphore.make(2);
  const refreshAccount = Effect.fn("CursorUsageAccounts.refreshAccount")(function* (
    credential: CursorCredentialSource,
    credentialKey: string,
    retentionStartMs: number,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    const fetchMissing = (cache: CursorAccountCache | undefined) => {
      const range = cursorFetchRange(cache, retentionStartMs, nowMs);
      return accountReader
        .read(credential, range.sinceMs, range.untilMs)
        .pipe(Effect.map((result) => ({ range, result })));
    };
    let base = caches.get(credentialKey);
    let fetched = yield* fetchMissing(base);
    if (
      base !== undefined &&
      fetched.result.accountKey !== null &&
      fetched.result.accountKey !== base.accountKey
    ) {
      caches.delete(credentialKey);
      cacheDirty = true;
      base = undefined;
      fetched = yield* fetchMissing(base);
    }
    const { range, result } = fetched;
    if (result.missing || result.error !== null || result.accountKey === null) {
      failures.set(credentialKey, {
        atMs: nowMs,
        error: result.missing || result.error !== null ? result.error : CURSOR_ACCOUNT_READ_ERROR,
      });
      yield* schedulePersist;
      return;
    }
    const merged = mergeCursorFetch(
      base,
      result.accountKey,
      range,
      result.records,
      nowMs,
      retentionStartMs,
    );
    caches.set(credentialKey, merged.cache);
    failures.delete(credentialKey);
    if (merged.changed) cacheDirty = true;
    yield* schedulePersist;
  }, refreshLock.withPermit);

  const startRefresh = (
    credential: CursorCredentialSource,
    credentialKey: string,
    retentionStartMs: number,
  ) =>
    // Enroll and fork atomically so interruption cannot strand a registered refresh.
    Effect.uninterruptible(
      Effect.gen(function* () {
        const current = refreshes.get(credentialKey);
        if (current !== undefined) return current;
        const done = Deferred.makeUnsafe<void>();
        refreshes.set(credentialKey, done);
        // Detached: a departing client must not cancel a fetch later reads reuse.
        yield* refreshAccount(credential, credentialKey, retentionStartMs).pipe(
          Effect.catchCause(() =>
            Clock.currentTimeMillis.pipe(
              Effect.map((atMs) =>
                failures.set(credentialKey, { atMs, error: CURSOR_ACCOUNT_READ_ERROR }),
              ),
            ),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              refreshes.delete(credentialKey);
              return Deferred.succeed(done, undefined);
            }),
          ),
          Effect.forkDetach,
        );
        return done;
      }),
    );

  const accountSource = Effect.fn("CursorUsageAccounts.accountSource")(function* (
    credential: CursorCredentialSource,
    windowStartMs: number,
    retentionStartMs: number,
    awaitRefresh: boolean,
  ) {
    yield* ensureLoaded;
    const [kind, secret] =
      credential.kind === "apiKey"
        ? ["api-key", credential.apiKey]
        : ["cli-login", credential.accessToken];
    const credentialKey = `${kind}:${Hex.encode(yield* digest.digest(Digest.sha256, new TextEncoder().encode(secret)))}`;
    const nowMs = yield* Clock.currentTimeMillis;
    const recentFailure = failures.get(credentialKey);
    let refreshing = false;
    if (
      (recentFailure === undefined || nowMs - recentFailure.atMs >= CURSOR_ACCOUNT_TTL_MS) &&
      !isCursorCacheFresh(caches.get(credentialKey), nowMs)
    ) {
      const refresh = yield* startRefresh(credential, credentialKey, retentionStartMs);
      if (awaitRefresh) yield* Deferred.await(refresh);
      else refreshing = true;
    }

    const cache = caches.get(credentialKey);
    const failure = refreshing ? undefined : failures.get(credentialKey);
    const failureMessage = failure === undefined ? undefined : failure.error;
    if (failureMessage === null) return null;
    if (cache === undefined) {
      return {
        dir: "cursor-account",
        ...(refreshing
          ? { files: [], refreshing: true }
          : { files: null, message: failureMessage ?? CURSOR_ACCOUNT_READ_ERROR }),
      } satisfies ProviderUsageScan;
    }
    // Account history spans machines; a stable fingerprint prevents duplicate environment counts.
    const source = `cursor-account:${cache.accountKey}`;
    return {
      dir: source,
      hostId: "cursor.com",
      volumeId: cache.accountKey,
      files: [
        {
          path: source,
          records: cache.records.filter((record) => record.timestampMs >= windowStartMs),
        },
      ],
      ...(failureMessage === undefined
        ? { status: "ok" }
        : { status: "partial", message: failureMessage }),
      ...(refreshing ? { refreshing: true } : {}),
    } satisfies ProviderUsageScan;
  });

  const scan: CursorUsageAccounts["Service"]["scan"] = Effect.fn("CursorUsageAccounts.scan")(
    function* ({ instances, allowKeychain = false, windowStartMs, retentionCutoffMs, awaitRefresh }) {
      const apiKeys = yield* Effect.forEach(instances, ({ instanceId, environment, config }) => {
        if (cursorUsageEndpoint(config?.apiEndpoint, environment) !== DEFAULT_CURSOR_API_ENDPOINT)
          return Effect.undefined;
        const key = environment.CURSOR_API_KEY?.trim();
        return key
          ? Effect.succeed(key)
          : readStoredCursorApiKey(instanceId).pipe(
              Effect.provideService(ProviderHost.ProviderHost, host),
              Effect.orElseSucceed(() => null),
            );
      });
      const uniqueApiKeys = [
        ...new Set(apiKeys.filter((apiKey): apiKey is string => typeof apiKey === "string")),
      ];
      if (uniqueApiKeys.length > 0) {
        const sources: ReadonlyArray<ProviderUsageScan | null> = yield* Effect.forEach(
          uniqueApiKeys,
          (apiKey) =>
            accountSource(
              { kind: "apiKey", apiKey },
              windowStartMs,
              retentionCutoffMs,
              awaitRefresh,
            ),
          { concurrency: 2 },
        );
        // Keys for one account share its source, and a repeated source would count sessions twice.
        // A failed key can hold older records, so a current read wins, then a refresh the client
        // must follow up on.
        const rank = (source: ProviderUsageScan) =>
          source.status === "ok" ? 2 : source.refreshing ? 1 : 0;
        const byAccount = new Map<string, ProviderUsageScan>();
        for (const source of sources) {
          if (source === null) continue;
          const kept = byAccount.get(source.dir);
          if (kept === undefined || rank(source) > rank(kept)) {
            byAccount.set(source.dir, source);
          }
        }
        return [...byAccount.values()];
      }
      const unavailable = (message: string, enableKeychain = false): ProviderUsageScan[] => [
        {
          dir: "cursor-account",
          volumeId: "",
          files: null,
          message,
          ...(enableKeychain ? { action: "enableCursorKeychain" as const } : {}),
        },
      ];
      if (apiKeys.includes(null)) return unavailable("Cursor API credentials could not be read.");
      const defaultInstance = instances.find((instance) => instance.configured === false) ?? instances[0];
      if (defaultInstance === undefined) return [];
      const { environment } = defaultInstance;
      if (instances.some((instance) => instance.environment.CURSOR_AUTH_TOKEN?.trim())) {
        return unavailable("Cursor account history needs a Cursor CLI login on this environment.");
      }
      const login = yield* readCursorCliUsageLogin({
        environment,
        endpoint: cursorUsageEndpoint(defaultInstance.config?.apiEndpoint, environment),
        allowKeychain,
        readKeychain: host.readCursorKeychainToken,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      if (login.kind === "unavailable") return unavailable(login.message, login.enableKeychain);
      const source = yield* accountSource(
        { kind: "cliLogin", accessToken: login.accessToken },
        windowStartMs,
        retentionCutoffMs,
        awaitRefresh,
      );
      return source === null ? [] : [source];
    },
  );

  return CursorUsageAccounts.of({ scan, awaitPersisted });
});

export const layer = Layer.effect(CursorUsageAccounts, make);
