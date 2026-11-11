import { z } from "zod";
import type { ToolCallContext, ToolCallResult } from "../drivers/agents-call.ts";
import { allowsTool } from "../../shared/tool-scope.ts";

const endpoint = z
  .object({ environmentId: z.string(), projectId: z.string(), threadId: z.string() })
  .strict();
const identity = z.object({ taskId: z.string(), requestId: z.string() }).strict();
const routeId = z.object({ requestId: z.string() }).strict();
const inputs = {
  list_chat_projects: z.object({}).strict(),
  routing_mode: z.object({}).strict(),
  list_routes: z.object({}).strict(),
  claim_task: identity,
  release_task: identity,
  route_task: identity.extend({ request: z.string(), candidate: endpoint.optional() }).strict(),
  routing_status: routeId,
  acknowledge_route: routeId.extend({ kind: z.enum(["accepted", "completed", "failed"]) }).strict(),
};
export const J1_ROUTING_TOOL_NAMES = new Set(Object.keys(inputs));
export function routingToolAllowed(scope: unknown, operation: string) {
  return (
    J1_ROUTING_TOOL_NAMES.has(operation) &&
    allowsTool(scope, { kind: "mcp", server: "agents", name: operation })
  );
}
const idSchema = { taskId: { type: "string" }, requestId: { type: "string" } };
const candidateSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    environmentId: { type: "string" },
    projectId: { type: "string" },
    threadId: { type: "string" },
  },
  required: ["environmentId", "projectId", "threadId"],
};
const schema = (properties: object, required: string[]) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
export const J1_ROUTING_TOOLS = [
  {
    name: "list_chat_projects",
    description:
      "List actual J1 projects in this environment. Use this native agents tool instead of a separate connected project's list_projects tool. Find an existing destination chat with search_conversations, pass its exact endpoint to route_task, then verify routing_status. Listing does not deliver work or grant permission.",
    inputSchema: schema({}, []),
    annotations: { readOnlyHint: true },
  },
  {
    name: "routing_mode",
    description: "Read the shared J1 Off, Suggest or Auto routing policy before forwarding work.",
    inputSchema: schema({}, []),
  },
  {
    name: "claim_task",
    description:
      "Claim a stable task for this real bot conversation in the shared J1 ownership registry. Reuse requestId for identical retries. Do not claim another chat's work.",
    inputSchema: schema(idSchema, ["taskId", "requestId"]),
  },
  {
    name: "release_task",
    description:
      "Release this conversation's ownership of a shared task, preserving other owners and history.",
    inputSchema: schema(idSchema, ["taskId", "requestId"]),
  },
  {
    name: "route_task",
    description:
      "Propose a durable handoff to the task's existing J1 owner. Candidate endpoints from search_conversations are hints, not authorization. Supply the user's request and provenance. Suggest requires genuine user confirmation; never approve it yourself. queued/admitted is not delivery or acceptance. Use routing_status to check.",
    inputSchema: schema({ ...idSchema, request: { type: "string" }, candidate: candidateSchema }, [
      "taskId",
      "requestId",
      "request",
    ]),
  },
  {
    name: "routing_status",
    description:
      "Read transport, acceptance and completion status for a shared route involving this conversation.",
    inputSchema: schema({ requestId: { type: "string" } }, ["requestId"]),
  },
  {
    name: "list_routes",
    description:
      "List shared routes involving this conversation, including their separate transport and agent-reported states.",
    inputSchema: schema({}, []),
  },
  {
    name: "acknowledge_route",
    description:
      "As the actual receiving conversation, explicitly report accepted, completed or failed. Do not report completion until the requested work is done; this does not manufacture transport delivery.",
    inputSchema: schema(
      {
        requestId: { type: "string" },
        kind: { type: "string", enum: ["accepted", "completed", "failed"] },
      },
      ["requestId", "kind"],
    ),
  },
];
export async function callJ1Routing(
  name: string,
  args: Record<string, unknown>,
  context: ToolCallContext,
): Promise<ToolCallResult> {
  const parsed = inputs[name as keyof typeof inputs]?.safeParse(args);
  if (!parsed?.success) return { text: "Invalid shared routing arguments.", isError: true };
  const { ok, body } = await context.client.apiResponse("/api/internal/j1-routing", {
    method: "POST",
    body: JSON.stringify({ operation: name, arguments: parsed.data }),
  });
  return ok
    ? { text: JSON.stringify(body) }
    : { text: String(body.error ?? "The shared route could not complete."), isError: true };
}
