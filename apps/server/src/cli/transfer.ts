// @effect-diagnostics nodeBuiltinImport:off -- password file is read by the offline Node transfer utility.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Console from "effect/Console";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { exportServerTransfer, importServerTransfer } from "../serverTransfer/transfer.ts";

export async function runTransfer(
  operation: "export" | "import",
  home: string,
  file: string,
  passwordFile: string,
  stopped: boolean,
) {
  if (!stopped)
    throw new Error(
      "Stop J1, its service and managed bots, then confirm with --stopped. Keep the source stopped throughout and after the move.",
    );
  const stat = await NodeFSP.stat(passwordFile);
  if (stat.size > 4096) throw new Error("Password file is too large.");
  const password = (await NodeFSP.readFile(passwordFile, "utf8")).replace(/\r?\n$/, "");
  return operation === "export"
    ? exportServerTransfer(home, file, password)
    : importServerTransfer(file, home, password);
}
class TransferError extends Schema.TaggedError<TransferError>()("TransferError", {
  message: Schema.String,
}) {}
const operationCommand = (operation: "export" | "import") =>
  Command.make(operation, {
    home: Flag.String("home-dir"),
    passwordFile: Flag.String("password-file"),
    stopped: Flag.Boolean("stopped"),
    file: Argument.String("file"),
  }).pipe(
    Command.withDescription(
      operation === "export"
        ? "Encrypt stopped server userdata into a portable file."
        : "Restore a transfer into a NEW J1 home; never overwrite existing data.",
    ),
    Command.withHandler(({ home, file, passwordFile, stopped }) =>
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
          try: () => runTransfer(operation, home, file, passwordFile, stopped),
          catch: () =>
            new TransferError({
              message:
                "Transfer failed. Check stopped state, paths, password file, archive integrity and disk space. Existing homes cannot be overwritten.",
            }),
        });
        yield* Console.log(`Transfer complete: ${result.files} files.`);
      }),
    ),
  );
export const transferCommand = Command.make("transfer").pipe(
  Command.withDescription(
    "Move encrypted server data offline. Password file: at least 12 characters; protect it separately from the archive.",
  ),
  Command.withSubcommands([operationCommand("export"), operationCommand("import")]),
);
