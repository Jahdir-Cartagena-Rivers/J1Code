// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export function getWhisperRuntime(environment = process.env) {
  const root =
    environment.J1_DICTATION_HOME ??
    (environment.LOCALAPPDATA ? NodePath.join(environment.LOCALAPPDATA, "J1Code", "voice") : null);
  if (!root) return null;
  const python = NodePath.join(root, "venv", "Scripts", "python.exe");
  const model = NodePath.join(root, "model");
  return NodeFS.existsSync(python) && NodeFS.existsSync(NodePath.join(model, "model.bin"))
    ? { python, model }
    : null;
}
