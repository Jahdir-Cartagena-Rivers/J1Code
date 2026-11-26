import * as Schema from "effect/Schema";

export class MausbotNativeProofError extends Schema.TaggedError<MausbotNativeProofError>()(
  "MausbotNativeProofError",
  { message: Schema.String, cause: Schema.Defect() },
) {}
