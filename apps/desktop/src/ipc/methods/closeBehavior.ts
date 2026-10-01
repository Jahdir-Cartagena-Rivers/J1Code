import { DesktopCloseBehaviorSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Settings from "../../settings/DesktopAppSettings.ts";
import * as Channels from "../channels.ts";
import { makeIpcMethod, makeSyncIpcMethod } from "../DesktopIpc.ts";

export const getCloseBehavior = makeSyncIpcMethod({
  channel: Channels.GET_CLOSE_BEHAVIOR_CHANNEL,
  result: DesktopCloseBehaviorSchema,
  handler: Effect.fn("desktop.ipc.getCloseBehavior")(function* () {
    return (yield* (yield* Settings.DesktopAppSettings).get).closeBehavior;
  }),
});
export const setCloseBehavior = makeIpcMethod({
  channel: Channels.SET_CLOSE_BEHAVIOR_CHANNEL,
  payload: DesktopCloseBehaviorSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.setCloseBehavior")(function* (behavior) {
    yield* (yield* Settings.DesktopAppSettings).setCloseBehavior(behavior);
  }),
});
