import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, TrimmedString, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";
import { BotId, BotName, BotInstructions } from "./botIdentity.ts";
export * from "./botIdentity.ts";

export const BotBrowserPage = Schema.Struct({
  revision: Schema.String.check(Schema.isMaxLength(128)),
  url: Schema.String.check(Schema.isMaxLength(8192)),
  title: Schema.String.check(Schema.isMaxLength(512)),
  html: Schema.String.check(Schema.isMaxLength(500000)),
});
export type BotBrowserPage = typeof BotBrowserPage.Type;
export const BotBrowserAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("open") }),
  Schema.Struct({
    type: Schema.Literal("navigate"),
    url: Schema.String.check(Schema.isMaxLength(8192)),
  }),
  Schema.Struct({
    type: Schema.Literal("click"),
    revision: Schema.String.check(Schema.isMaxLength(128)),
    node: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20000 })),
    edits: Schema.optional(
      Schema.Array(
        Schema.Struct({
          node: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20000 })),
          value: Schema.String.check(Schema.isMaxLength(32000)),
        }),
      ).check(Schema.isMaxLength(64)),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("fill"),
    revision: Schema.String.check(Schema.isMaxLength(128)),
    node: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20000 })),
    value: Schema.String.check(Schema.isMaxLength(32000)),
    edits: Schema.optional(
      Schema.Array(
        Schema.Struct({
          node: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20000 })),
          value: Schema.String.check(Schema.isMaxLength(32000)),
        }),
      ).check(Schema.isMaxLength(64)),
    ),
  }),
]);
export type BotBrowserAction = typeof BotBrowserAction.Type;
export class BotBrowserError extends Schema.TaggedError<BotBrowserError>()("BotBrowserError", {
  message: Schema.String,
}) {}

/** A schedule belongs to the bot, independent of any conversation or project. */
export const BotRoutineSchedule = Schema.Union([
  Schema.Struct({ type: Schema.Literal("once"), at: IsoDateTime }),
  Schema.Struct({
    type: Schema.Literal("interval"),
    anchorAt: IsoDateTime,
    everyMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 525600 })),
  }),
]);
export type BotRoutineSchedule = typeof BotRoutineSchedule.Type;
export const BotRoutine = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(32000)),
  enabled: Schema.Boolean,
  schedule: BotRoutineSchedule,
});
export type BotRoutine = typeof BotRoutine.Type;

export const BotRoutineRun = Schema.Struct({
  routineId: TrimmedNonEmptyString,
  occurrence: Schema.Number,
  status: Schema.Literals(["claimed", "admitted", "failed", "uncertain"]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  detail: Schema.NullOr(Schema.String),
});
export type BotRoutineRun = typeof BotRoutineRun.Type;
export class BotRoutineHistoryError extends Schema.TaggedError<BotRoutineHistoryError>()(
  "BotRoutineHistoryError",
  { message: Schema.String },
) {}

export const BotCallTurn = Schema.Struct({
  turnId: Schema.NullOr(Schema.String),
  state: Schema.String,
  assistantMessageId: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
});
export class BotCallTurnError extends Schema.TaggedError<BotCallTurnError>()("BotCallTurnError", {
  message: Schema.String,
}) {}

export const BotProfile = Schema.Struct({
  id: BotId,
  name: BotName,
  voiceAutoPlay: Schema.optional(Schema.Boolean),
  voiceURI: Schema.optional(TrimmedString.check(Schema.isMaxLength(512))),
  icon: Schema.optional(TrimmedString.check(Schema.isMaxLength(16))),
  description: TrimmedString.check(Schema.isMaxLength(500)),
  instructions: BotInstructions,
  projectId: Schema.NullOr(ProjectId),
  routines: Schema.optional(
    Schema.Array(BotRoutine).check(
      Schema.isMaxLength(50),
      Schema.makeFilter(
        (routines) =>
          new Set(routines.map((routine) => routine.id)).size === routines.length ||
          "Routine IDs must be unique.",
      ),
    ),
  ),
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
