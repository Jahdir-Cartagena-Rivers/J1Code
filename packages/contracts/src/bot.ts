import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, TrimmedString } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";
import { BotId, BotName, BotInstructions } from "./botIdentity.ts";
export * from "./botIdentity.ts";

export const BotProfile = Schema.Struct({
  id: BotId,
  name: BotName,
  description: TrimmedString.check(Schema.isMaxLength(500)),
  instructions: BotInstructions,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  pinned: Schema.Boolean,
  archived: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BotProfile = typeof BotProfile.Type;

export const BotProfiles = Schema.Record(BotId, BotProfile).check(
  Schema.makeFilter((bots) => {
    return (
      (Object.keys(bots).length <= 100 &&
        Object.entries(bots).every(([id, bot]) => id === bot.id)) ||
      "Bot profiles must have matching IDs and contain at most 100 entries."
    );
  }),
);

export const BotProfileUpdates = Schema.Record(BotId, Schema.NullOr(BotProfile)).check(
  Schema.makeFilter(
    (bots) =>
      Object.keys(bots).length <= 100 &&
      Object.entries(bots).every(([id, bot]) => bot === null || id === bot.id),
  ),
);
