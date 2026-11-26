// @effect-diagnostics nodeBuiltinImport:off -- Exercises the CLI's real stdout and stderr through a subprocess and an HTTP fixture.
import * as NodeHttp from "node:http";
import * as NodeURL from "node:url";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NetService from "@j1code/shared/Net";
import * as NodeSqliteClient from "@j1code/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import * as TestConsole from "effect/testing/TestConsole";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";

import { dispatchEntrypoint } from "./bin.ts";
import { makeCli } from "./binCli.ts";
import { parseServiceLauncherArgs } from "./cli/serviceLauncher.ts";
import { migrationManifest, runMigrations } from "./persistence/Migrations.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "./serverRuntimeState.ts";

it("routes ordinary commands and explicit launcher help through the normal CLI", async () => {
  const routed: string[] = [];
  const loaders = {
    loadCliMain: async () => ({ runCliCommand: async () => { routed.push("normal CLI"); } }),
    loadServiceLauncher: async () => { throw new Error("unexpected launcher import"); },
  };
  for (const args of [[], ["auth", "--help"], ["__service-launcher", "--help"]]) {
    assert.isUndefined(await dispatchEntrypoint(args, loaders));
  }
  assert.deepEqual(routed, ["normal CLI", "normal CLI", "normal CLI"]);
});

it("refuses malformed launcher invocations before normal CLI dispatch", async () => {
  let launched = false;
  const loaders = {
    loadCliMain: async () => { throw new Error("unexpected normal CLI import"); },
    loadServiceLauncher: async () => ({
      parseServiceLauncherArgs,
      runServiceLauncherCli: async () => { launched = true; },
    }),
  };
  for (const flags of [
    ["--base-dir"],
    ["--base-dir", "one", "--base-dir", "two"],
    ["--service-unit", "../foreign.xml"],
    ["--help", "--base-dir", "fixture"],
  ]) {
    assert.equal(
      await dispatchEntrypoint(["__service-launcher", ...flags], loaders),
      "Invalid J1 Code service launcher arguments.",
    );
  }
  assert.isFalse(launched);
});

it("awaits the legacy and Windows launcher routes before completing dispatch", async () => {
  for (const flags of [[], ["--base-dir", "C:\\Fixture Home", "--service-unit", "t3code-task.xml"]]) {
    const running = Promise.withResolvers<void>();
    const shutdown = Promise.withResolvers<void>();
    let finished = false;
    const dispatch = dispatchEntrypoint(["__service-launcher", ...flags], {
      loadCliMain: async () => { throw new Error("unexpected normal CLI import"); },
      loadServiceLauncher: async () => ({
        parseServiceLauncherArgs,
        runServiceLauncherCli: async (options) => {
          assert.deepEqual(options, parseServiceLauncherArgs(flags));
          running.resolve();
          await shutdown.promise;
        },
      }),
    }).then(() => { finished = true; });
    await Promise.race([running.promise, dispatch]);
    assert.isFalse(finished);
    shutdown.resolve();
    await dispatch;
    assert.isTrue(finished);
  }
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer))("CLI registration and startup flags", (it) => {
  const runCli = (args: ReadonlyArray<string>) =>
    Command.runWith(makeCli({ cloudEnabled: false }), { version: "0.0.0" })(args);

  it.effect.each([
    { label: "lowercase log level", args: ["--log-level", "debug", "--version"] },
    { label: "boolean negation", args: ["--no-log-websocket-events", "--version"] },
  ])("accepts $label", ({ args }) =>
    Effect.gen(function* () {
      yield* runCli(args);
      assert.include((yield* TestConsole.logLines).join("\n"), "0.0.0");
    }).pipe(Effect.provide(Layer.fresh(TestConsole.layer))),
  );

  it.effect("rejects invalid log-level casing at startup", () =>
    Effect.gen(function* () {
      const error = yield* runCli(["--log-level", "Debug", "j1-invalid-startup-test"]).pipe(Effect.flip);
      assert(CliError.isCliError(error) && error._tag === "ShowHelp");
      const invalidValue = error.errors.find((issue) => issue._tag === "InvalidValue");
      assert.equal(invalidValue?.option, "log-level");
      assert.equal(invalidValue?.value, "Debug");
    }).pipe(Effect.provide(Layer.fresh(TestConsole.layer))),
  );

  it.effect("refuses unconfigured Connect and still exposes service commands", () =>
    Effect.gen(function* () {
      const error = yield* runCli(["connect", "status"]).pipe(Effect.flip);
      assert(CliError.isCliError(error) && error._tag === "ShowHelp");
      assert.deepEqual(error.commandPath, ["j1", "connect"]);
      assert.include(error.errors[0]?.message ?? "", "missing J1 Connect public configuration");
      assert.include(
        (yield* TestConsole.errorLines).join("\n"),
        "missing J1 Connect public configuration",
      );

      yield* runCli(["service", "--help"]);
      const help = (yield* TestConsole.logLines).join("\n");
      assert.include(help, "Manage the J1 Code background service.");
      for (const command of ["install", "uninstall", "update", "status"]) {
        assert.include(help, command);
      }
    }).pipe(Effect.provide(Layer.fresh(TestConsole.layer))),
  );
});

it.live.each([false, true])("protects JSON thread output with future migration set to %s", (futureMigration) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-json-" });
    const stateDir = `${root}/userdata`;
    yield* fs.makeDirectory(stateDir);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      if (futureMigration) {
        const futureId = Math.max(...migrationManifest.map(([id]) => id)) + 1;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${futureId}, 'FutureMigration')
        `;
      }
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: `${stateDir}/statev2.sqlite` })));

    const server = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const server = NodeHttp.createServer(async (request, response) => {
          let body = "";
          for await (const chunk of request) body += String(chunk);
          if (request.method === "DELETE") {
            response.writeHead(204).end();
            return;
          }
          const message = JSON.parse(body) as {
            id?: string;
            method: string;
            params?: { name: string };
          };
          if (message.id === undefined) {
            response.writeHead(202).end();
            return;
          }
          const result =
            message.method === "initialize"
              ? { protocolVersion: "2025-06-18" }
              : {
                  structuredContent:
                    message.params?.name === "t3_project_list"
                      ? {
                          projects: [{ id: "project-1", title: "Test", workspaceRoot: root }],
                          nextCursor: null,
                        }
                      : {
                          projectId: "project-1",
                          currentThreadId: null,
                          threads: [],
                          nextCursor: null,
                          total: 0,
                        },
                };
          response.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": "cli-json-test",
          });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        return server;
      }),
      (server) =>
        Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    const address = server.address();
    assert(address !== null && typeof address !== "string");
    yield* persistServerRuntimeState({
      path: `${stateDir}/server-runtime.json`,
      state: yield* makePersistedServerRuntimeState({
        config: { host: "127.0.0.1", devUrl: undefined },
        port: address.port,
      }),
    });

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [
          NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url)),
          "thread",
          "list",
          "--project",
          "project-1",
          "--json",
          "--base-dir",
          root,
        ],
        { env: { T3CODE_HOME: root } },
      ),
    );
    const { stdout, stderr, exitCode } = yield* Effect.all(
      {
        stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        exitCode: child.exitCode,
      },
      { concurrency: "unbounded" },
    );
    if (futureMigration) {
      assert.notEqual(Number(exitCode), 0);
      assert.include(`${stderr}${stdout}`, "Could not verify the migration ledger");
      return;
    }
    if (Number(exitCode) !== 0) {
      return yield* Effect.die(`Fixture CLI exited ${exitCode}: ${stderr || stdout || "no output"}`);
    }
    assert.deepStrictEqual(JSON.parse(stdout), []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
