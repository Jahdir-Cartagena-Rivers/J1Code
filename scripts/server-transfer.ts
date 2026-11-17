// Source-checkout convenience entry point; installed users use `j1 transfer`.
import { runTransfer } from "../apps/server/src/cli/transfer.ts";
const [operation, home, file, passwordFile, stopped] = process.argv.slice(2);
if ((operation !== "export" && operation !== "import") || !home || !file || !passwordFile) {
  console.error(
    "Usage: node scripts/server-transfer.ts <export|import> HOME FILE PASSWORD_FILE --stopped",
  );
  process.exitCode = 1;
} else {
  try {
    console.log(
      JSON.stringify(
        await runTransfer(operation, home, file, passwordFile, stopped === "--stopped"),
      ),
    );
  } catch {
    console.error("Transfer failed. Check paths, password, archive and stopped server state.");
    process.exitCode = 1;
  }
}
