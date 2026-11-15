import * as Effect from "effect/Effect";

import { HostProcessArguments } from "@j1code/shared/hostProcess";

import packageJson from "../../package.json" with { type: "json" };

export type CliRunner = "npx" | "pnpm dlx" | "bunx";

/**
 * How the CLI was launched, judged by where its entry script lives. Each
 * package runner executes out of a distinctive cache/temp layout:
 *
 *   npx      ~/.npm/_npx/<hash>/node_modules/...
 *   pnpm dlx ~/.cache/pnpm/dlx/..., $PNPM_HOME/.pnpm/dlx/...,
 *            or %LOCALAPPDATA%/pnpm-cache/dlx/... on Windows
 *   bunx     ~/.bun/install/cache/... or $TMPDIR/bunx-<uid>-<spec>/...
 *
 * Global installs and repo checkouts match none of these and return null.
 * Detection is best-effort; callers must fail closed to a plain `t3` command.
 */
function detectCliRunner(entryPath: string): CliRunner | null {
  const path = entryPath.replaceAll("\\", "/");
  if (path.includes("/_npx/")) {
    return "npx";
  }
  if (
    path.includes("/pnpm/dlx/") ||
    path.includes("/.pnpm/dlx/") ||
    path.includes("/pnpm-cache/dlx/")
  ) {
    return "pnpm dlx";
  }
  if (path.includes("/.bun/install/cache/") || path.includes("/bunx-")) {
    return "bunx";
  }
  return null;
}

/**
 * The `t3` package spec to suggest. The literal spec the user typed (e.g.
 * `t3@nightly`) is resolved away before our process starts, so re-derive it
 * from the running version: nightly builds re-suggest the nightly channel,
 * anything else suggests the bare package.
 */
function suggestedPackageSpec(version: string, packageName: string): string {
  const channel = /^[^-+]+-(nightly|preview)\./.exec(version)?.[1];
  return channel === undefined ? packageName : `${packageName}@${channel}`;
}

/**
 * Render a `j1 <subcommand>` suggestion that matches how this process was
 * launched, so copy/pasting it actually works: `npx t3 connect` suggests
 * `npx t3 serve`, a global install suggests `j1 serve`, and a nightly build
 * keeps the `@nightly` tag.
 */
export function formatCliCommand(input: {
  readonly subcommand: string;
  readonly entryPath: string;
  readonly version: string;
}): string {
  const runner = detectCliRunner(input.entryPath);
  const entryPath = input.entryPath.replaceAll("\\", "/");
  // Existing npm packages and archive launchers keep their executable names.
  const legacyPackage = /(?:\/node_modules\/t3\/|\/cache\/t3@)/.test(entryPath);
  const command = legacyPackage || /(?:^|\/)t3(?:\.exe)?$/.test(entryPath) ? "t3" : "j1";
  if (runner === null) {
    return `${command} ${input.subcommand}`;
  }
  const packageName = legacyPackage ? "t3" : packageJson.name;
  return `${runner} ${suggestedPackageSpec(input.version, packageName)} ${input.subcommand}`;
}

/** `formatCliCommand` against this process's real entry path and version. */
export const resolveCliCommand = (subcommand: string) =>
  Effect.map(HostProcessArguments, (processArguments) =>
    formatCliCommand({
      subcommand,
      entryPath: processArguments[1] ?? "",
      version: packageJson.version,
    }),
  );
