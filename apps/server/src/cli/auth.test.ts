import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthStandardClientScopes } from "@j1code/contracts";
import * as HostProcess from "@j1code/shared/HostProcess";
import * as NetService from "@j1code/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { Command } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import * as TestConsole from "effect/testing/TestConsole";

import { makeCli } from "../binCli.ts";

const runCli = Command.runWith(makeCli({ cloudEnabled: false }), { version: "0.0.0" });
const layer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  NetService.layer,
  TestConsole.layer,
  Layer.succeed(HostProcess.Environment, {}),
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "43101" } })),
);

it.effect.each([
  { group: "pairing", issue: "create", id: "id", secret: "credential" },
  { group: "session", issue: "issue", id: "sessionId", secret: "token" },
])("redacts the $group credential from persisted CLI listings", ({ group, issue, id, secret }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "j1-cli-auth-" });
    yield* runCli(["auth", group, issue, "--base-dir", baseDir, "--json"]);
    yield* runCli(["auth", group, "list", "--base-dir", baseDir, "--json"]);

    const [issuedJson, listedJson] = (yield* TestConsole.logLines).slice(-2);
    const issued = JSON.parse(String(issuedJson));
    const listed = JSON.parse(String(listedJson));
    assert.isString(issued[id]);
    assert.isString(issued[secret]);
    assert.isNotEmpty(issued[secret]);
    assert.lengthOf(listed, 1);
    assert.equal(listed[0][id], issued[id]);
    assert.notProperty(listed[0], secret);
    assert.includeMembers(issued.scopes, [...AuthStandardClientScopes]);
    assert.deepEqual(listed[0].scopes, issued.scopes);
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("rejects an invalid pairing TTL before creating auth state", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "j1-cli-auth-ttl-" });
    const error = yield* runCli([
      "auth",
      "pairing",
      "create",
      "--base-dir",
      baseDir,
      "--ttl",
      "soon",
    ]).pipe(Effect.flip);

    assert(CliError.isCliError(error) && error._tag === "ShowHelp");
    assert.deepEqual(error.commandPath, ["j1", "auth", "pairing", "create"]);
    const ttlError = error.errors[0];
    assert(ttlError?._tag === "InvalidValue");
    assert.equal(ttlError.option, "ttl");
    assert.equal(ttlError.value, "soon");
    assert.include(ttlError.message, "Invalid duration");
    assert.include(ttlError.message, "5m, 1h, 30d, or 15 minutes");
    assert.isFalse(yield* fs.exists(path.join(baseDir, "userdata")));
  }).pipe(Effect.provide(Layer.fresh(layer))),
);
