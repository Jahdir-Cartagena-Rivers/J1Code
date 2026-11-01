import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Connection-local manual destination selection and confirmation RPCs.
export const MANUAL_ROUTING_METHODS = {
  prepare: "routing.prepare",
  confirm: "routing.confirm",
  status: "routing.status",
} as const;

export const ManualRouteEndpoint = Schema.Struct({
  environmentId: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  threadId: TrimmedNonEmptyString,
});
export const ManualRoutePrepareInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  source: ManualRouteEndpoint,
  destination: ManualRouteEndpoint,
});
export const ManualRouteConfirmInput = Schema.Struct({ token: TrimmedNonEmptyString });
export const ManualRouteListInput = Schema.Struct({ source: ManualRouteEndpoint });
export const ManualRouteStatusInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  source: ManualRouteEndpoint,
});
export const ManualRoutePrepared = Schema.Struct({
  token: TrimmedNonEmptyString,
  revision: NonNegativeInt,
  destination: ManualRouteEndpoint,
});
export const ManualRouteStatus = Schema.Struct({
  summary: Schema.optionalKey(Schema.String),
  requestId: TrimmedNonEmptyString,
  revision: NonNegativeInt,
  status: Schema.Literals([
    "blocked",
    "suggested",
    "queued",
    "sending",
    "admitted",
    "delivered",
    "accepted",
    "completed",
    "failed",
    "uncertain",
  ]),
  reason: Schema.NullOr(Schema.String),
  destination: Schema.NullOr(ManualRouteEndpoint),
  delivered: Schema.Boolean,
  accepted: Schema.Boolean,
  completed: Schema.Boolean,
  failed: Schema.Boolean,
  uncertain: Schema.Boolean,
});
export class ManualRouteActionError extends Schema.TaggedError<ManualRouteActionError>()(
  "ManualRouteActionError",
  {
    code: Schema.Literals(["unavailable", "invalid-input", "rejected"]),
    message: Schema.String,
  },
) {}
