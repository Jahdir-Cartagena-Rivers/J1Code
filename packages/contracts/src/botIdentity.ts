import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

export const BotId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("BotId"),
);
export type BotId = typeof BotId.Type;
export const BotName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
export const BotInstructions = TrimmedString.check(Schema.isMaxLength(32_000));

// Conversations retain their chosen identity when the reusable profile is edited or removed.
export const ThreadBotReference = Schema.Struct({
  id: BotId,
  name: BotName,
});
export type ThreadBotReference = typeof ThreadBotReference.Type;

export const ThreadBotIdentity = Schema.Struct({
  ...ThreadBotReference.fields,
  instructions: BotInstructions,
});
export type ThreadBotIdentity = typeof ThreadBotIdentity.Type;
