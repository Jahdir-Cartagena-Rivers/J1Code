import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@j1code/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ExitCode } from "effect/unstable/process/ChildProcessSpawner";
import * as ServerConfig from "../config.ts";
import { ProcessRunner, type ProcessRunInput } from "../processRunner.ts";
import * as ProcessRunnerModule from "../processRunner.ts";
import * as Desktop from "./DesktopAutomation.ts";

const scope = {
  environmentId: EnvironmentId.make("desktop-test"),
  threadId: ThreadId.make("desktop-thread"),
  providerSessionId: "session-a",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["desktop"] as const),
  issuedAt: 1,
};
const output = (value: unknown, code = 0) => ({
  stdout: JSON.stringify(value),
  stderr: "",
  code: ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
const withRunner = (run: ProcessRunner["Service"]["run"]) =>
  Desktop.layer.pipe(
    Layer.provide(Layer.succeed(ProcessRunner, { run })),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "j1-desktop-test-" })),
    Layer.provide(NodeServices.layer),
  );

it("resolves real unpacked binaries and isolates provider snapshots", () => {
  expect(
    Desktop.desktopBinaryPath("C:/app/server.asar/node_modules/agent-desktop", "win32", "x64"),
  ).toBe("C:/app/server.asar.unpacked/node_modules/agent-desktop/bin/agent-desktop-win32-x64.exe");
  expect(() => Desktop.desktopBinaryPath("/app", "freebsd", "x64")).toThrow("unsupported");
  expect(Desktop.desktopScopeKey(scope)).not.toBe(
    Desktop.desktopScopeKey({ ...scope, providerSessionId: "session-b" }),
  );
  expect(Desktop.desktopScopeKey(scope)).not.toBe(
    Desktop.desktopScopeKey({ ...scope, threadId: ThreadId.make("other") }),
  );
});

it.effect(
  "runs the pinned native binary and its built-in guides without touching desktop apps",
  () =>
    Effect.gen(function* () {
      const desktop = yield* Desktop.DesktopAutomation;
      const version = yield* desktop.run(scope, "version", []);
      expect(version.result).toMatchObject({ version: Desktop.AGENT_DESKTOP_VERSION });
      const guide = yield* desktop.run(scope, "skills", ["get", "platform"]);
      expect(guide.result).toHaveProperty("content");
      // Session creation exercises native private-directory setup without opening any app.
      const session = yield* desktop.run(scope, "session", ["start", "--no-trace"]);
      expect(session.result).toHaveProperty("session_id");
    }).pipe(
      Effect.provide(
        Desktop.layer.pipe(
          Layer.provide(ProcessRunnerModule.layer),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "j1-desktop-native-" })),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
);

it.effect("passes argv literally and defaults to semantic actions", () => {
  const calls: Array<ProcessRunInput> = [];
  return Effect.gen(function* () {
    const desktop = yield* Desktop.DesktopAutomation;
    yield* desktop.run(scope, "set-value", ["@snapshot:e3", "--stdin"], {
      action: true,
      stdin: "hello $(not-a-command)",
    });
    yield* desktop.run(scope, "mouse-click", ["--xy", "10,20"], { action: true, headed: true });
    expect(calls[0]?.args).toEqual(["set-value", "@snapshot:e3", "--stdin"]);
    expect(calls[0]?.stdin).toBe("hello $(not-a-command)");
    expect(calls[0]?.env?.AGENT_DESKTOP_HOME).toContain(Desktop.desktopScopeKey(scope));
    expect(calls[1]?.args).toEqual(["--headed", "mouse-click", "--xy", "10,20"]);
  }).pipe(
    Effect.provide(
      withRunner((input) => {
        calls.push(input);
        return Effect.succeed(output({ ok: true, data: {} }));
      }),
    ),
  );
});

it.effect("rejects session escapes and hidden headed input before spawning", () =>
  Effect.gen(function* () {
    const desktop = yield* Desktop.DesktopAutomation;
    for (const flag of [
      "--session=other",
      "--headed",
      "--trace",
      "--screenshot=x.html",
      "bad\0arg",
    ]) {
      const error = yield* desktop.run(scope, "snapshot", [flag]).pipe(Effect.flip);
      expect(error.actionMayHaveRun).toBe(false);
    }
  }).pipe(Effect.provide(withRunner(() => Effect.die("must not spawn")))),
);

it.effect("preserves upstream refusal and delivery evidence without retrying", () => {
  let calls = 0;
  const detail = { code: "STALE_REF", disposition: { delivery: "not_delivered", retry: "safe" } };
  return Effect.gen(function* () {
    const desktop = yield* Desktop.DesktopAutomation;
    const error = yield* desktop
      .run(scope, "click", ["@old:e1"], { action: true })
      .pipe(Effect.flip);
    expect(error.detail).toEqual(detail);
    expect(error.actionMayHaveRun).toBe(false);
    expect(calls).toBe(1);
  }).pipe(
    Effect.provide(
      withRunner(() => {
        calls++;
        return Effect.succeed(output({ ok: false, error: detail }, 1));
      }),
    ),
  );
});

it.effect("treats malformed post-action output as uncertain delivery", () =>
  Effect.gen(function* () {
    const desktop = yield* Desktop.DesktopAutomation;
    const error = yield* desktop.run(scope, "click", ["@s:e1"], { action: true }).pipe(Effect.flip);
    expect(error.actionMayHaveRun).toBe(true);
  }).pipe(
    Effect.provide(withRunner(() => Effect.succeed({ ...output({}), stdout: "partial JSON" }))),
  ),
);
