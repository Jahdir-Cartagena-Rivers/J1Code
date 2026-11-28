// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the Node HTTP boundary.
import * as NodeHttp from "node:http";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@j1code/shared/HostProcess";
import * as NetService from "@j1code/shared/Net";
import * as RelayClient from "@j1code/shared/relayClient";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { makeCli } from "../binCli.ts";
import { CLOUD_CLI_DESIRED_LINK_SECRET } from "../cloud/CliState.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { acquireRelayClientForLink } from "./connect.ts";
import { resolveHostCliCommand } from "./invocation.ts";

const managedExecutable = {
  status: "available",
  executablePath: "/tmp/cloudflared",
  source: "managed",
  version: RelayClient.CLOUDFLARED_VERSION,
} as const;

it.effect("does not install the relay client when the user declines the managed download", () =>
  Effect.gen(function* () {
    let installCalls = 0;
    const result = yield* acquireRelayClientForLink(
      {
        resolve: Effect.succeed({
          status: "missing",
          version: RelayClient.CLOUDFLARED_VERSION,
        }),
        install: Effect.sync(() => {
          installCalls += 1;
          return managedExecutable;
        }),
        installWithProgress: () =>
          Effect.sync(() => {
            installCalls += 1;
            return managedExecutable;
          }),
        pruneManagedVersions: Effect.void,
      },
      () => Effect.succeed(false),
      () => Effect.void,
    );

    assert.isTrue(Option.isNone(result));
    assert.equal(installCalls, 0);
  }),
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer))(
  "j1 connect next steps",
  (it) => {
    it.effect.each([
      { subcommand: "status", hint: "connect link" },
      { subcommand: "publish", hint: "connect login" },
    ])(
      "j1 connect $subcommand includes the $hint command with --base-dir",
      ({ subcommand, hint }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-connect-hint-test-" });

          yield* Command.runWith(makeCli({ cloudEnabled: true }), { version: "0.0.0" })([
            "connect",
            subcommand,
            "--base-dir",
            baseDir,
          ]);

          const { command } = yield* resolveHostCliCommand(hint, ["--base-dir", baseDir]);
          assert.include((yield* TestConsole.logLines).join("\n"), `\`${command}\``);
        }).pipe(
          Effect.scoped,
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provide(
            Layer.mergeAll(
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
              Layer.fresh(TestConsole.layer),
            ),
          ),
        ),
    );
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer))(
  "j1 connect with a fresh local home",
  (it) => {
    const runCli = Command.runWith(makeCli({ cloudEnabled: true }), { version: "0.0.0" });
    const fixture = Layer.mergeAll(
      Layer.fresh(TestConsole.layer),
      Layer.succeed(HostProcess.Environment, {}),
      Layer.succeed(FetchHttpClient.Fetch, async () => {
        throw new Error("Unexpected network access in local Connect fixture");
      }),
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            T3CODE_PORT: "43101",
            T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
            T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_client_test",
            T3CODE_RELAY_URL: "https://relay.example.test",
          },
        }),
      ),
    );

    it.effect("reports disconnected JSON status and a home-specific next step", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "j1-connect-status-" });
        yield* runCli(["connect", "status", "--base-dir", baseDir, "--json"]);

        const output = (yield* TestConsole.logLines).at(-1);
        assert.include(JSON.parse(String(output)), {
          desired: false,
          authenticated: false,
          linked: false,
          cloudUserId: null,
          relayUrl: null,
        });

        yield* runCli(["connect", "status", "--base-dir", baseDir]);
        const { command } = yield* resolveHostCliCommand("connect link", ["--base-dir", baseDir]);
        const status = (yield* TestConsole.logLines).join("\n");
        assert.include(status, "J1 Connect\n  Exposure: disabled");
        assert.include(status, "  Authorization: missing");
        assert.include(status, "  Environment link: not provisioned");
        assert.include(status, `Next: Run \`${command}\` to authorize and enable J1 Connect.`);
      }).pipe(Effect.provide(Layer.fresh(fixture))),
    );

    it.effect(
      "preserves the saved login and does not start authorization after a temporary refresh failure",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "j1-connect-refresh-" });
          const secretsDir = `${baseDir}/userdata/secrets`;
          const tokenPath = `${secretsDir}/cloud-cli-oauth-token.bin`;
          yield* fs.makeDirectory(secretsDir, { recursive: true });
          const saved = JSON.stringify({
            accessToken: "fixture-access-token",
            refreshToken: "fixture-refresh-token",
            expiresAtEpochMs: 0,
            destination: {
              tokenEndpoint: "https://clerk.example.test/oauth/token",
              clientId: "oauth_client_test",
              relayUrl: "https://relay.example.test",
            },
          });
          yield* fs.writeFileString(tokenPath, saved);
          const requests: string[] = [];
          const failure = yield* runCli([
            "connect",
            "login",
            "--base-dir",
            baseDir,
            "--headless",
          ]).pipe(
            Effect.provideService(FetchHttpClient.Fetch, async (request) => {
              requests.push(String(request instanceof Request ? request.url : request));
              return new Response(null, { status: 503 });
            }),
            Effect.flip,
          );
          assert.propertyVal(failure, "_tag", "CloudCliCredentialRefreshError");
          assert.isAbove(requests.length, 0);
          assert.isTrue(requests.every((url) => url === "https://clerk.example.test/oauth/token"));
          assert.equal(yield* fs.readFileString(tokenPath), saved);
          assert.notInclude(
            (yield* TestConsole.logLines).join("\n"),
            "J1 Connect sign-in expired.",
          );
        }).pipe(Effect.provide(Layer.fresh(fixture))),
    );

    it.effect("uses a stored headless login without enabling access and clears it on logout", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "j1-connect-login-" });
        const secretsDir = `${baseDir}/userdata/secrets`;
        const tokenPath = `${secretsDir}/cloud-cli-oauth-token.bin`;
        yield* fs.makeDirectory(secretsDir, { recursive: true });
        yield* fs.writeFileString(
          tokenPath,
          JSON.stringify({
            accessToken: "fixture-access-token",
            refreshToken: "fixture-refresh-token",
            expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
            destination: {
              tokenEndpoint: "https://clerk.example.test/oauth/token",
              clientId: "oauth_client_test",
              relayUrl: "https://relay.example.test",
            },
          }),
        );

        yield* runCli(["connect", "login", "--base-dir", baseDir, "--headless"]);
        assert.include((yield* TestConsole.logLines).join("\n"), "Signed in");

        yield* runCli(["connect", "status", "--base-dir", baseDir, "--json"]);
        const output = (yield* TestConsole.logLines).at(-1);
        assert.include(JSON.parse(String(output)), { desired: false, authenticated: true });

        yield* runCli(["connect", "unlink", "--base-dir", baseDir]);
        assert.include((yield* TestConsole.logLines).join("\n"), "J1 Connect is disabled locally.");
        assert.isTrue(yield* fs.exists(tokenPath));

        yield* runCli(["connect", "logout", "--base-dir", baseDir]);
        assert.include(
          (yield* TestConsole.logLines).join("\n"),
          "Signed out of J1 Connect locally.",
        );
        assert.isFalse(yield* fs.exists(tokenPath));
      }).pipe(Effect.provide(Layer.fresh(fixture))),
    );
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer))(
  "j1 connect unlink and status",
  (it) => {
    const runConnect = (
      recordedPid: number,
      options?: {
        readonly portFreed?: boolean;
        readonly command?: "unlink" | "status";
        readonly linkMode?: "managed" | "publish_only";
      },
    ) =>
      Effect.gen(function* () {
        const requests: Array<string> = [];
        const warnings: Array<string> = [];
        const server = yield* Effect.acquireRelease(
          Effect.callback<NodeHttp.Server>((resume) => {
            const listening = NodeHttp.createServer((request, response) => {
              requests.push(`${request.method} ${request.url}`);
              response.writeHead(200, { "content-type": "application/json" });
              response.end(JSON.stringify({ ok: true, endpointRuntimeStatus: null }));
            });
            listening.listen(0, "127.0.0.1", () => resume(Effect.succeed(listening)));
          }),
          (listening) => Effect.sync(() => listening.close()),
        );
        const address = server.address();
        if (address === null || typeof address === "string") {
          return yield* Effect.die(new Error("Expected a TCP address"));
        }
        if (options?.portFreed) {
          yield* Effect.callback<void>((resume) => {
            server.close(() => resume(Effect.void));
          });
        }

        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-connect-unlink-test-" });
        const state = yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", privateNetworkOnly: undefined, devUrl: undefined },
          port: address.port,
        });
        yield* persistServerRuntimeState({
          path: `${baseDir}/userdata/server-runtime.json`,
          state: { ...state, pid: recordedPid },
        });
        if (options?.command === "status") {
          // Status asks the server for reachability only for a managed link.
          yield* fs.makeDirectory(`${baseDir}/userdata/secrets`, { recursive: true });
          yield* fs.writeFileString(
            `${baseDir}/userdata/secrets/${CLOUD_CLI_DESIRED_LINK_SECRET}.bin`,
            options.linkMode ?? "managed",
          );
        }

        yield* Command.runWith(makeCli({ cloudEnabled: true }), { version: "0.0.0" })([
          "connect",
          options?.command ?? "unlink",
          "--base-dir",
          baseDir,
        ]).pipe(
          // TestConsole has no reader for Console.warn.
          Effect.updateService(Console.Console, (console) => ({
            ...console,
            warn: (...args: ReadonlyArray<unknown>) => {
              warnings.push(args.join(" "));
            },
          })),
        );

        return { requests, warnings, printed: (yield* TestConsole.logLines).join("\n") };
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            Layer.fresh(TestConsole.layer),
          ),
        ),
      );

    // Above Linux's PID ceiling, as in pair.test.ts: no process can hold it.
    const deadPid = 4_194_305;

    it.effect("does not tell the user to restart a server that is gone", () =>
      Effect.gen(function* () {
        const { printed, warnings } = yield* runConnect(deadPid, { portFreed: true });

        assert.include(printed, "J1 Connect is disabled locally.");
        assert.notInclude(warnings.join("\n"), "Restart that server");
      }),
    );

    it.effect("warns that a server that is gone may have left its connector running", () =>
      Effect.gen(function* () {
        const { warnings } = yield* runConnect(deadPid, { portFreed: true });

        assert.include(warnings.join("\n"), "its cloudflared process may still be running");
      }),
    );

    it.effect("does not send a token to whatever took over a dead server's port", () =>
      Effect.gen(function* () {
        const { requests } = yield* runConnect(deadPid);

        assert.deepEqual(requests, []);
      }),
    );

    it.effect("status does not send a token to whatever took over a dead server's port", () =>
      Effect.gen(function* () {
        const { requests } = yield* runConnect(deadPid, { command: "status" });

        assert.deepEqual(requests, []);
      }),
    );

    it.effect("status asks a running server to check reachability", () =>
      Effect.gen(function* () {
        const { requests } = yield* runConnect(process.pid, { command: "status" });

        assert.deepEqual(requests, ["POST /api/connect/reachability"]);
      }),
    );

    it.effect("status does not report a publish-only link as exposed", () =>
      Effect.gen(function* () {
        const { printed } = yield* runConnect(process.pid, {
          command: "status",
          linkMode: "publish_only",
        });

        assert.include(printed, "Exposure: publish-only");
        assert.notInclude(printed, "Other devices can reach this machine");
      }),
    );

    it.effect("asks a running server to stop its tunnel", () =>
      Effect.gen(function* () {
        const { requests, printed, warnings } = yield* runConnect(process.pid);

        assert.deepEqual(requests, ["POST /api/connect/unlink"]);
        assert.include(printed, "J1 Connect is disabled locally.");
        assert.notInclude(warnings.join("\n"), "cloudflared process");
      }),
    );
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer))(
  "j1 connect live request destination",
  (it) => {
    it.effect.each([
      { command: "status", requestPath: "/api/connect/reachability" },
      { command: "unlink", requestPath: "/api/connect/unlink" },
    ])(
      "$command rejects an invalid origin and disables redirects for the valid origin",
      ({ command, requestPath }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const state = yield* makePersistedServerRuntimeState({
            config: { host: "127.0.0.1", privateNetworkOnly: undefined, devUrl: undefined },
            port: 3773,
          });
          for (const origin of [
            "file:///fixture",
            "http://fixture-user@127.0.0.1:3773",
            state.origin,
          ]) {
            const baseDir = yield* fs.makeTempDirectoryScoped({
              prefix: "j1-connect-origin-test-",
            });
            const stateDir = baseDir + "/userdata";
            yield* persistServerRuntimeState({
              path: stateDir + "/server-runtime.json",
              state: { ...state, origin },
            });
            if (command === "status") {
              const secretsDir = stateDir + "/secrets";
              yield* fs.makeDirectory(secretsDir, { recursive: true });
              yield* fs.writeFileString(
                secretsDir + "/" + CLOUD_CLI_DESIRED_LINK_SECRET + ".bin",
                "managed",
              );
            }

            const requests: Array<{ url: string; redirect: RequestInit["redirect"] }> = [];
            yield* Command.runWith(makeCli({ cloudEnabled: true }), { version: "0.0.0" })([
              "connect",
              command,
              "--base-dir",
              baseDir,
            ]).pipe(
              Effect.provideService(FetchHttpClient.Fetch, async (input, init) => {
                requests.push({ url: String(input), redirect: init?.redirect });
                return new Response(JSON.stringify({ ok: true, endpointRuntimeStatus: null }), {
                  headers: { "content-type": "application/json" },
                });
              }),
            );
            assert.deepEqual(
              requests,
              origin === state.origin ? [{ url: origin + requestPath, redirect: "error" }] : [],
            );
          }
        }).pipe(
          Effect.scoped,
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provide(
            Layer.mergeAll(
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
              Layer.fresh(TestConsole.layer),
            ),
          ),
        ),
    );
  },
);
