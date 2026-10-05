import { createHiveMindEnvironmentAtoms } from "@t3tools/client-runtime/state/hive-mind";
import { connectionAtomRuntime } from "../connection/runtime";
export const hiveMind = createHiveMindEnvironmentAtoms(connectionAtomRuntime);
