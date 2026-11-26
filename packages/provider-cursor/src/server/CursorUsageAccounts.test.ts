import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@j1code/contracts";
import * as TestProviderHost from "@j1code/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { CursorCredentialSource } from "./accountCache.ts";
import * as CursorAccountReader from "./CursorAccountReader.ts";
import * as CursorUsageAccounts from "./CursorUsageAccounts.ts";

it.effect("uses CLI history only when no API key is available", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "cursor-account-fallback-" });
    const loginDirectory = path.join(
      home,
      process.platform === "win32" ? "Cursor" : process.platform === "darwin" ? ".cursor" : "cursor",
    );
    yield* fs.makeDirectory(loginDirectory);
    yield* fs.writeFileString(
      path.join(loginDirectory, "auth.json"),
      JSON.stringify({ accessToken: "synthetic-login-token" }),
    );
    const reads: CursorCredentialSource[] = [];
    const reader = Layer.succeed(CursorAccountReader.CursorAccountReader, {
      read: (source) => Effect.sync(() => {
        reads.push(source);
        return { accountKey: "same-account", records: [], missing: false, error: null };
      }),
    });
    const accountsLayer = CursorUsageAccounts.layer.pipe(
      Layer.provide(Layer.mergeAll(reader, TestProviderHost.layer(), NodeCrypto.layer)),
    );
    yield* Effect.gen(function* () {
      const accounts = yield* CursorUsageAccounts.CursorUsageAccounts;
      const environment = {
        HOME: home,
        USERPROFILE: home,
        APPDATA: home,
        XDG_CONFIG_HOME: home,
        AGENT_CLI_CREDENTIAL_STORE: "file",
      };
      const first = { instanceId: ProviderInstanceId.make("cursor"), environment };
      const scan = {
        instances: [first],
        windowStartMs: 0,
        retentionCutoffMs: 0,
        awaitRefresh: true,
      };
      const fallback = yield* accounts.scan(scan);
      const custom = yield* accounts.scan({
        ...scan,
        instances: [{
          ...first,
          config: { apiEndpoint: "https://cursor-proxy.example" },
          environment: { ...environment, CURSOR_API_KEY: "synthetic-proxy-key" },
        }],
      });
      expect(custom[0]?.message).toContain("default Cursor endpoint");
      const keyed = yield* accounts.scan({
        ...scan,
        instances: [first, {
          instanceId: ProviderInstanceId.make("cursor-keyed"),
          environment: { ...environment, CURSOR_API_KEY: "synthetic-api-key" },
        }],
      });
      yield* accounts.awaitPersisted;
      expect(reads).toEqual([
        { kind: "cliLogin", accessToken: "synthetic-login-token" },
        { kind: "apiKey", apiKey: "synthetic-api-key" },
      ]);
      expect(fallback.map((source) => source.dir)).toEqual(["cursor-account:same-account"]);
      expect(keyed.map((source) => source.dir)).toEqual(["cursor-account:same-account"]);
    }).pipe(Effect.provide(accountsLayer));
  }).pipe(Effect.provide(NodeServices.layer)),
);
