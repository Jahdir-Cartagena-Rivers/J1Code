// @effect-diagnostics nodeBuiltinImport:off - Pure validation of the native static-directory boundary.
import * as NodePath from "node:path";

/** An explicit development override; the verified server/native archive stays unchanged. */
export function resolveMausbotDevUiDir(value: string | undefined, devUrl: URL | undefined) {
  const directory = value?.trim();
  if (!directory) return undefined;
  if (!devUrl) throw new Error("J1_MAUSBOT_DEV_UI_DIR requires a J1 development server.");
  if (!NodePath.isAbsolute(directory))
    throw new Error("J1_MAUSBOT_DEV_UI_DIR must be an absolute directory.");
  return NodePath.normalize(directory);
}
