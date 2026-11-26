import { type LauncherOptions, main as runServiceLauncher } from "../serviceLauncher.ts";

/** The flags a Windows task passes, parsed here so the launcher starts without the full CLI. */
export function parseServiceLauncherArgs(args: ReadonlyArray<string>): LauncherOptions | undefined {
  const seen = new Set<string>();
  let baseDir: string | undefined;
  let logFile: string | undefined;
  let serviceUnit: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      value.trim() === "" ||
      value.startsWith("--") ||
      value.includes("\0") ||
      seen.has(flag)
    ) {
      return undefined;
    }
    seen.add(flag);
    if (flag === "--base-dir") baseDir = value;
    else if (flag === "--log-file") logFile = value;
    else if (
      flag === "--service-unit" &&
      value === value.trim() &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:xml|service|plist)$/u.test(value)
    ) {
      serviceUnit = value;
    } else return undefined;
  }
  return { baseDir, logFile, serviceUnit };
}

/**
 * Hosts the service launcher inside the CLI executable. The service manager
 * runs `j1 __service-launcher` and the launcher spawns the server from the
 * same executable, so the machine needs no Node to run either.
 *
 * The launcher owns SIGTERM handling and the process lifetime: it must finish
 * stopping its child before the process exits, so the entry point awaits it outside the
 * CLI's fiber rather than under `runMain`, whose signal handler would
 * interrupt the fiber and exit while the child is still being terminated.
 */
export async function runServiceLauncherCli(options?: LauncherOptions): Promise<void> {
  try {
    await runServiceLauncher(options);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`[service-launcher] ${message}\n`);
    process.exitCode = 1;
  }
}
