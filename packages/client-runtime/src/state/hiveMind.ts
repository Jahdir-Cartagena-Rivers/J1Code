import { WS_METHODS, type HiveMindConfig } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";
export const formatHiveSkillRoots = (roots: HiveMindConfig["skills"]) =>
  (roots ?? []).map((root) => root.path + (root.project ? ` | ${root.project}` : "")).join("\n");
export const parseHiveSkillRoots = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [path = "", project] = line.split("|");
      return { path: path.trim(), ...(project?.trim() ? { project: project.trim() } : {}) };
    });

export function createHiveMindEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    snapshot: createEnvironmentRpcCommand(runtime, {
      label: "hive-mind:snapshot",
      tag: WS_METHODS.hiveMindSnapshot,
    }),
    importKnowledge: createEnvironmentRpcCommand(runtime, {
      label: "hive-mind:import",
      tag: WS_METHODS.hiveMindImport,
    }),
    search: createEnvironmentRpcCommand(runtime, {
      label: "hive-mind:search",
      tag: WS_METHODS.hiveMindSearch,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "hive-mind:configure",
      tag: WS_METHODS.hiveMindConfigure,
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "hive-mind:mutate",
      tag: WS_METHODS.hiveMindMutate,
    }),
    synchronize: createEnvironmentRpcCommand(runtime, {
      label: "hive-mind:sync",
      tag: WS_METHODS.hiveMindSync,
    }),
  };
}
