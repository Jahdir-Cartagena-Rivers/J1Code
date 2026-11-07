import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const botCallTurn = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "bot-call-turn",
  tag: WS_METHODS.botCallTurn,
  staleTimeMs: 0,
  idleTtlMs: 60_000,
});
