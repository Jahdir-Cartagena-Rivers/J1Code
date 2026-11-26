import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@j1code/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { DEFAULT_CURSOR_API_ENDPOINT } from "./apiKey.ts";
import { readCursorCliUsageLogin } from "./cliUsageLogin.ts";

it.effect("never reads Keychain before opt-in, on a custom endpoint, or in memory mode", () =>
  Effect.gen(function* () {
    let reads = 0;
    const input = {
      environment: {},
      endpoint: DEFAULT_CURSOR_API_ENDPOINT,
      platform: "darwin" as const,
      allowKeychain: false,
      readKeychain: async () => {
        reads++;
        return "synthetic-token";
      },
    };
    expect(yield* readCursorCliUsageLogin(input)).toMatchObject({
      kind: "unavailable",
      enableKeychain: true,
    });
    expect(yield* readCursorCliUsageLogin({
      ...input,
      allowKeychain: true,
      endpoint: "https://cursor-proxy.example",
    })).toMatchObject({ kind: "unavailable", message: expect.stringContaining("default Cursor endpoint") });
    expect(yield* readCursorCliUsageLogin({
      ...input,
      allowKeychain: true,
      environment: { AGENT_CLI_CREDENTIAL_STORE: "memory" },
    })).toMatchObject({ kind: "unavailable" });
    expect(reads).toBe(0);
    expect(yield* readCursorCliUsageLogin({ ...input, allowKeychain: true })).toEqual({
      kind: "token",
      accessToken: "synthetic-token",
    });
    expect(reads).toBe(1);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns the refresh message when an opted-in Keychain read is denied", () =>
  Effect.gen(function* () {
    const login = yield* readCursorCliUsageLogin({
      environment: {},
      endpoint: DEFAULT_CURSOR_API_ENDPOINT,
      allowKeychain: true,
      readKeychain: () => Promise.reject(new Error("Access denied")),
    });
    expect(login).toEqual({
      kind: "unavailable",
      message: "Allow access to the Cursor CLI login on the Mac running J1 Code, then refresh.",
    });
  }).pipe(
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provide(NodeServices.layer),
  ),
);

it.effect("uses a temporary file login only for the default endpoint and rejects malformed credentials", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "cursor-usage-login-" });
    const directory = path.join(home, ".cursor");
    yield* fs.makeDirectory(directory);
    const auth = path.join(directory, "auth.json");
    const input = {
      environment: { HOME: home, AGENT_CLI_CREDENTIAL_STORE: "file" },
      endpoint: DEFAULT_CURSOR_API_ENDPOINT,
      allowKeychain: false,
      platform: "darwin" as const,
      readKeychain: () => Promise.reject(new Error("Unexpected Keychain read")),
    };
    yield* fs.writeFileString(auth, JSON.stringify({ accessToken: " synthetic-file-token " }));
    expect(yield* readCursorCliUsageLogin(input)).toEqual({
      kind: "token",
      accessToken: "synthetic-file-token",
    });
    expect(yield* readCursorCliUsageLogin({
      ...input,
      endpoint: "https://cursor-proxy.example",
    })).toMatchObject({
      kind: "unavailable",
      message: expect.stringContaining("default Cursor endpoint"),
    });
    yield* fs.writeFileString(auth, JSON.stringify({ accessToken: 1 }));
    expect(yield* readCursorCliUsageLogin(input)).toEqual({
      kind: "unavailable",
      message: "Cursor CLI credentials could not be read.",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
