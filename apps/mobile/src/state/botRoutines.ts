import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const botRoutineHistory = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "bot-routine-history",
  tag: WS_METHODS.botRoutineHistory,
  staleTimeMs: 0,
  idleTtlMs: 60_000,
});
