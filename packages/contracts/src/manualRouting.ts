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
export function manualRouteStatusLabel(status: (typeof ManualRouteStatus.Type)["status"]): string {
  return {
    blocked: "Could not forward",
    suggested: "Needs your approval",
    queued: "Waiting to send",
    sending: "Sending",
    admitted: "Waiting for the receiving chat",
    delivered: "Delivered · awaiting acceptance",
    accepted: "Accepted by the receiving chat",
    completed: "Completed",
    failed: "Failed",
    uncertain: "Delivery not confirmed · check before retrying",
  }[status];
}
export function manualRouteReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  const labels: Record<string, string> = {
    "ambiguous-destination": "Choose which conversation should handle this request.",
    "missing-destination": "No destination was selected.",
    "hop-limit": "This request has reached its forwarding limit.",
    "routing-loop": "This request would return to a conversation it already visited.",
    "permission-escalation":
      "The destination requires broader permissions than this request allows.",
    "routing-off": "Automatic forwarding is turned off.",
    "send-outcome-unknown":
      "Delivery could not be confirmed. Check the destination before sending again.",
    "receipt-failed": "The receiving chat reported a failure.",
  };
  return (
    labels[reason] ??
    "This request could not be forwarded. Your original message is still available."
  );
}
export class ManualRouteActionError extends Schema.TaggedError<ManualRouteActionError>()(
  "ManualRouteActionError",
  {
    code: Schema.Literals(["unavailable", "invalid-input", "rejected"]),
    message: Schema.String,
  },
) {}
