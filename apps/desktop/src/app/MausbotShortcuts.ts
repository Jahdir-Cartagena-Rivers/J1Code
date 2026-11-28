// @effect-diagnostics nodeBuiltinImport:off -- The Windows shortcut driver needs exclusive file creation and native Windows path comparison.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  mausbotSavedAppLaunchId,
  mausbotSavedAppLaunchUrl,
  type MausbotShortcutRequest,
  type MausbotShortcutResult,
} from "@j1code/contracts";

const SUFFIX = " (J1 Code).lnk";

interface ShortcutDriver {
  readonly read: (file: string) => { readonly target: string; readonly args?: string };
  readonly write: (file: string, target: string, args: string) => boolean;
}

interface ShortcutLocations {
  readonly executable: string;
  readonly programs: string;
  readonly desktop: string;
}

interface Launcher {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

const sameWindowsPath = (left: string, right: string) =>
  NodePath.win32.normalize(left).toLowerCase() === NodePath.win32.normalize(right).toLowerCase();

const isFileError = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;

const safeName = (name: string) =>
  name
    .replaceAll(/[<>:"/\\|?*]|\p{Cc}/gu, " ")
    .trim()
    .slice(0, 70)
    .replace(/[ .]+$/, "") || "Saved app";

async function launchers(folder: string, executable: string, driver: ShortcutDriver) {
  const entries = await NodeFSP.readdir(folder, { withFileTypes: true }).catch((error: unknown) => {
    if (isFileError(error, "ENOENT")) return [];
    throw error;
  });
  const owned: Launcher[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(SUFFIX)) continue;
    const path = NodePath.join(folder, entry.name);
    try {
      const shortcut = driver.read(path);
      const id = mausbotSavedAppLaunchId(shortcut.args ?? "");
      if (id !== null && sameWindowsPath(shortcut.target, executable)) {
        owned.push({ id, name: entry.name.slice(0, -SUFFIX.length), path });
      }
    } catch {
      // Files that the shell cannot read are not J1-owned shortcuts.
    }
  }
  return owned;
}

async function createLauncher(
  folder: string,
  app: { readonly id: string; readonly name: string },
  executable: string,
  driver: ShortcutDriver,
): Promise<Launcher> {
  const args = mausbotSavedAppLaunchUrl(app.id);
  if (args === null) throw new Error("Invalid saved app ID.");
  const name = safeName(app.name);
  const path = NodePath.join(folder, name + SUFFIX);
  const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-shortcut-"));
  const file = NodePath.join(temporary, "shortcut.lnk");
  try {
    if (!driver.write(file, executable, args))
      throw new Error("Could not create saved-app shortcut.");
    await NodeFSP.copyFile(file, path, NodeFS.constants.COPYFILE_EXCL);
    return { id: app.id, name, path };
  } finally {
    await NodeFSP.unlink(file).catch((error: unknown) => {
      if (!isFileError(error, "ENOENT")) throw error;
    });
    await NodeFSP.rmdir(temporary);
  }
}

export async function manageMausbotShortcuts(
  request: typeof MausbotShortcutRequest.Type,
  locations: ShortcutLocations,
  driver: ShortcutDriver,
): Promise<typeof MausbotShortcutResult.Type> {
  const { executable, desktop } = locations;
  const programs = await NodeFSP.realpath(locations.programs);
  const appFolder = NodePath.join(programs, "J1 Code Apps");
  if (request.operation === "install") await NodeFSP.mkdir(appFolder, { recursive: true });
  const resolvedFolder = await NodeFSP.realpath(appFolder).catch((error: unknown) => {
    if (isFileError(error, "ENOENT")) return null;
    throw error;
  });
  if (resolvedFolder !== null && !sameWindowsPath(resolvedFolder, appFolder)) {
    return { ok: false, reason: "unavailable" };
  }
  const [installed, desktopIcons] = await Promise.all([
    launchers(appFolder, executable, driver),
    launchers(desktop, executable, driver),
  ]);
  if (request.operation === "list") {
    const onDesktop = new Set(desktopIcons.map((launcher) => launcher.id));
    return {
      available: true,
      apps: installed.map((launcher) => ({ ...launcher, desktop: onDesktop.has(launcher.id) })),
    };
  }
  const existing = installed.find((launcher) => launcher.id === request.appId);
  const icon = desktopIcons.find((launcher) => launcher.id === request.appId);
  if (request.operation === "removeFromDesktop" || request.operation === "uninstall") {
    if (icon) await NodeFSP.unlink(icon.path);
    if (request.operation === "uninstall" && existing) await NodeFSP.unlink(existing.path);
    return {
      ok: true,
      removed: icon !== undefined || (request.operation === "uninstall" && existing !== undefined),
    };
  }
  try {
    if (request.operation === "install") {
      const launcher =
        existing ??
        (await createLauncher(
          appFolder,
          { id: request.appId, name: request.name },
          executable,
          driver,
        ));
      return { ok: true, app: { ...launcher, desktop: icon !== undefined } };
    }
    if (existing === undefined) return { ok: false, reason: "not-installed" };
    if (!icon) {
      const directory = await NodeFSP.stat(desktop).catch(() => null);
      if (!directory?.isDirectory()) return { ok: false, reason: "no-desktop" };
      await createLauncher(desktop, existing, executable, driver);
    }
    return { ok: true, app: { ...existing, desktop: true } };
  } catch (error) {
    return { ok: false, reason: isFileError(error, "EEXIST") ? "taken" : "failed" };
  }
}
