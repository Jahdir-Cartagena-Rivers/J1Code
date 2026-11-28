import * as NodeModule from "node:module";
import * as Schema from "effect/Schema";

const CACHE_MS = 5 * 60_000;

const requireForKeyring = NodeModule.createRequire(import.meta.url);

/** Rejected when nobody answers the macOS Keychain prompt in time. */
export class CursorKeychainTimeoutError extends Schema.TaggedError<CursorKeychainTimeoutError>()(
  "CursorKeychainTimeoutError",
  { message: Schema.String },
) {}

/**
 * Remote clients cannot answer the server's Keychain prompt. Keep its read in flight
 * after a caller times out so a retry reuses the prompt and picks up an eventual approval.
 */
export function makeCachedCursorAccessTokenReader(
  read: () => Promise<string | null>,
  now: () => number = Date.now,
  timeoutMs = 30_000,
): () => Promise<string | null> {
  let cached: { token: string; until: number } | null = null;
  let pending: Promise<string | null> | null = null;
  return () => {
    if (cached && cached.until > now()) return Promise.resolve(cached.token);
    pending ??= read()
      .then((token) => {
        cached = token ? { token, until: now() + CACHE_MS } : null;
        return token;
      })
      .finally(() => {
        pending = null;
      });
    const deadline = AbortSignal.timeout(timeoutMs);
    return Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        deadline.addEventListener(
          "abort",
          () =>
            reject(
              new CursorKeychainTimeoutError({ message: "Timed out waiting for Keychain access." }),
            ),
          { once: true },
        );
      }),
    ]);
  };
}

/** Read the Cursor CLI's default macOS credential without invoking the shared security binary. */
export const readMacCursorAccessToken = makeCachedCursorAccessTokenReader(async () => {
  const { AsyncEntry } = requireForKeyring("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
  return (await new AsyncEntry("cursor-access-token", "cursor-user").getPassword()) ?? null;
});
