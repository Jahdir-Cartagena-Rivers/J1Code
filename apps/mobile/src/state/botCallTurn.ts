import { WS_METHODS } from "@j1code/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@j1code/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const botCallTurn = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "bot-call-turn",
  tag: WS_METHODS.botCallTurn,
  staleTimeMs: 0,
  idleTtlMs: 60_000,
});
