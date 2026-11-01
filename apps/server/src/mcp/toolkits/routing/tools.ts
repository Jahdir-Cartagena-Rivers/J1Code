import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { RouteInput, RoutingBoundaryPorts } from "./boundary.ts";

const dependencies = [McpInvocationContext, RoutingBoundaryPorts];
const Status = Schema.Struct({
  requestId: Schema.String,
  status: Schema.String,
  reason: Schema.NullOr(Schema.String),
  destinationUrl: Schema.NullOr(Schema.String),
  sourceUrl: Schema.String,
});
// Recipient reports are authenticated to the receiving conversation; transport is recorded separately.
export const RoutingToolkit = Toolkit.make(
  Tool.make("release_task", {
    description:
      "Release this conversation's ownership of a task. Other owners and saved chats remain intact.",
    parameters: Schema.Struct({ taskId: Schema.String, requestId: Schema.String }),
    success: Schema.Struct({ taskId: Schema.String }),
    failure: Schema.String,
    dependencies,
  }).annotate(Tool.Idempotent, true),
  Tool.make("routing_mode", {
    description: "Read the server Off, Suggest or Auto routing policy.",
    success: Schema.Struct({ mode: Schema.String }),
    failure: Schema.String,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("claim_task", {
    description:
      "Claim this task for the current conversation. Conflicting owners require manual destination selection.",
    parameters: Schema.Struct({ taskId: Schema.String, requestId: Schema.String }),
    success: Schema.Struct({ taskId: Schema.String }),
    failure: Schema.String,
    dependencies,
  }).annotate(Tool.Idempotent, true),
  Tool.make("acknowledge_route", {
    description:
      "Report acceptance, completion or failure as the receiving agent. This records your report separately from server-confirmed delivery.",
    parameters: Schema.Struct({
      requestId: Schema.String,
      kind: Schema.Literals(["accepted", "completed", "failed"]),
    }),
    success: Status,
    failure: Schema.String,
    dependencies,
  }).annotate(Tool.Idempotent, true),
  Tool.make("route_task", {
    description:
      "Propose routing a task to its current owner. Candidate destinations are hints. Return destinationUrl as a clickable Markdown link when present. Server policy and authenticated manual decisions control delivery. Queued does not mean delivered or accepted. Reuse requestId only for identical intent.",
    parameters: RouteInput,
    success: Status,
    failure: Schema.String,
    dependencies,
  }).annotate(Tool.Idempotent, true),
  Tool.make("routing_status", {
    description: "Read separate delivery/execution status for a route involving this conversation.",
    parameters: Schema.Struct({ requestId: Schema.String }),
    success: Status,
    failure: Schema.String,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("list_routes", {
    description: "List routes involving this conversation.",
    success: Schema.Array(Status),
    failure: Schema.String,
    dependencies,
  }).annotate(Tool.Readonly, true),
);
