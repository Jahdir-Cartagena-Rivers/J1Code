import { resolveSpawnCommand } from "@j1code/shared/shell";
import type { ProviderMaintenanceCommandAction } from "@j1code/provider-core/server/maintenanceResolver";
import * as HostProcess from "@j1code/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ServerConfig from "../config.ts";
import { codexNpmRecovery, legacyCodexStartupPrefixes } from "./codexNpmRecovery.ts";

export class CodexUpdateRecoveryError extends Schema.TaggedError<CodexUpdateRecoveryError>()(
  "CodexUpdateRecoveryError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface CodexUpdateTransaction {
  readonly command: ProviderMaintenanceCommandAction;
  readonly publish: Effect.Effect<void, CodexUpdateRecoveryError>;
  readonly commit: Effect.Effect<void, CodexUpdateRecoveryError>;
  readonly close: Effect.Effect<void, CodexUpdateRecoveryError>;
}

/** Repairs verified V1 npm journals. Managed releases recover through their active pointer. */
export class CodexUpdateRecovery extends Context.Service<
  CodexUpdateRecovery,
  {
    /** Used only by explicitly requested legacy npm maintenance, never by managed installs. */
    readonly prepare: (
      command: ProviderMaintenanceCommandAction,
    ) => Effect.Effect<CodexUpdateTransaction, CodexUpdateRecoveryError>;
  }
>()("@j1code/server/provider/CodexUpdateRecovery") {
  static readonly layer = Layer.effect(
    CodexUpdateRecovery,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const platform = yield* HostProcess.Platform;
      const environment = yield* HostProcess.Environment;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const probe = Effect.fn("CodexUpdateRecovery.probe")(
        function* (prefix: string) {
          for (const args of [["--version"], ["app-server", "--help"]]) {
            const command = yield* resolveSpawnCommand(path.join(prefix, "codex.cmd"), args).pipe(
              Effect.provideService(HostProcess.Platform, platform),
            );
            const child = yield* spawner.spawn(
              ChildProcess.make(command.command, command.args, { shell: command.shell }),
            );
            const [status] = yield* Effect.all(
              [child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)],
              { concurrency: "unbounded" },
            );
            if (status !== 0) return false;
          }
          return true;
        },
        Effect.scoped,
        Effect.timeout("10 seconds"),
        Effect.orElseSucceed(() => false),
      );
      const runLegacyTransaction = <A>(run: () => Promise<A>) =>
        Effect.tryPromise({
          try: run,
          catch: (cause) =>
            new CodexUpdateRecoveryError({
              message: "Could not safely apply the Codex npm maintenance transaction.",
              cause,
            }),
        }).pipe(Effect.uninterruptible);
      const runProbe = Effect.runPromiseWith(yield* Effect.context<never>());
      const store = codexNpmRecovery(
        path.join(config.baseDir, "tools", "codex-update-recovery"),
        (prefix) => runProbe(probe(prefix)),
      );
      if (platform === "win32") {
        const prefixes = legacyCodexStartupPrefixes(config.baseDir, environment);
        yield* runLegacyTransaction(() => store.recover(prefixes)).pipe(
          Effect.flatMap(({ recovered, invalid, deferred }) => {
            if (invalid || deferred)
              return Effect.logWarning("Some legacy Codex npm journals were preserved", {
                recovered,
                invalid,
                deferred,
              });
            return recovered
              ? Effect.logInfo("Recovered legacy Codex npm journals", { recovered })
              : Effect.void;
          }),
          Effect.catch(() => Effect.logWarning("Could not recover saved Codex npm journals")),
        );
      }
      return CodexUpdateRecovery.of({
        prepare: Effect.fn("CodexUpdateRecovery.prepare")((command) =>
          runLegacyTransaction(async () => {
            const index = command.args.indexOf("--prefix");
            const prefix = index < 0 ? undefined : command.args[index + 1];
            if (platform !== "win32" || !prefix || !/^npm-global(?::|$)/.test(command.lockKey)) {
              throw new Error("The legacy Codex npm maintenance prefix could not be verified.");
            }
            const transaction = await store.prepare(prefix);
            const args = [...command.args];
            args[index + 1] = transaction.stagingPrefix;
            return {
              command: { ...command, args },
              publish: runLegacyTransaction(() => transaction.publish()),
              commit: runLegacyTransaction(() => transaction.commit()),
              close: runLegacyTransaction(() => transaction.close()),
            };
          }),
        ),
      });
    }),
  );
}
