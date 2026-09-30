import { runBackgroundHost } from "./DesktopBackgroundBackend.ts";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  if (input.length > 65_536) process.exit(1);
});
process.stdin.on("end", () => {
  void runBackgroundHost(input).catch((error: unknown) => {
    process.stderr.write(
      `J1 background host failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
});
