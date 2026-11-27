// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Launches a packaged desktop app against a seeded T3 home, opens a thread, and checks its
// messages render. Release jobs run it so a build whose backend or bundle cannot start fails
// before it is published.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";
import type { DesktopBridge } from "@j1code/contracts";
import * as HostProcess from "@j1code/shared/HostProcess";
import { _electron, type ElectronApplication } from "playwright-core";
import {
  readBackgroundRecord,
  stopBackgroundServer,
} from "../apps/desktop/src/backend/DesktopBackgroundBackend.ts";

// Synthetic J1 v1.101.0 fixture. Its ledger includes J1's migrations before the V2 cutover.
const FIXTURE_DB = NodePath.join(import.meta.dirname, "fixtures/desktop-launch/statev2.sqlite");
const THREAD_TITLE = "Release launch check";
const THREAD_MESSAGE = "The release opens and shows this thread.";
const STEP_TIMEOUT_MS = 60_000;
const runningOnWindows = HostProcess.Platform.defaultValue() === "win32";

const { values } = NodeUtil.parseArgs({
  options: {
    executable: { type: "string" },
    // An unpackaged app directory for a plain Electron executable, as PR CI runs it.
    app: { type: "string" },
    "artifacts-dir": { type: "string" },
    "existing-data-dir": { type: "string" },
  },
});
const executable = values.executable;
if (!executable)
  throw new Error(
    "Usage: smoke-desktop-app.ts --executable <app> [--app <dir>] [--artifacts-dir <dir>]",
  );
NodeAssert.ok(
  NodeFS.statSync(executable, { throwIfNoEntry: false })?.isFile(),
  `Desktop smoke executable does not exist: ${executable}`,
);
const artifactsDir = NodePath.resolve(values["artifacts-dir"] ?? "desktop-launch-check");

const existingDataDir = values["existing-data-dir"];
let existingHome: string | undefined;
if (existingDataDir) {
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new Error("An existing upgrade fixture must be on a disposable hosted runner.");
  }
  existingHome = NodeFS.realpathSync(existingDataDir);
  const relative = NodePath.relative(NodeFS.realpathSync(runnerTemp), existingHome);
  if (NodePath.isAbsolute(relative) || !/^j1-upgrade-\d+[\\/]j1$/.test(relative)) {
    throw new Error("The upgrade fixture is outside the expected runner directory.");
  }
}
const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-launch-"));
const t3Home = existingHome ?? NodePath.join(home, "t3");

let step = "preparing the smoke profile";
let app: ElectronApplication | undefined;
try {
  if (!existingHome) {
    NodeFS.mkdirSync(NodePath.join(t3Home, "userdata"), { recursive: true });
    NodeFS.copyFileSync(FIXTURE_DB, NodePath.join(t3Home, "userdata/statev2.sqlite"));
    NodeFS.writeFileSync(
      NodePath.join(t3Home, "userdata/client-settings.json"),
      JSON.stringify({ onboardingCompletedAt: "2026-01-01T00:00:00.000Z", wordWrap: false }),
    );
  }
  step = "launching the app";
  app = await _electron.launch({
    executablePath: executable,
    // Linux CI runners do not allow the Chromium sandbox's user namespaces.
    args: [
      ...(values.app ? [NodePath.resolve(values.app)] : []),
      ...(runningOnWindows ? [`--user-data-dir=${NodePath.join(home, "renderer")}`] : []),
      "--no-sandbox",
    ],
    // HOME stays real: on macOS a fake HOME has no login keychain, and safeStorage blocks the
    // main process on a keychain dialog. macOS keeps its Electron profile in the runner's HOME.
    env: {
      ...process.env,
      ...(runningOnWindows ? { APPDATA: NodePath.join(home, "roaming") } : {}),
      XDG_CONFIG_HOME: NodePath.join(home, ".config"),
      XDG_DATA_HOME: NodePath.join(home, ".local/share"),
      T3CODE_HOME: t3Home,
      T3CODE_TELEMETRY_ENABLED: "false",
      T3CODE_DISABLE_AUTO_UPDATE: "true",
    },
    timeout: STEP_TIMEOUT_MS,
  });
  // A backend that never starts leaves no window, or only the "could not start" window, so the
  // thread wait below fails either way and its screenshot shows the startup error.
  step = "waiting for the first window";
  const page = await app.firstWindow({ timeout: STEP_TIMEOUT_MS });
  try {
    step = `finding "${THREAD_TITLE}" in the sidebar`;
    const thread = page.locator("li[data-thread-item]", { hasText: THREAD_TITLE });
    await thread.waitFor({ timeout: STEP_TIMEOUT_MS });
    step = "opening the thread";
    await thread.click();
    await page.getByText(THREAD_MESSAGE).waitFor({ timeout: STEP_TIMEOUT_MS });
    if (runningOnWindows && !values.app) {
      step = "verifying the native title after opening the saved chat";
      const nativeWindow = await app.browserWindow(page);
      NodeAssert.match(
        await nativeWindow.evaluate((window) => (window as { getTitle(): string }).getTitle()),
        /^J1 Code(?: \((?:Alpha|Beta|Nightly)\))?$/,
      );
    }
    if (existingDataDir) {
      step = "reading the upgraded app's saved settings";
      const settings = await page.evaluate(() =>
        (globalThis as { desktopBridge?: Pick<DesktopBridge, "getClientSettings"> }).desktopBridge
          ?.getClientSettings(),
      );
      NodeAssert.equal(settings?.onboardingCompletedAt, "2026-01-01T00:00:00.000Z");
      NodeAssert.equal(settings?.wordWrap, false);
    }
  } catch (error) {
    NodeFS.mkdirSync(artifactsDir, { recursive: true });
    await page
      .screenshot({ path: NodePath.join(artifactsDir, "window.png"), timeout: 10_000 })
      .catch(() => {});
    throw error;
  }
  console.log("Desktop launch check passed: the app opened and showed the seeded thread.");
} catch (error) {
  console.error(`Desktop launch check failed while ${step}.`);
  NodeFS.mkdirSync(artifactsDir, { recursive: true });
  console.error(error instanceof Error ? error.message : error);
  const logs = NodePath.join(t3Home, "userdata/logs");
  if (NodeFS.existsSync(logs)) {
    NodeFS.cpSync(logs, NodePath.join(artifactsDir, "logs"), { recursive: true });
    const serverLog = NodePath.join(logs, "server-child.log");
    if (NodeFS.existsSync(serverLog)) {
      console.error("\nLast backend output (server-child.log):");
      console.error(NodeFS.readFileSync(serverLog, "utf8").split("\n").slice(-20).join("\n"));
    }
  }
  const workerLog = NodePath.join(t3Home, "background/server.log");
  if (NodeFS.existsSync(workerLog)) {
    NodeFS.copyFileSync(workerLog, NodePath.join(artifactsDir, "background-server.log"));
    console.error("\nLast background server output:");
    console.error(NodeFS.readFileSync(workerLog, "utf8").split("\n").slice(-20).join("\n"));
  }
  process.exitCode = 1;
} finally {
  try {
    if (app) {
      const child = app.process();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = NodeEvents.once(child, "exit");
        // The renderer's normal close path can ask whether to keep the server running.
        void app.evaluate(({ app }) => { setImmediate(() => app.exit(0)); }).catch(() => {});
        await Promise.race([exited, NodeTimersPromises.setTimeout(5_000)]);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await Promise.race([exited, NodeTimersPromises.setTimeout(5_000)]);
        }
      }
    }
  } finally {
    try {
      const background = await readBackgroundRecord(t3Home);
      if (background) {
        const runtime = NodePath.join(t3Home, "background", "runtimes");
        const relativeExe = NodePath.relative(runtime, background.executablePath);
        NodeAssert.ok(
          relativeExe && !relativeExe.startsWith("..") && !NodePath.isAbsolute(relativeExe),
          "The background server is outside the desktop smoke profile.",
        );
        await stopBackgroundServer(t3Home);
      }
      NodeFS.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
    } catch (error) {
      console.error("Desktop smoke profile cleanup failed:", error);
      process.exitCode = 1;
    }
  }
}

// A timed-out Electron transport can retain an IPC handle after its process closes.
await Promise.all([
  new Promise<void>((resolve) => process.stdout.write("", resolve)),
  new Promise<void>((resolve) => process.stderr.write("", resolve)),
]);
process.exit(process.exitCode ?? 0);
