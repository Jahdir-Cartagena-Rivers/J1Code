import { HostProcessPlatform } from "@j1code/shared/hostProcess";
import { resolveSpawnCommand } from "@j1code/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ServerConfig } from "../config.ts";
import { codexNpmRecovery } from "./codexNpmRecovery.ts";
import type { ProviderMaintenanceCommandAction } from "./providerMaintenance.ts";

export interface CodexUpdateTransaction {
  readonly command: ProviderMaintenanceCommandAction;
  readonly publish: Effect.Effect<void, CodexUpdateRecoveryError>;
  readonly commit: Effect.Effect<void, CodexUpdateRecoveryError>;
  readonly close: Effect.Effect<void, CodexUpdateRecoveryError>;
}
export class CodexUpdateRecoveryError extends Schema.TaggedError<CodexUpdateRecoveryError>()(
  "CodexUpdateRecoveryError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
const errorFrom = (cause: unknown) =>
  new CodexUpdateRecoveryError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

export class CodexUpdateRecovery extends Context.Service<
  CodexUpdateRecovery,
  {
    readonly prepare: (
      command: ProviderMaintenanceCommandAction,
    ) => Effect.Effect<CodexUpdateTransaction, CodexUpdateRecoveryError>;
  }
>()("@j1code/server/provider/CodexUpdateRecovery") {
  static readonly layer = Layer.effect(
    CodexUpdateRecovery,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const platform = yield* HostProcessPlatform;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const probe = Effect.fn("CodexUpdateRecovery.probe")(
        function* (prefix: string) {
          for (const args of [["--version"], ["app-server", "--help"]]) {
            const command = yield* resolveSpawnCommand(path.join(prefix, "codex.cmd"), args).pipe(
              Effect.provideService(HostProcessPlatform, platform),
            );
            const child = yield* spawner.spawn(
              ChildProcess.make(command.command, command.args, { shell: command.shell }),
            );
            const [code] = yield* Effect.all(
              [child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)],
              { concurrency: "unbounded" },
            );
            if (code !== 0) return false;
          }
          return true;
        },
        Effect.scoped,
        Effect.timeout("10 seconds"),
        Effect.orElseSucceed(() => false),
      );
      const store = codexNpmRecovery(
        path.join(config.baseDir, "tools", "codex-update-recovery"),
        (prefix) => Effect.runPromise(probe(prefix)),
      );
      // Constructed before provider hydration: recover a killed installer before
      // Codex's driver caches its launcher and initial readiness snapshot.
      if (platform === "win32")
        yield* Effect.tryPromise({ try: () => store.recover(), catch: errorFrom }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Codex update recovery requires attention", { error: error.message }),
          ),
        );
      return CodexUpdateRecovery.of({
        prepare: (command) =>
          Effect.tryPromise({
            try: async () => {
              const index = command.args.indexOf("--prefix");
              const prefix = index < 0 ? undefined : command.args[index + 1];
              if (!prefix)
                throw new Error(
                  "Codex was not changed: the npm installation prefix could not be verified.",
                );
              const transaction = await store.prepare(prefix);
              const args = [...command.args];
              args[index + 1] = transaction.stagingPrefix;
              return {
                command: { ...command, args },
                publish: Effect.tryPromise({ try: () => transaction.publish(), catch: errorFrom }),
                commit: Effect.tryPromise({ try: () => transaction.commit(), catch: errorFrom }),
                close: Effect.tryPromise({ try: () => transaction.close(), catch: errorFrom }),
              };
            },
            catch: errorFrom,
          }).pipe(Effect.uninterruptible),
      });
    }),
  );
}
