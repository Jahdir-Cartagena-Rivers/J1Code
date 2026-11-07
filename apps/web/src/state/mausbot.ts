import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const openMausbot = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mausbot-open",
  tag: WS_METHODS.mausbotOpen,
});
export const setMausbotApprovalMode = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mausbot-approval-mode",
  tag: WS_METHODS.mausbotApprovalMode,
});
