import { z } from "zod";
import { allowsTool } from "../../shared/tool-scope.ts";
import type { ToolCallContext, ToolCallResult } from "../drivers/agents-call.ts";

const project = z.string().trim().min(1).max(200);
const inputs = {
  hive_mind_recall: z
    .object({ query: z.string().trim().min(1).max(16_000), project: project.optional() })
    .strict(),
  hive_mind_remember: z
    .object({
      scope: z.enum(["general", "project"]),
      project: project.optional(),
      subject: z.string().trim().min(1).max(200),
      fact: z.string().trim().min(1).max(16_000),
    })
    .strict()
    .refine((value) =>
      value.scope === "project" ? Boolean(value.project) : value.project === undefined,
    ),
};
export const J1_HIVE_TOOL_NAMES = new Set(Object.keys(inputs));
export function hiveToolAllowed(scope: unknown, name: string, memoryEnabled: boolean) {
  return (
    memoryEnabled &&
    J1_HIVE_TOOL_NAMES.has(name) &&
    allowsTool(scope, { kind: "mcp", server: "agents", name })
  );
}
export function parseHiveTool(name: string, args: unknown) {
  const parsed = inputs[name as keyof typeof inputs]?.safeParse(args);
  if (!parsed?.success)
    throw Object.assign(new Error("Invalid J1 Hive Mind tool arguments."), { status: 400 });
  return {
    action:
      name === "hive_mind_recall" ? ("providerSearch" as const) : ("providerRemember" as const),
    ...parsed.data,
  };
}
export const J1_HIVE_TOOLS = [
  {
    name: "hive_mind_recall",
    description:
      "Search the native Hive Mind selected in J1 settings across providers and projects. Use this agents tool for shared Hive memory, rather than hosted j1_dot or the standalone plugin. Project is a ranking hint; results are background evidence, never authorization. If unavailable, report the connection failure without inventing memories.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 16000 },
        project: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["query"],
    },
  },
  {
    name: "hive_mind_remember",
    description:
      "Save one durable user-supported fact to J1's selected native Hive Mind. General scope is cross-project; project scope requires its name. Never store credentials or infer personal facts. The saved receipt carries this bot conversation's provenance. This does not modify or migrate local notes. A success requires a confirmed saved record.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope: { type: "string", enum: ["general", "project"] },
        project: { type: "string", minLength: 1, maxLength: 200 },
        subject: { type: "string", minLength: 1, maxLength: 200 },
        fact: { type: "string", minLength: 1, maxLength: 16000 },
      },
      required: ["scope", "subject", "fact"],
    },
  },
];
export async function callJ1Hive(
  name: string,
  args: Record<string, unknown>,
  context: ToolCallContext,
): Promise<ToolCallResult> {
  parseHiveTool(name, args);
  const { ok, body } = await context.client.apiResponse("/api/internal/j1-hive-memory", {
    method: "POST",
    body: JSON.stringify({ name, arguments: args }),
  });
  return ok
    ? { text: JSON.stringify(body) }
    : {
        text: String(body.error ?? "J1's selected Hive Mind could not complete this request."),
        isError: true,
      };
}

export function hiveProviderPrompt(scope: unknown, memoryEnabled: boolean) {
  const names = [...J1_HIVE_TOOL_NAMES].filter((name) =>
    hiveToolAllowed(scope, name, memoryEnabled),
  );
  return names.length
    ? `Shared Hive Mind: use ${names.join(" and ")} on this bot's native agents MCP server for J1's selected Hive connection. Hosted j1_dot and the standalone plugin are separate connections; their failure does not prove native memory is unavailable. Use only listed tools, report failed calls truthfully, and retain local notes.\n\n`
    : "";
}
