import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { ServerInstallation } from "@j1code/contracts";
import * as HostProcess from "@j1code/shared/HostProcess";
import { resolveCommandPath } from "@j1code/shared/shell";

import packageJson from "../../package.json" with { type: "json" };
import {
  findPosixLauncher,
  readPosixLauncherTarget,
  resolveLauncherPath,
} from "../cloud/pinnedRuntime.ts";

const PINNED_RUNTIME_ENTRY = /^(.*)\/runtime\/versions\/[^/]+\/t3$/;

export type CliRunner = "npx" | "pnpm dlx" | "bunx";

/** Detection is best-effort; callers can fall back to the install's direct command. */
export function detectCliRunner(entryPath: string): CliRunner | null {
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

const InstallManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  bin: Schema.optionalKey(Schema.Struct({ t3: Schema.String })),
});
const decodeInstallManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(InstallManifest));

const isLegacyPackagePath = (path: string) =>
  /\/(?:node_modules\/t3|cache\/t3(?:@[^/]+)?)\//.test(path.replaceAll("\\", "/"));

const isJ1PackagePath = (path: string) =>
  /\/(?:node_modules\/@j1code\/server|cache\/@j1code\/server(?:@[^/]+)?)\//.test(
    path.replaceAll("\\", "/"),
  );

const directCommandName = (path: string) =>
  isLegacyPackagePath(path) || /(?:^|[\\/])t3(?:\.exe)?$/i.test(path) ? "t3" : "j1";

/**
 * `T3CODE_NPM_LAUNCHER_PATH` is inherited by child shells, so accept it only for this package
 * version to avoid claiming another `t3` invocation is the npm install.
 */
export const resolveEntryPath = Effect.gen(function* () {
  const executable = yield* HostProcess.IsExecutable;
  const entry = executable
    ? yield* HostProcess.ExecutablePath
    : (yield* HostProcess.Arguments)[1] ?? "";
  const npmLauncher = (yield* HostProcess.Environment).T3CODE_NPM_LAUNCHER_PATH?.trim();
  if (executable && npmLauncher) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (path.isAbsolute(npmLauncher)) {
      const info = yield* fs.stat(npmLauncher).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type === "File") {
        const manifest = yield* fs
          .readFileString(path.join(path.dirname(npmLauncher), "../package.json"))
          .pipe(Effect.flatMap(decodeInstallManifest), Effect.option);
        const legacyLauncher =
          isLegacyPackagePath(npmLauncher) &&
          /(?:^|[\\/])\.t3[\\/]/.test(entry) &&
          directCommandName(entry) === "t3";
        if (
          Option.isSome(manifest) &&
          manifest.value.version === packageJson.version &&
          ((manifest.value.name === packageJson.name && isJ1PackagePath(npmLauncher)) ||
            (manifest.value.name === "t3" && legacyLauncher))
        ) {
          return npmLauncher;
        }
      }
    }
  }
  return entry;
});

export const resolveServerInstallation = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const rawEntry = yield* resolveEntryPath;
  if (!rawEntry) return null;
  const entry = yield* fs.realPath(rawEntry);
  const runtime = PINNED_RUNTIME_ENTRY.exec(entry);
  if (runtime) {
    const launchedAs = yield* resolveLauncherPath;
    if (launchedAs === undefined) return null;
    const link = yield* fs.readLink(launchedAs).pipe(Effect.option);
    // A launcher script execs the runtime itself, so look for the script that runs it.
    const launcher = Option.isSome(link)
      ? launchedAs
      : yield* findPosixLauncher({
          launchedAs,
          versionsDir: path.join(runtime[1] || "/", "runtime/versions"),
        });
    // None for a runtime started directly, as SSH launches do, or through a copy.
    if (launcher === undefined) return null;
    const target = Option.isSome(link)
      ? path.resolve(path.dirname(launcher), link.value)
      : yield* readPosixLauncherTarget(launcher);
    // Keep the home as the launcher spells it; `t3 update` only repoints launchers into that spelling.
    const linked = target === undefined ? null : PINNED_RUNTIME_ENTRY.exec(target);
    if (
      !linked ||
      target === undefined ||
      (yield* fs.realPath(linked[1] || "/")) !== (runtime[1] || "/") ||
      (yield* fs.realPath(target)) !== entry
    ) {
      return null;
    }
    return {
      kind: "t3-launcher",
      launcher,
      baseDir: linked[1] || "/",
    } satisfies ServerInstallation;
  }
  if (
    !isLegacyPackagePath(entry) ||
    !/(?:\/dist\/bin\.mjs|\/bin\/t3\.mjs)$/.test(entry.replaceAll("\\", "/"))
  ) {
    return null;
  }
  const packageRoot = path.dirname(path.dirname(entry));
  const manifest = yield* fs
    .readFileString(path.join(packageRoot, "package.json"))
    .pipe(Effect.flatMap(decodeInstallManifest));
  if (manifest.name !== "t3" || manifest.version !== packageJson.version) return null;

  const match = /^(.*)\/lib\/node_modules\/t3\/(?:dist\/bin\.mjs|bin\/t3\.mjs)$/.exec(entry);
  if (!match) {
    const runner = detectCliRunner(rawEntry);
    return runner === null
      ? null
      : ({
          kind: runner === "pnpm dlx" ? "pnpm-dlx" : runner,
          npmPackage: "t3",
        } satisfies ServerInstallation);
  }
  if (platform === "win32") return null;
  const prefix = match[1] || "/";
  if (
    prefix.includes("/node_modules/") ||
    /\/(?:Cellar|Caskroom)\//i.test(prefix) ||
    /\/mise\/installs\/(?!node\/)[^/]+\//.test(prefix)
  )
    return null;

  if (!manifest.bin) return null;
  const bin = yield* fs.realPath(path.join(packageRoot, manifest.bin.t3));
  const globalBin = yield* fs.realPath(path.join(prefix, "bin/t3"));
  if (globalBin !== bin || bin !== entry) return null;
  return { kind: "npm-global", prefix, npmPackage: "t3" } satisfies ServerInstallation;
}).pipe(Effect.orElseSucceed(() => null));

/** The original package spec is unavailable at startup; infer its channel from the version. */
function suggestedPackageSpec(version: string, packageName: string): string {
  const channel = /^[^-+]+-(nightly|preview)\./.exec(version)?.[1];
  return channel === undefined ? packageName : `${packageName}@${channel}`;
}

/**
 * Render a `j1 <subcommand>` suggestion that matches how this process was
 * launched, retaining the package name and release channel.
 */
export function formatCliCommand(input: {
  readonly subcommand: string;
  readonly entryPath: string;
  readonly version: string;
}): string {
  // Existing npm packages and archive launchers keep their executable names.
  const legacyPackage = isLegacyPackagePath(input.entryPath);
  const runner =
    legacyPackage || isJ1PackagePath(input.entryPath) ? detectCliRunner(input.entryPath) : null;
  const command = directCommandName(input.entryPath);
  const commandSuffix = input.subcommand ? ` ${input.subcommand}` : "";
  if (runner === null) {
    return `${command}${commandSuffix}`;
  }
  const packageName = legacyPackage ? "t3" : packageJson.name;
  return `${runner} ${suggestedPackageSpec(input.version, packageName)}${commandSuffix}`;
}

export const resolveCliCommand = (subcommand: string) =>
  Effect.map(resolveEntryPath, (entryPath) =>
    formatCliCommand({ subcommand, entryPath, version: packageJson.version }),
  );

const shellWord = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;

/** PowerShell also treats typographic quotes as delimiters; escape them and suppress expansion. */
const powershellWord = (value: string) =>
  `"${value
    .replaceAll("`", "``")
    .replaceAll("$", "`$")
    .replace(/["\u201C\u201D\u201E]/g, "$&$&")}"`;

export const hostShellWord = (platform: NodeJS.Platform, value: string) =>
  platform === "win32" ? powershellWord(value) : shellWord(value);

/** Script installs have no single launcher; desktop shims and standalone binaries do. */
const resolveInstallLauncher = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const shim = (yield* HostProcess.Environment).T3CODE_CLI_PATH?.trim();
  if (shim && (yield* Path.Path).isAbsolute(shim)) {
    const info = yield* fs.stat(shim).pipe(Effect.option);
    if (Option.isSome(info) && info.value.type === "File") return Option.some(shim);
  }
  return (yield* HostProcess.IsExecutable)
    ? Option.some(yield* HostProcess.ExecutablePath)
    : Option.none<string>();
});

/**
 * Uses this install's command on PATH, the originating runner, or its absolute launcher path.
 * Arguments are quoted for POSIX shells or PowerShell on Windows.
 */
export const resolveHostCliCommand = Effect.fn("invocation.resolveHostCliCommand")(function* (
  subcommand: string,
  args: ReadonlyArray<string> = [],
) {
  const platform = yield* HostProcess.Platform;
  const withArgs = (prefix: string) =>
    [prefix.trimEnd(), ...args.map((arg) => hostShellWord(platform, arg))].join(" ");
  const command = yield* resolveCliCommand(subcommand);
  const name = command.split(" ", 1)[0];
  if (name !== "t3" && name !== "j1") return { command: withArgs(command), launcher: false };
  const onPath = yield* resolveCommandPath(name);
  if (onPath !== null) {
    const shim = (yield* HostProcess.Environment).T3CODE_CLI_PATH?.trim();
    const fs = yield* FileSystem.FileSystem;
    const real = (file: string) => fs.realPath(file).pipe(Effect.orElseSucceed(() => null));
    // Windows `t3.cmd` shims are text files that never realpath to the executable they run.
    const own = shim
      ? yield* real(shim)
      : platform !== "win32" && (yield* HostProcess.IsExecutable)
        ? yield* resolveEntryPath.pipe(
            Effect.flatMap((entry) =>
              real(entry).pipe(Effect.map((resolved) => resolved ?? entry)),
            ),
          )
        : null;
    if (own === null || own === (yield* real(onPath))) {
      return { command: withArgs(command), launcher: false };
    }
  }
  const launcher = yield* resolveInstallLauncher;
  if (Option.isNone(launcher)) return { command: withArgs(command), launcher: false };
  // PowerShell runs a quoted path only through the call operator.
  const quoted = hostShellWord(platform, launcher.value);
  const call = platform === "win32" ? `& ${quoted}` : quoted;
  return { command: withArgs(`${call} ${subcommand}`), launcher: true };
});

/** A hint's command, run against the caller's `--base-dir` when one was given. */
export const resolveHostCliHint = (
  subcommand: string,
  baseDir: Option.Option<string>,
  args: ReadonlyArray<string> = [],
) =>
  resolveHostCliCommand(subcommand, [
    ...Option.match(baseDir, { onNone: () => [], onSome: (dir) => ["--base-dir", dir] }),
    ...args,
  ]).pipe(Effect.map(({ command }) => command));

/**
 * `sudo` resets PATH on most distributions, which drops a user-installed Node
 * (nvm, fnm, a tarball) and with it `npx` or a global `t3`, so the command
 * carries PATH through unless Node is on root's PATH too. An absolute launcher
 * needs neither.
 */
export const resolveRootCliCommand = Effect.fn("invocation.resolveRootCliCommand")(function* (
  subcommand: string,
  args: ReadonlyArray<string> = [],
) {
  const { command, launcher } = yield* resolveHostCliCommand(subcommand, args);
  if (launcher) return `sudo ${command}`;
  const executablePath = yield* HostProcess.ExecutablePath;
  const systemNode = ROOT_PATH_DIRECTORIES.some((directory) =>
    executablePath.startsWith(`${directory}/`),
  );
  return systemNode ? `sudo ${command}` : `sudo env "PATH=$PATH" ${command}`;
});

const ROOT_PATH_DIRECTORIES = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
];
