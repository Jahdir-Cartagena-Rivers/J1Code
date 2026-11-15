import { WS_METHODS } from "@j1code/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@j1code/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const botRoutineHistory = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "bot-routine-history",
  tag: WS_METHODS.botRoutineHistory,
  staleTimeMs: 0,
  idleTtlMs: 60_000,
});
