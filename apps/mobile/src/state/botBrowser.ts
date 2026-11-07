import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const botBrowserPage = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile-bot-browser-page",
  tag: WS_METHODS.botBrowserPage,
  staleTimeMs: 0,
  idleTtlMs: 60000,
});
export const actOnBotBrowser = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile-bot-browser-action",
  tag: WS_METHODS.botBrowserAction,
});
