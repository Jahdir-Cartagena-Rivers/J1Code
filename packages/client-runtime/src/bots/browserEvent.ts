import { BotBrowserAction } from "@t3tools/contracts";
import { Option, Schema } from "effect";
const Event = Schema.Struct({
  type: Schema.Literal("j1-bot-browser"),
  revision: Schema.String,
  action: BotBrowserAction,
});
const decode = Schema.decodeUnknownOption(Event);
/** Ignore messages from obsolete snapshots and restrict the frame to node actions. */
export function readBotBrowserEvent(data: unknown, revision: string): BotBrowserAction | null {
  const event = decode(data);
  if (
    Option.isNone(event) ||
    event.value.revision !== revision ||
    event.value.action.type === "navigate" ||
    event.value.action.type === "open" ||
    event.value.action.revision !== revision
  )
    return null;
  return event.value.action;
}
