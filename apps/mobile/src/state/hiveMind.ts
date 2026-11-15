import { createHiveMindEnvironmentAtoms } from "@j1code/client-runtime/state/hive-mind";
import { connectionAtomRuntime } from "../connection/runtime";
export const hiveMind = createHiveMindEnvironmentAtoms(connectionAtomRuntime);
