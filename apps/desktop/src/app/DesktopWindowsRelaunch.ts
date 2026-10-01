// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

/** Portable Electron runs in a temporary directory; Windows must relaunch its outer executable. */
export function windowsRelaunchDetails(input: {
  appId: string;
  appName: string;
  executablePath: string;
  portableExecutable?: string | undefined;
  iconPath: string;
}) {
  const executable =
    input.portableExecutable && NodePath.win32.isAbsolute(input.portableExecutable)
      ? input.portableExecutable
      : input.executablePath;
  return {
    appId: input.appId,
    appIconPath: input.iconPath,
    appIconIndex: 0,
    relaunchCommand: `"${executable}"`,
    relaunchDisplayName: input.appName,
  };
}
