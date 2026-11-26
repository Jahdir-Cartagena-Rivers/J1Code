import { assert, describe, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";

import * as DesktopSshEnvironment from "./DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NetService from "@j1code/shared/Net";
import * as SshAuth from "@j1code/ssh/auth";
import * as SshTunnel from "@j1code/ssh/tunnel";
import { SshPasswordPromptError } from "@j1code/ssh/errors";
import * as Path from "effect/Path";

const launcherPath = "/isolated/ssh-launcher-id";
const fileError = (tag: "NotFound" | "PermissionDenied", method = "readFileString") =>
  PlatformError.systemError({ module: "FileSystem", method, _tag: tag,
    pathOrDescriptor: launcherPath });

function persistenceFixture(options: {
  readonly stored?: string;
  readonly readError?: PlatformError.PlatformError;
  readonly writeError?: PlatformError.PlatformError;
}) {
  let randomCalls = 0;
  const writes: string[] = [];
  const layer = Layer.mergeAll(
    FileSystem.layerNoop({
      readFileString: () => options.readError === undefined
        ? Effect.succeed(options.stored ?? "") : Effect.fail(options.readError),
      writeFileString: (path, value) => Effect.sync(() => {
        assert.equal(path, launcherPath);
        writes.push(value);
      }).pipe(Effect.andThen(options.writeError === undefined
        ? Effect.void : Effect.fail(options.writeError))),
    }),
    Layer.succeed(SecureRandom.SecureRandom, SecureRandom.make((size) => {
      randomCalls += 1;
      return new Uint8Array(size).fill(0xab);
    })),
  );
  return { layer, writes, randomCalls: () => randomCalls };
}

describe("desktop SSH launcher persistence", () => {
  it.effect("reuses a stable valid ID without writing or requesting randomness", () =>
    Effect.gen(function* () {
      const id = "0123456789abcdef0123456789abcdef";
      const fixture = persistenceFixture({ stored: `  ${id}\n` });
      assert.equal(yield* DesktopSshEnvironment.readOrCreateLauncherId(launcherPath).pipe(Effect.provide(fixture.layer)), id);
      assert.equal(yield* DesktopSshEnvironment.readOrCreateLauncherId(launcherPath).pipe(Effect.provide(fixture.layer)), id);
      assert.deepEqual(fixture.writes, []);
      assert.equal(fixture.randomCalls(), 0);
    }),
  );

  it.effect("creates and persists an ID only when the file is missing", () =>
    Effect.gen(function* () {
      const fixture = persistenceFixture({ readError: fileError("NotFound") });
      const id = yield* DesktopSshEnvironment.readOrCreateLauncherId(launcherPath).pipe(Effect.provide(fixture.layer));
      assert.isNotNull(id);
      assert.match(id!, /^[0-9a-f]{32}$/u);
      assert.deepEqual(fixture.writes, [`${id}\n`]);
      assert.isAbove(fixture.randomCalls(), 0);
    }),
  );

  it.effect("preserves a hidden ID when reading it is denied", () =>
    Effect.gen(function* () {
      const fixture = persistenceFixture({ readError: fileError("PermissionDenied") });
      assert.isNull(yield* DesktopSshEnvironment.readOrCreateLauncherId(launcherPath).pipe(Effect.provide(fixture.layer)));
      assert.deepEqual(fixture.writes, []);
      assert.equal(fixture.randomCalls(), 0);
    }),
  );

  it.effect("returns no ID when the generated ID cannot be persisted", () =>
    Effect.gen(function* () {
      const fixture = persistenceFixture({ readError: fileError("NotFound"),
        writeError: fileError("PermissionDenied", "writeFileString") });
      assert.isNull(yield* DesktopSshEnvironment.readOrCreateLauncherId(launcherPath).pipe(Effect.provide(fixture.layer)));
      assert.equal(fixture.writes.length, 1);
      assert.isAbove(fixture.randomCalls(), 0);
    }),
  );
});

function makeTempHomeDir() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-env-test-" });
  });
}


describe("desktop SSH existing behavior", () => {
  it("treats password prompt timeouts as cancellable authentication prompts", () => {
    assert.equal(
      DesktopSshEnvironment.isDesktopSshPasswordPromptCancellation(
        new SshPasswordPromptError({
          message: "SSH authentication timed out for devbox.",
          cause: new DesktopSshPasswordPrompts.DesktopSshPromptTimedOutError({
            requestId: "prompt-1",
            destination: "devbox",
          }),
        }),
      ),
      true,
    );
  });
  it.effect("wires desktop host discovery through the ssh package runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDir = yield* makeTempHomeDir();
      const sshDir = path.join(homeDir, ".ssh");
      yield* fs.makeDirectory(path.join(sshDir, "config.d"), { recursive: true });
      yield* fs.writeFileString(
        path.join(sshDir, "config"),
        ["Host devbox", "  HostName devbox.example.com", "Include config.d/*.conf", ""].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(sshDir, "config.d", "team.conf"),
        [
          "Host staging",
          "  HostName staging.example.com",
          "Host *",
          "  ServerAliveInterval 30",
          "",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(sshDir, "known_hosts"),
        [
          "known.example.com ssh-ed25519 AAAA",
          "|1|hashed|entry ssh-ed25519 AAAA",
          "[bastion.example.com]:2222 ssh-ed25519 AAAA",
          "",
        ].join("\n"),
      );

      const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
      const hosts = yield* sshEnvironment.discoverHosts({ homeDir });
      assert.deepEqual(hosts, [
        {
          alias: "bastion.example.com",
          hostname: "bastion.example.com",
          username: null,
          port: null,
          source: "known-hosts",
        },
        {
          alias: "devbox",
          hostname: "devbox",
          username: null,
          port: null,
          source: "ssh-config",
        },
        {
          alias: "known.example.com",
          hostname: "known.example.com",
          username: null,
          port: null,
          source: "known-hosts",
        },
        {
          alias: "staging",
          hostname: "staging",
          username: null,
          port: null,
          source: "ssh-config",
        },
      ]);
    }).pipe(
      Effect.provide(
        DesktopSshEnvironment.layer().pipe(
          Layer.provideMerge(
            Layer.succeed(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
              request: () => Effect.die("unexpected password prompt request"),
              resolve: () => Effect.die("unexpected password prompt resolution"),
            }),
          ),
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(NodeCrypto.layer),
          Layer.provideMerge(NodeHttpClient.layerUndici),
          Layer.provideMerge(NetService.layer),
        ),
      ),
      Effect.scoped,
    ),
  );
});

it.effect("keeps prompt presentation diagnostics distinct from the legacy wrapper message", () =>
  Effect.gen(function* () {
    const cause = new DesktopSshPasswordPrompts.DesktopSshPromptPresentationError({
      requestId: "prompt-1", destination: "devbox", operation: "send-prompt-request",
      cause: new Error("renderer send failed"),
    });
    const manager = Layer.mock(SshTunnel.SshEnvironmentManager, {
      ensureEnvironment: () => Effect.gen(function* () {
        const prompt = yield* SshAuth.SshPasswordPrompt;
        yield* prompt.request({ destination: "devbox", username: null, prompt: "Password:", attempt: 1 });
        return yield* Effect.die("A failed prompt must not connect");
      }),
    });
    const layer = Layer.effect(DesktopSshEnvironment.DesktopSshEnvironment, DesktopSshEnvironment.make).pipe(
      Layer.provide(manager),
      Layer.provide(Layer.mock(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
        request: () => Effect.fail(cause),
      })),
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer,
        NodeHttpClient.layerUndici, NetService.layer)),
    );
    const error = yield* Effect.gen(function* () {
      const environment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
      return yield* environment.ensureEnvironment({ alias: "devbox", hostname: "devbox",
        username: null, port: null }).pipe(Effect.flip);
    }).pipe(Effect.provide(layer));
    assert.equal(cause.message, "Failed to present SSH password prompt for devbox.");
    assert.ok(error._tag === "SshPasswordPromptError");
    assert.equal(error.message, "J1 Code window is not available for SSH authentication.");
    assert.strictEqual(error.cause, cause);
  }),
);
