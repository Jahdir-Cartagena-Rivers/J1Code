import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import { DesktopToolError, type DesktopScreenshotInput } from "@j1code/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HostProcessArchitecture, HostProcessPlatform } from "@j1code/shared/hostProcess";
import { ServerConfig } from "../config.ts";
import { ProcessRunner } from "../processRunner.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";

export const AGENT_DESKTOP_VERSION = "1.3.1";
const Envelope = Schema.Struct({
  ok: Schema.Boolean,
  data: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});
const decodeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(Envelope));
const isDesktopToolError = Schema.is(DesktopToolError);
const wasNotDelivered = Schema.is(
  Schema.Struct({ disposition: Schema.Struct({ delivery: Schema.Literal("not_delivered") }) }),
);

/** Native binaries must be spawned outside Electron's asar virtual filesystem. */
export function desktopBinaryPath(packageRoot: string, platform: string, arch: string): string {
  if (!["win32", "darwin", "linux"].includes(platform) || !["x64", "arm64"].includes(arch)) {
    throw new Error(`Desktop automation is unsupported on ${platform}-${arch}.`);
  }
  const root = packageRoot.replace(/\.asar([\\/])/g, ".asar.unpacked$1");
  return `${root}/bin/agent-desktop-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`;
}

/** Keep snapshots private to the calling provider session, even across concurrent threads. */
export function desktopScopeKey(
  scope: Pick<McpInvocationScope, "threadId" | "providerSessionId">,
): string {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([scope.threadId, scope.providerSessionId]))
    .digest("hex");
}

export function validateDesktopArguments(args: ReadonlyArray<string>): void {
  for (const arg of args) {
    if (
      arg.includes("\0") ||
      /^--(?:headed|session|agent-id|trace|trace-strict|debug|screenshot)(?:=|$)/.test(arg)
    ) {
      throw new Error(
        "Use J1's headed field; session, trace and debug output flags are managed by J1.",
      );
    }
  }
}

export class DesktopAutomation extends Context.Service<
  DesktopAutomation,
  {
    readonly run: (
      scope: McpInvocationScope,
      command: string,
      args: ReadonlyArray<string>,
      options?: { readonly headed?: boolean; readonly stdin?: string; readonly action?: boolean },
    ) => Effect.Effect<{ result: unknown }, DesktopToolError>;
    readonly screenshot: (
      scope: McpInvocationScope,
      input: typeof DesktopScreenshotInput.Type,
    ) => Effect.Effect<
      { screenshot: { mimeType: "image/png"; data: string; width: number; height: number } },
      DesktopToolError
    >;
  }
>()("@j1code/server/desktop/DesktopAutomation") {}

export const layer = Layer.effect(
  DesktopAutomation,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const runner = yield* ProcessRunner;
    const platform = yield* HostProcessPlatform;
    const arch = yield* HostProcessArchitecture;

    const run = Effect.fn("DesktopAutomation.run")(function* (
      scope: McpInvocationScope,
      command: string,
      args: ReadonlyArray<string>,
      options: {
        readonly headed?: boolean;
        readonly stdin?: string;
        readonly action?: boolean;
      } = {},
    ) {
      yield* Effect.try({
        try: () => validateDesktopArguments(args),
        catch: (cause) => new DesktopToolError({ reason: String(cause), actionMayHaveRun: false }),
      });
      const binary = yield* Effect.try({
        try: () =>
          desktopBinaryPath(
            path.dirname(
              NodeModule.createRequire(import.meta.url).resolve("agent-desktop/package.json"),
            ),
            platform,
            arch,
          ),
        catch: () =>
          new DesktopToolError({
            reason: `Bundled agent-desktop ${AGENT_DESKTOP_VERSION} is unavailable for ${platform}-${arch}.`,
            actionMayHaveRun: false,
          }),
      });
      const home = path.join(config.stateDir, "desktop", desktopScopeKey(scope));
      // The native tool creates its state root with platform-private permissions.
      // Precreating it with mode 0700 inherits a broad Windows DACL that it refuses.
      // Do not inherit another agent's snapshot namespace, helper override or tracing destination.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.toUpperCase().startsWith("AGENT_DESKTOP_"),
        ),
      );
      env.AGENT_DESKTOP_HOME = home;
      if (platform === "darwin")
        env.AGENT_DESKTOP_MACOS_HELPER_PATH = path.join(
          path.dirname(binary),
          `agent-desktop-macos-helper-darwin-${arch}`,
        );
      const output = yield* runner
        .run({
          command: binary,
          args: [...(options.headed ? ["--headed"] : []), command, ...args],
          env,
          ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
          timeout: "60 seconds",
          maxOutputBytes: 24_000,
        })
        .pipe(
          Effect.mapError(
            () =>
              new DesktopToolError({
                reason:
                  "Desktop command did not return a bounded result. Observe live state before retrying an action; use a compact snapshot or drill into one region for large trees.",
                actionMayHaveRun: options.action === true,
              }),
          ),
        );
      if (args.includes("--help") || args.includes("-h"))
        return { result: { help: output.stdout } };
      const envelope = yield* decodeEnvelope(output.stdout).pipe(
        Effect.mapError(
          () =>
            new DesktopToolError({
              reason:
                "Desktop command returned an invalid envelope. Observe before retrying an action.",
              actionMayHaveRun: options.action === true,
            }),
        ),
      );
      if (!envelope.ok || output.code !== 0) {
        return yield* new DesktopToolError({
          reason:
            "agent-desktop refused or failed the command. Inspect detail.code and detail.disposition before deciding whether to retry.",
          detail: envelope.error,
          actionMayHaveRun: options.action === true && !wasNotDelivered(envelope.error),
        });
      }
      return { result: envelope.data };
    });

    const screenshot = Effect.fn("DesktopAutomation.screenshot")(function* (
      scope: McpInvocationScope,
      input: typeof DesktopScreenshotInput.Type,
    ) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "j1-desktop-shot-" });
          const file = path.join(dir, "screen.png");
          yield* run(scope, "screenshot", [
            ...(input.app === undefined ? [] : ["--app", input.app]),
            ...(input.windowId === undefined ? [] : ["--window-id", input.windowId]),
            ...(input.screen === undefined ? [] : ["--screen", String(input.screen)]),
            file,
          ]);
          const stat = yield* fs.stat(file);
          if (Number(stat.size) > 20 * 1024 * 1024)
            return yield* new DesktopToolError({
              reason: "Desktop screenshot exceeds 20 MiB. Capture one application window.",
              actionMayHaveRun: false,
            });
          const png = Buffer.from(yield* fs.readFile(file));
          if (
            png.length < 24 ||
            png.readUInt32BE(0) !== 0x89504e47 ||
            png.readUInt32BE(4) !== 0x0d0a1a0a ||
            png.toString("ascii", 12, 16) !== "IHDR"
          )
            return yield* new DesktopToolError({
              reason: "Desktop screenshot is not a PNG.",
              actionMayHaveRun: false,
            });
          return {
            screenshot: {
              mimeType: "image/png" as const,
              data: png.toString("base64"),
              width: png.readUInt32BE(16),
              height: png.readUInt32BE(20),
            },
          };
        }),
      ).pipe(
        Effect.mapError((cause) =>
          isDesktopToolError(cause)
            ? cause
            : new DesktopToolError({
                reason: "Desktop screenshot could not be read.",
                actionMayHaveRun: false,
              }),
        ),
      );
    });
    return DesktopAutomation.of({ run, screenshot });
  }),
);
