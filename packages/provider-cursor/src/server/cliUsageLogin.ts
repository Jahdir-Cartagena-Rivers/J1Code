import * as NodeOS from "node:os";
import * as HostProcess from "@j1code/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { DEFAULT_CURSOR_API_ENDPOINT } from "./apiKey.ts";

const decodeLogin = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ accessToken: Schema.optionalKey(Schema.String) })),
);

class CursorKeychainReadError extends Schema.TaggedError<CursorKeychainReadError>()(
  "CursorKeychainReadError",
  { cause: Schema.Defect() },
) {}

export type CursorCliUsageLogin =
  | { readonly kind: "token"; readonly accessToken: string }
  | { readonly kind: "unavailable"; readonly message: string; readonly enableKeychain?: true };

export const cursorUsageEndpoint = (apiEndpoint: string | undefined, environment: NodeJS.ProcessEnv) =>
  (apiEndpoint?.trim() || environment.CURSOR_API_ENDPOINT?.trim() || DEFAULT_CURSOR_API_ENDPOINT)
    .replace(/\/$/, "");

export const readCursorCliUsageLogin = Effect.fn("readCursorCliUsageLogin")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly endpoint: string;
  readonly allowKeychain: boolean;
  readonly readKeychain?: (() => Promise<string | null>) | undefined;
  readonly platform?: NodeJS.Platform;
}) {
  const { environment, endpoint, allowKeychain, readKeychain } = input;
  const platform = input.platform ?? (yield* HostProcess.Platform);
  const unavailable = (message: string): CursorCliUsageLogin => ({ kind: "unavailable", message });
  const store = environment.AGENT_CLI_CREDENTIAL_STORE;
  const signIn = "Sign in with the Cursor CLI on this environment to read account usage.";
  if (store === "memory") return unavailable(signIn);

  if (endpoint !== DEFAULT_CURSOR_API_ENDPOINT) {
    return unavailable("Cursor CLI account usage requires the default Cursor endpoint.");
  }

  if (platform === "darwin" && store !== "file") {
    if (!allowKeychain) {
      return {
        kind: "unavailable",
        message: "Enable Cursor account usage in J1 Code to read its Keychain login.",
        enableKeychain: true,
      } satisfies CursorCliUsageLogin;
    }
    if (readKeychain === undefined) return unavailable(signIn);
    const token = yield* Effect.tryPromise({
      try: readKeychain,
      catch: (cause) => new CursorKeychainReadError({ cause }),
    }).pipe(
      Effect.map((value) => value?.trim()),
      Effect.orElseSucceed(() => undefined),
    );
    return token
      ? { kind: "token" as const, accessToken: token }
      : unavailable("Allow access to the Cursor CLI login on the Mac running J1 Code, then refresh.");
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = (platform === "win32" ? environment.USERPROFILE : environment.HOME) || NodeOS.homedir();
  const config = environment.XDG_CONFIG_HOME?.trim();
  const directory =
    platform === "win32"
      ? path.join(environment.APPDATA || path.join(home, "AppData", "Roaming"), "Cursor")
      : platform === "darwin"
        ? path.join(home, ".cursor")
        : path.join(config && path.isAbsolute(config) ? config : path.join(home, ".config"), "cursor");
  return yield* fs.readFileString(path.join(directory, "auth.json")).pipe(
    Effect.flatMap(decodeLogin),
    Effect.map(({ accessToken }): CursorCliUsageLogin => {
      const token = accessToken?.trim();
      return token ? { kind: "token", accessToken: token } : unavailable(signIn);
    }),
    Effect.catch((error) =>
      Effect.succeed(unavailable(
        error._tag === "PlatformError" && error.reason._tag === "NotFound"
          ? signIn
          : "Cursor CLI credentials could not be read.",
      )),
    ),
  );
});
